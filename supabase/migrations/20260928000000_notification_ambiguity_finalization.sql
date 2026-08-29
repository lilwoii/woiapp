-- Resolve provider ambiguity without ever retrying a send whose outcome is
-- unknown.  A provider HTTP 5xx or an expired sending lease can mean that
-- Expo accepted the message even when Spottr received no ticket.  Unknown
-- deliveries therefore have a fixed two-hour grace window, then become the
-- existing terminal `failed` state. Retry rows at the attempt ceiling and
-- expired pre-send leases are terminalized in the same bounded sweep; active
-- `sending` rows are never touched. The grace window is deliberately not a
-- caller-controlled parameter.

create index if not exists notification_deliveries_unknown_finalize_idx
  on private.notification_deliveries (updated_at, id)
  where state = 'unknown';

create index if not exists notification_deliveries_terminal_finalize_idx
  on private.notification_deliveries (attempts, lease_expires_at, updated_at, id)
  where (state = 'retry' and attempts >= 20)
    or (state = 'leased' and attempts >= 20);

create index if not exists notification_outbox_terminal_finalize_idx
  on private.notification_outbox (attempts, lease_expires_at, updated_at, id)
  where (state in ('pending', 'retry') and attempts >= 20)
    or (state = 'leased' and attempts >= 20);

create index if not exists notification_receipt_checks_finalize_idx
  on private.notification_receipt_checks (expires_at, attempts, updated_at, id)
  where state in ('pending', 'leased', 'retry');

-- Outbox fan-out claims have the same bounded attempt ceiling as delivery
-- claims. Once the ceiling is reached, a pending/retry row or an expired
-- pre-fan-out lease must become terminal so it cannot be selected forever.
-- Active leases remain untouched because their worker may still be in flight.
create or replace function private.finalize_notification_outbox(
  target_batch_size integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  finalized_count integer;
  more_work boolean;
begin
  if target_batch_size is null or target_batch_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid notification outbox finalization batch';
  end if;

  with candidates as materialized (
    select queue.id
    from private.notification_outbox queue
    where (
      queue.state in ('pending', 'retry')
      and queue.attempts >= 20
    ) or (
      queue.state = 'leased'
      and queue.attempts >= 20
      and queue.lease_expires_at <= now()
    )
    order by queue.updated_at, queue.id
    for update of queue skip locked
    limit target_batch_size
  ), finalized as (
    update private.notification_outbox queue set
      state = 'dead',
      lease_token = null,
      lease_expires_at = null,
      last_error_code = 'outbox_max_attempts',
      updated_at = now()
    from candidates
    where queue.id = candidates.id
    returning queue.id
  )
  select count(*) into finalized_count from finalized;

  select exists (
    select 1
    from private.notification_outbox queue
    where (
      queue.state in ('pending', 'retry')
      and queue.attempts >= 20
    ) or (
      queue.state = 'leased'
      and queue.attempts >= 20
      and queue.lease_expires_at <= now()
    )
  ) into more_work;

  return jsonb_build_object(
    'finalized', greatest(coalesce(finalized_count, 0), 0),
    'more_work', coalesce(more_work, false)
  );
end;
$$;

create or replace function private.finalize_unknown_notification_deliveries(
  target_batch_size integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  finalized_count integer;
  more_work boolean;
begin
  if target_batch_size is null or target_batch_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid notification ambiguity finalization batch';
  end if;

  with candidates as materialized (
    select delivery.id
    from private.notification_deliveries delivery
    where (
      delivery.state = 'unknown'
      and delivery.updated_at < now() - interval '2 hours'
    ) or (
      delivery.state = 'retry'
      and delivery.attempts >= 20
    ) or (
      delivery.state = 'leased'
      and delivery.attempts >= 20
      and delivery.lease_expires_at <= now()
    )
    order by delivery.updated_at, delivery.id
    for update of delivery skip locked
    limit target_batch_size
  ), finalized as (
    update private.notification_deliveries delivery set
      state = 'failed',
      lease_token = null,
      lease_expires_at = null,
      last_provider_code = case
        when delivery.state = 'unknown' then 'provider_ambiguity_expired'
        when delivery.state = 'leased' then 'delivery_lease_max_attempts'
        else 'delivery_max_attempts'
      end,
      updated_at = now()
    from candidates
    where delivery.id = candidates.id
    returning delivery.id
  )
  select count(*) into finalized_count from finalized;

  select exists (
    select 1
    from private.notification_deliveries delivery
    where (
      delivery.state = 'unknown'
      and delivery.updated_at < now() - interval '2 hours'
    ) or (
      delivery.state = 'retry'
      and delivery.attempts >= 20
    ) or (
      delivery.state = 'leased'
      and delivery.attempts >= 20
      and delivery.lease_expires_at <= now()
    )
  ) into more_work;

  return jsonb_build_object(
    'finalized', greatest(coalesce(finalized_count, 0), 0),
    'more_work', coalesce(more_work, false)
  );
end;
$$;

-- Receipt expiry and the 20-attempt ceiling are also terminal boundaries.
-- Finalize the receipt row and its accepted/unknown delivery in one
-- transaction so a receipt worker cannot leave an accepted row looking
-- retryable after the receipt window has ended.
create or replace function private.finalize_notification_receipt_expiry(
  target_batch_size integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  finalized_receipt_count integer;
  finalized_delivery_count integer;
  more_work boolean;
begin
  if target_batch_size is null or target_batch_size not between 1 and 250 then
    raise exception using errcode = '22023', message = 'Invalid notification receipt finalization batch';
  end if;

  with candidates as materialized (
    select receipt.id
    from private.notification_receipt_checks receipt
    where receipt.state not in ('complete', 'dead', 'expired')
      and (
        (
          receipt.expires_at <= now()
          and (receipt.state <> 'leased' or receipt.lease_expires_at <= now())
        )
        or (
          receipt.attempts >= 20
          and (
            receipt.state in ('pending', 'retry')
            or (receipt.state = 'leased' and receipt.lease_expires_at <= now())
          )
        )
      )
    order by receipt.expires_at, receipt.attempts, receipt.updated_at, receipt.id
    for update of receipt skip locked
    limit target_batch_size
  ), finalized_receipts as (
    update private.notification_receipt_checks receipt set
      state = case
        when receipt.expires_at <= now() then 'expired'
        else 'dead'
      end,
      lease_token = null,
      lease_expires_at = null,
      last_provider_code = case
        when receipt.expires_at <= now() then 'receipt_expired'
        else 'receipt_max_attempts'
      end,
      updated_at = now()
    from candidates
    where receipt.id = candidates.id
    returning receipt.delivery_id,
      case
        when receipt.expires_at <= now() then 'receipt_expired'
        else 'receipt_max_attempts'
      end as provider_code
  ), finalized_deliveries as (
    update private.notification_deliveries delivery set
      state = 'failed',
      lease_token = null,
      lease_expires_at = null,
      last_provider_code = finalized_receipts.provider_code,
      updated_at = now()
    from finalized_receipts
    where delivery.id = finalized_receipts.delivery_id
      and delivery.state in ('accepted', 'unknown')
    returning delivery.id
  )
  select
    (select count(*) from finalized_receipts),
    (select count(*) from finalized_deliveries)
  into finalized_receipt_count, finalized_delivery_count;

  select exists (
    select 1
    from private.notification_receipt_checks receipt
    where receipt.state not in ('complete', 'dead', 'expired')
      and (
        (
          receipt.expires_at <= now()
          and (receipt.state <> 'leased' or receipt.lease_expires_at <= now())
        )
        or (
          receipt.attempts >= 20
          and (
            receipt.state in ('pending', 'retry')
            or (receipt.state = 'leased' and receipt.lease_expires_at <= now())
          )
        )
      )
  ) into more_work;

  return jsonb_build_object(
    'finalized', greatest(coalesce(finalized_receipt_count, 0), 0),
    'deliveries_finalized', greatest(coalesce(finalized_delivery_count, 0), 0),
    'more_work', coalesce(more_work, false)
  );
end;
$$;

-- Replace the previous receipt claim implementation so its unconditional
-- expiry UPDATE cannot strand an active lease. Keep a lease-free core for the
-- Edge worker, which runs the finalizer once before provider credential
-- validation and then claims without performing a second bounded sweep.

create or replace function private.claim_notification_receipts_core(
  target_worker_id uuid,
  target_batch_size integer default 100,
  target_lease_seconds integer default 60
)
returns table (
  receipt_check_id uuid,
  delivery_id uuid,
  device_id uuid,
  provider_ticket_id text,
  lease_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_worker_id is null or target_batch_size not between 1 and 250
    or target_lease_seconds not between 15 and 300
  then raise exception using errcode = '22023', message = 'Invalid notification receipt claim'; end if;
  if not coalesce((
    select delivery_enabled from private.notification_runtime_settings where singleton
  ), false) then return; end if;

  return query
  with candidates as (
    select receipt.id
    from private.notification_receipt_checks receipt
    join private.notification_deliveries delivery on delivery.id = receipt.delivery_id
    where receipt.expires_at > now()
      and receipt.attempts < 20
      and receipt.available_at <= now()
      and delivery.state in ('accepted', 'unknown')
      and (
        receipt.state in ('pending', 'retry')
        or (receipt.state = 'leased' and receipt.lease_expires_at <= now())
      )
    order by receipt.created_at, receipt.id
    for update of receipt skip locked
    limit target_batch_size
  ), claimed as (
    update private.notification_receipt_checks receipt set
      state = 'leased', attempts = receipt.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => target_lease_seconds),
      updated_at = now()
    from candidates where receipt.id = candidates.id
    returning receipt.*
  )
  select claimed.id, claimed.delivery_id, claimed.device_id,
    claimed.provider_ticket_id, claimed.lease_token
  from claimed order by claimed.created_at, claimed.id;
end;
$$;

create or replace function private.claim_notification_receipts(
  target_worker_id uuid,
  target_batch_size integer default 100,
  target_lease_seconds integer default 60
)
returns table (
  receipt_check_id uuid,
  delivery_id uuid,
  device_id uuid,
  provider_ticket_id text,
  lease_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.finalize_notification_receipt_expiry(target_batch_size);
  return query
  select * from private.claim_notification_receipts_core(
    target_worker_id, target_batch_size, target_lease_seconds
  );
end;
$$;

-- The Edge worker calls this core wrapper only after the pre-provider
-- finalization pass, preventing one request from finalizing two batches.
create or replace function public.claim_notification_receipts_after_finalization_server(
  target_worker_id uuid, target_batch_size integer, target_lease_seconds integer
)
returns table (
  receipt_check_id uuid, delivery_id uuid, device_id uuid,
  provider_ticket_id text, lease_token uuid
)
language sql
volatile
security definer
set search_path = ''
as $$ select * from private.claim_notification_receipts_core(
  target_worker_id, target_batch_size, target_lease_seconds
) $$;

-- Expansion returns the number of delivery rows inserted, which is not a
-- reliable pagination signal when a follower has no active device or a
-- delivery already exists. Resolve the state from the just-expanded outbox
-- rows instead and expose only one bounded boolean to the worker.
create or replace function public.notification_outbox_has_pending_server(
  target_outbox_ids uuid[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_outbox_ids is null
    or cardinality(target_outbox_ids) not between 1 and 100
    or exists (
      select 1 from unnest(target_outbox_ids) item(id) where item.id is null
    )
    or cardinality(target_outbox_ids) <> (
      select count(distinct item.id) from unnest(target_outbox_ids) item(id)
    )
  then
    raise exception using errcode = '22023', message = 'Invalid notification outbox status request';
  end if;

  return exists (
    select 1
    from private.notification_outbox queue
    where queue.id = any(target_outbox_ids)
      and queue.state = 'pending'
  );
end;
$$;

-- The dispatch Edge worker invokes these bounded sweeps before provider
-- validation, so their responses can surface truthful finalization backlogs.
create or replace function public.finalize_notification_outbox_server(
  target_batch_size integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return private.finalize_notification_outbox(target_batch_size);
end;
$$;

create or replace function public.finalize_unknown_notification_deliveries_server(
  target_batch_size integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return private.finalize_unknown_notification_deliveries(target_batch_size);
end;
$$;

create or replace function public.finalize_notification_receipt_expiry_server(
  target_batch_size integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return private.finalize_notification_receipt_expiry(target_batch_size);
end;
$$;

revoke all on function private.finalize_notification_outbox(integer)
  from public, anon, authenticated;
grant execute on function private.finalize_notification_outbox(integer)
  to service_role;
revoke all on function private.finalize_unknown_notification_deliveries(integer)
  from public, anon, authenticated;
grant execute on function private.finalize_unknown_notification_deliveries(integer)
  to service_role;
revoke all on function private.finalize_notification_receipt_expiry(integer)
  from public, anon, authenticated;
grant execute on function private.finalize_notification_receipt_expiry(integer)
  to service_role;

-- Only the guarded current claim function and the lease-free worker core are
-- service-owned; the original function OID remains in place for its existing
-- public server wrapper.
revoke all on function private.claim_notification_receipts_core(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function private.claim_notification_receipts_core(uuid, integer, integer)
  to service_role;
revoke all on function private.claim_notification_receipts(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function private.claim_notification_receipts(uuid, integer, integer)
  to service_role;

revoke all on function public.claim_notification_receipts_server(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_receipts_server(uuid, integer, integer)
  to service_role;
revoke all on function public.claim_notification_receipts_after_finalization_server(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_receipts_after_finalization_server(uuid, integer, integer)
  to service_role;

revoke all on function public.notification_outbox_has_pending_server(uuid[])
  from public, anon, authenticated;
grant execute on function public.notification_outbox_has_pending_server(uuid[])
  to service_role;

revoke all on function public.finalize_notification_outbox_server(integer)
  from public, anon, authenticated;
grant execute on function public.finalize_notification_outbox_server(integer)
  to service_role;
revoke all on function public.finalize_unknown_notification_deliveries_server(integer)
  from public, anon, authenticated;
grant execute on function public.finalize_unknown_notification_deliveries_server(integer)
  to service_role;
revoke all on function public.finalize_notification_receipt_expiry_server(integer)
  from public, anon, authenticated;
grant execute on function public.finalize_notification_receipt_expiry_server(integer)
  to service_role;
