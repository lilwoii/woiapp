-- Spottr ordering phase O1 hardening.
-- Merchant transition reason codes are server policy, not a client convention.
-- The acceptance-timeout worker is exposed only through a bounded service-role
-- maintenance RPC; customer and merchant clients cannot invoke it.

create or replace function public.transition_shadow_order(
  target_order_public_id uuid,
  expected_version integer,
  next_state text,
  reason_code text,
  idempotency_key text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_order public.orders%rowtype;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  response jsonb;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'transition_shadow_order', 120, 3600);

  -- The reason policy is enforced here at the RPC trust boundary.  Accepted,
  -- preparing, ready, and completed transitions carry no reason; rejected and
  -- cancelled transitions carry their one server-defined merchant reason.
  if target_order_public_id is null
    or next_state is null
    or next_state not in ('accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled')
    or expected_version is null
    or expected_version < 1
    or (reason_code is not null and char_length(reason_code) not between 1 and 80)
    or (next_state in ('accepted', 'preparing', 'ready', 'completed') and reason_code is not null)
    or (
      next_state = 'rejected'
      and reason_code is not null
      and reason_code is distinct from 'merchant_rejected_unavailable'
    )
    or (
      next_state = 'cancelled'
      and reason_code is not null
      and reason_code is distinct from 'merchant_cancelled_unavailable'
    ) then
    raise exception using errcode = '22023', message = 'INVALID_ORDER_TRANSITION';
  end if;

  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'order_public_id', target_order_public_id,
    'expected_version', expected_version,
    'next_state', next_state,
    'reason_code', reason_code
  ));
  prior_response := private.order_idempotent_response(
    actor, 'transition_shadow_order', key_hash, request_hash
  );
  if prior_response is not null then
    return prior_response;
  end if;

  select * into target_order
  from public.orders order_row
  where order_row.public_id = target_order_public_id
  for update;
  if not found or not target_order.is_shadow then
    raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
  end if;
  if not private.is_business_member(target_order.business_id, actor) then
    raise exception using errcode = '42501', message = 'BUSINESS_MEMBERSHIP_REQUIRED';
  end if;
  if target_order.version <> expected_version then
    raise exception using errcode = '40001', message = 'ORDER_VERSION_CONFLICT';
  end if;
  if not (
    (target_order.fulfillment_state = 'pending_acceptance'
      and next_state in ('accepted', 'rejected', 'cancelled'))
    or (target_order.fulfillment_state = 'accepted'
      and next_state in ('preparing', 'cancelled'))
    or (target_order.fulfillment_state = 'preparing'
      and next_state in ('ready', 'cancelled'))
    or (target_order.fulfillment_state = 'ready'
      and next_state in ('completed', 'cancelled'))
  ) then
    raise exception using errcode = '55000', message = 'ORDER_TRANSITION_NOT_ALLOWED';
  end if;
  if next_state in ('rejected', 'cancelled') and reason_code is null then
    raise exception using errcode = '22023', message = 'ORDER_REASON_REQUIRED';
  end if;
  if target_order.fulfillment_state = 'pending_acceptance'
    and next_state = 'accepted'
    and target_order.acceptance_expires_at <= now() then
    raise exception using errcode = '55000', message = 'ORDER_ACCEPTANCE_EXPIRED';
  end if;

  if target_order.fulfillment_state = 'pending_acceptance' then
    if next_state = 'accepted' then
      update public.order_capacity_slots
      set reserved_count = reserved_count - 1,
          accepted_count = accepted_count + 1,
          version = version + 1,
          updated_at = now()
      where id = target_order.capacity_slot_id and reserved_count > 0;
    else
      update public.order_capacity_slots
      set reserved_count = reserved_count - 1,
          version = version + 1,
          updated_at = now()
      where id = target_order.capacity_slot_id and reserved_count > 0;
    end if;
    if not found then
      raise exception using errcode = '55000', message = 'CAPACITY_RESERVATION_MISSING';
    end if;
  elsif next_state in ('completed', 'cancelled') then
    update public.order_capacity_slots
    set accepted_count = accepted_count - 1,
        version = version + 1,
        updated_at = now()
    where id = target_order.capacity_slot_id and accepted_count > 0;
    if not found then
      raise exception using errcode = '55000', message = 'CAPACITY_ACCEPTANCE_MISSING';
    end if;
  end if;

  update public.orders
  set fulfillment_state = next_state,
      version = version + 1,
      updated_at = now(),
      completed_at = case when next_state = 'completed' then now() else completed_at end
  where id = target_order.id;
  insert into public.order_events (
    order_id,
    event_version,
    prior_state,
    current_state,
    actor_type,
    actor_id,
    reason_code
  ) values (
    target_order.id,
    expected_version + 1,
    target_order.fulfillment_state,
    next_state,
    'merchant',
    actor,
    reason_code
  );
  response := jsonb_build_object(
    'order_public_id', target_order.public_id,
    'version', expected_version + 1,
    'fulfillment_state', next_state,
    'payment_state', 'not_required',
    'is_shadow', true
  );
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'transition_shadow_order', key_hash, request_hash, response);
  perform private.write_audit_event(
    actor,
    target_order.business_id,
    'shadow_order.transitioned',
    'order',
    target_order.public_id::text,
    jsonb_build_object('from', target_order.fulfillment_state, 'to', next_state)
  );
  return response;
end;
$$;

-- Keep the existing authenticated merchant surface; the function itself still
-- requires an active member and AAL2 before any order mutation.
revoke all on function public.transition_shadow_order(uuid, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_shadow_order(uuid, integer, text, text, text)
  to authenticated;

-- The private worker already performs the atomic capacity release, order state
-- transition, event append, audit write, and SKIP LOCKED batching.
create or replace function public.expire_shadow_orders(batch_limit integer default 100)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bounded_limit integer := coalesce(batch_limit, 100);
  expired_count integer;
  more_work boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if bounded_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_BATCH_LIMIT';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:shadow-order-expiry', 0)
  ) then
    return pg_catalog.jsonb_build_object(
      'expired', 0,
      'more_work', true,
      'skipped', true
    );
  end if;

  expired_count := private.expire_shadow_orders(bounded_limit);
  select exists (
    select 1
    from public.orders order_row
    where order_row.is_shadow
      and order_row.fulfillment_state = 'pending_acceptance'
      and order_row.acceptance_expires_at <= now()
  ) into more_work;
  return pg_catalog.jsonb_build_object(
    'expired', greatest(coalesce(expired_count, 0), 0),
    'more_work', coalesce(more_work, false),
    'skipped', false
  );
end;
$$;

revoke all on function private.expire_shadow_orders(integer)
  from public, anon, authenticated;
revoke all on function public.expire_shadow_orders(integer)
  from public, anon, authenticated;
grant execute on function public.expire_shadow_orders(integer)
  to service_role;
