-- Production pickup-order requests for verified restaurants and food trucks.
-- This slice never stores payment credentials and can only represent payment
-- collected directly by the merchant at pickup. Runtime remains fail-closed
-- until production acceptance explicitly enables the singleton config row.

create table private.pickup_ordering_runtime_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  minimum_lead_minutes integer not null default 20 check (minimum_lead_minutes between 10 and 1440),
  maximum_advance_minutes integer not null default 10080 check (maximum_advance_minutes between 60 and 20160),
  acceptance_timeout_minutes integer not null default 10 check (acceptance_timeout_minutes between 2 and 30),
  terms_version text not null default 'pickup-pay-in-person-v1',
  updated_at timestamptz not null default now(),
  constraint pickup_ordering_runtime_advance check (maximum_advance_minutes > minimum_lead_minutes),
  constraint pickup_ordering_runtime_terms check (char_length(btrim(terms_version)) between 1 and 80)
);

insert into private.pickup_ordering_runtime_config (singleton)
values (true)
on conflict (singleton) do nothing;

create table private.pickup_orders (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  customer_id uuid references auth.users(id) on delete set null,
  business_id uuid not null references public.businesses(id) on delete restrict,
  location_id uuid not null,
  state text not null default 'pending_acceptance' check (
    state in ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled', 'expired')
  ),
  payment_method text not null default 'pay_in_person' check (payment_method = 'pay_in_person'),
  payment_state text not null default 'due_at_pickup' check (payment_state = 'due_at_pickup'),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  item_subtotal_minor integer not null check (item_subtotal_minor between 0 and 100000000),
  requested_pickup_at timestamptz not null,
  acceptance_expires_at timestamptz not null,
  customer_note text,
  terms_version text not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint pickup_orders_location_business_fkey foreign key (location_id, business_id)
    references public.business_locations(id, business_id) on delete restrict,
  constraint pickup_orders_note check (
    customer_note is null
    or (char_length(btrim(customer_note)) between 1 and 240 and private.content_is_professional(customer_note))
  ),
  constraint pickup_orders_acceptance_window check (
    acceptance_expires_at > created_at and acceptance_expires_at < requested_pickup_at
  ),
  constraint pickup_orders_completion check (
    (state = 'completed' and completed_at is not null)
    or (state <> 'completed' and completed_at is null)
  )
);

create index pickup_orders_customer_created_idx
  on private.pickup_orders (customer_id, created_at desc) where customer_id is not null;
create index pickup_orders_business_queue_idx
  on private.pickup_orders (business_id, state, requested_pickup_at, created_at);
create index pickup_orders_expiry_idx
  on private.pickup_orders (acceptance_expires_at) where state = 'pending_acceptance';

create table private.pickup_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references private.pickup_orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name text not null,
  quantity smallint not null check (quantity between 1 and 20),
  unit_price_minor integer not null check (unit_price_minor between 0 and 100000000),
  line_subtotal_minor integer not null check (line_subtotal_minor between 0 and 100000000),
  allergen_note text,
  sort_order smallint not null check (sort_order between 0 and 19),
  constraint pickup_order_items_name check (char_length(btrim(name)) between 1 and 120),
  constraint pickup_order_items_allergen check (allergen_note is null or char_length(allergen_note) <= 500),
  constraint pickup_order_items_math check (line_subtotal_minor = unit_price_minor * quantity),
  unique (order_id, sort_order),
  unique (order_id, menu_item_id)
);

create table private.pickup_order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references private.pickup_orders(id) on delete cascade,
  event_version integer not null check (event_version > 0),
  prior_state text,
  current_state text not null,
  actor_type text not null check (actor_type in ('customer', 'merchant', 'system')),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint pickup_order_events_states check (
    (prior_state is null or prior_state in ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled', 'expired'))
    and current_state in ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled', 'expired')
  ),
  unique (order_id, event_version)
);

revoke all privileges on table private.pickup_ordering_runtime_config,
  private.pickup_orders, private.pickup_order_items, private.pickup_order_events
  from public, anon, authenticated, service_role;
grant select, update on table private.pickup_ordering_runtime_config to service_role;

create or replace function private.pickup_order_json(target_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'order_public_id', target.public_id,
    'business_id', target.business_id,
    'business_name', (select business.name from public.businesses business where business.id = target.business_id),
    'location_id', target.location_id,
    'location', (select jsonb_build_object(
      'label', location.label,
      'address', location.address_line,
      'city', location.city,
      'region', location.region,
      'postal_code', location.postal_code
    ) from public.business_locations location where location.id = target.location_id),
    'state', target.state,
    'payment_method', target.payment_method,
    'payment_state', target.payment_state,
    'currency', target.currency,
    'item_subtotal_minor', target.item_subtotal_minor,
    'requested_pickup_at', target.requested_pickup_at,
    'acceptance_expires_at', target.acceptance_expires_at,
    'customer_note', target.customer_note,
    'terms_version', target.terms_version,
    'version', target.version,
    'created_at', target.created_at,
    'updated_at', target.updated_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'menu_item_id', item.menu_item_id,
        'name', item.name,
        'quantity', item.quantity,
        'unit_price_minor', item.unit_price_minor,
        'line_subtotal_minor', item.line_subtotal_minor,
        'allergen_note', item.allergen_note
      ) order by item.sort_order)
      from private.pickup_order_items item
      where item.order_id = target.id
    ), '[]'::jsonb)
  )
  from private.pickup_orders target
  where target.id = target_order_id;
$$;

revoke all on function private.pickup_order_json(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_pay_in_person_pickup_menu(target_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  config private.pickup_ordering_runtime_config%rowtype;
  target_business record;
  result jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if target_business_id is null then
    raise exception using errcode = '22023', message = 'INVALID_BUSINESS_ID';
  end if;
  select * into config from private.pickup_ordering_runtime_config where singleton;
  if not found or not config.enabled then
    raise exception using errcode = '55000', message = 'PICKUP_ORDERING_NOT_AVAILABLE';
  end if;
  select business.id, business.name, business.kind, business.verification
  into target_business
  from public.businesses business
  join public.business_pickup_ordering_preferences preference
    on preference.business_id = business.id and preference.opted_in
  where business.id = target_business_id
    and business.kind in ('restaurant', 'food_truck')
    and business.verification = 'verified'
    and preference.accepted_payment_options = array['pay_in_person']::text[];
  if not found or not private.is_business_publicly_eligible(target_business_id) then
    raise exception using errcode = '55000', message = 'PICKUP_ORDERING_NOT_AVAILABLE';
  end if;

  select jsonb_build_object(
    'business_id', target_business.id,
    'business_name', target_business.name,
    'customer_ordering_enabled', true,
    'payment_method', 'pay_in_person',
    'payment_label', 'Pay in person',
    'minimum_lead_minutes', config.minimum_lead_minutes,
    'maximum_advance_minutes', config.maximum_advance_minutes,
    'terms_version', config.terms_version,
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', location.id,
        'label', location.label,
        'address', location.address_line,
        'city', location.city,
        'region', location.region,
        'postal_code', location.postal_code
      ) order by location.is_primary desc, location.label, location.id)
      from public.business_locations location
      where location.business_id = target_business_id
        and location.publication_state = 'published'
        and location.public_address
        and not location.is_approximate
        and location.address_line is not null
    ), '[]'::jsonb),
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', section.id,
        'name', section.name,
        'items', section.items
      ) order by section.sort_order, section.id)
      from (
        select menu_section.id, menu_section.name, menu_section.sort_order,
          jsonb_agg(jsonb_build_object(
            'id', menu_item.id,
            'name', menu_item.name,
            'description', menu_item.description,
            'price_minor', menu_item.price_minor,
            'currency', menu_item.currency,
            'dietary_tags', menu_item.dietary_tags,
            'allergen_note', menu_item.allergen_note
          ) order by menu_item.sort_order, menu_item.id) as items
        from public.menu_sections menu_section
        join public.menu_items menu_item on menu_item.section_id = menu_section.id
        where menu_section.business_id = target_business_id
          and menu_section.is_published
          and menu_item.is_published
          and menu_item.availability = 'available'
        group by menu_section.id, menu_section.name, menu_section.sort_order
      ) section
    ), '[]'::jsonb)
  ) into result;
  if jsonb_array_length(result -> 'locations') = 0
    or jsonb_array_length(result -> 'sections') = 0
  then
    raise exception using errcode = '55000', message = 'PICKUP_ORDERING_NOT_AVAILABLE';
  end if;
  if octet_length(result::text) > 262144 then
    raise exception using errcode = '22003', message = 'PICKUP_MENU_TOO_LARGE';
  end if;
  return result;
end;
$$;

create or replace function public.get_my_pay_in_person_pickup_orders(result_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if result_limit is null or result_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_RESULT_LIMIT';
  end if;
  select coalesce(jsonb_agg(private.pickup_order_json(selected.id)
    order by selected.created_at desc, selected.id desc), '[]'::jsonb)
  into result
  from (
    select target.id, target.created_at
    from private.pickup_orders target
    where target.customer_id = actor
    order by target.created_at desc, target.id desc
    limit result_limit
  ) selected;
  return result;
end;
$$;

create or replace function public.get_business_pay_in_person_pickup_orders(
  target_business_id uuid,
  result_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if target_business_id is null
    or not private.is_business_member(
      target_business_id, actor, array['owner', 'manager', 'staff']::public.member_role[]
    )
  then
    raise exception using errcode = '42501', message = 'BUSINESS_MEMBERSHIP_REQUIRED';
  end if;
  if result_limit is null or result_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_RESULT_LIMIT';
  end if;
  select coalesce(jsonb_agg(private.pickup_order_json(selected.id)
    order by selected.requested_pickup_at, selected.created_at, selected.id), '[]'::jsonb)
  into result
  from (
    select target.id, target.requested_pickup_at, target.created_at
    from private.pickup_orders target
    where target.business_id = target_business_id
      and target.state in ('pending_acceptance', 'accepted', 'preparing', 'ready')
    order by target.requested_pickup_at, target.created_at, target.id
    limit result_limit
  ) selected;
  return result;
end;
$$;

create or replace function public.cancel_pay_in_person_pickup_order(
  target_order_public_id uuid,
  expected_version integer,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  key_hash text;
  request_hash text;
  prior_response jsonb;
  target private.pickup_orders%rowtype;
  response jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if target_order_public_id is null or expected_version is null or expected_version < 1 then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_CANCEL';
  end if;
  perform private.consume_rate_limit(actor, 'cancel_pay_in_person_pickup_order', 30, 3600);
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'order_public_id', target_order_public_id,
    'expected_version', expected_version
  ));
  prior_response := private.order_idempotent_response(
    actor, 'cancel_pay_in_person_pickup_order', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;

  select * into target
  from private.pickup_orders target_order
  where target_order.public_id = target_order_public_id
  for update;
  if not found or target.customer_id is distinct from actor then
    raise exception using errcode = 'P0002', message = 'PICKUP_ORDER_NOT_FOUND';
  end if;
  if target.version <> expected_version then
    raise exception using errcode = '40001', message = 'PICKUP_ORDER_VERSION_CONFLICT';
  end if;
  if target.state not in ('pending_acceptance', 'accepted')
    or target.requested_pickup_at <= now() + interval '10 minutes'
  then
    raise exception using errcode = '55000', message = 'PICKUP_ORDER_NOT_CANCELLABLE';
  end if;
  update private.pickup_orders target_order
  set state = 'cancelled', version = target_order.version + 1, updated_at = now()
  where target_order.id = target.id;
  insert into private.pickup_order_events (
    order_id, event_version, prior_state, current_state, actor_type, actor_id
  ) values (
    target.id, target.version + 1, target.state, 'cancelled', 'customer', actor
  );
  response := private.pickup_order_json(target.id);
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'cancel_pay_in_person_pickup_order', key_hash, request_hash, response);
  perform private.write_audit_event(
    actor, target.business_id, 'pickup_order.cancelled', 'pickup_order',
    target.public_id::text, '{}'::jsonb
  );
  return response;
end;
$$;

create or replace function public.transition_pay_in_person_pickup_order(
  target_order_public_id uuid,
  expected_version integer,
  next_state text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  key_hash text;
  request_hash text;
  prior_response jsonb;
  target private.pickup_orders%rowtype;
  response jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if target_order_public_id is null or expected_version is null or expected_version < 1
    or next_state is null or next_state not in ('accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled')
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_TRANSITION';
  end if;
  perform private.consume_rate_limit(actor, 'transition_pay_in_person_pickup_order', 120, 3600);
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'order_public_id', target_order_public_id,
    'expected_version', expected_version,
    'next_state', next_state
  ));
  prior_response := private.order_idempotent_response(
    actor, 'transition_pay_in_person_pickup_order', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;

  select * into target
  from private.pickup_orders target_order
  where target_order.public_id = target_order_public_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'PICKUP_ORDER_NOT_FOUND';
  end if;
  perform 1 from public.businesses business where business.id = target.business_id for update;
  if not private.is_business_member(
    target.business_id, actor, array['owner', 'manager', 'staff']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'BUSINESS_MEMBERSHIP_REQUIRED';
  end if;
  select * into target
  from private.pickup_orders target_order
  where target_order.id = target.id
  for update;
  if target.version <> expected_version then
    raise exception using errcode = '40001', message = 'PICKUP_ORDER_VERSION_CONFLICT';
  end if;
  if target.state = 'pending_acceptance' and target.acceptance_expires_at <= now() then
    raise exception using errcode = '55000', message = 'PICKUP_ORDER_ACCEPTANCE_EXPIRED';
  end if;
  if not (
    (target.state = 'pending_acceptance' and next_state in ('accepted', 'rejected'))
    or (target.state = 'accepted' and next_state in ('preparing', 'cancelled'))
    or (target.state = 'preparing' and next_state in ('ready', 'cancelled'))
    or (target.state = 'ready' and next_state in ('completed', 'cancelled'))
  ) then
    raise exception using errcode = '55000', message = 'PICKUP_ORDER_TRANSITION_INVALID';
  end if;
  update private.pickup_orders target_order
  set state = next_state,
      version = target_order.version + 1,
      updated_at = now(),
      completed_at = case when next_state = 'completed' then now() else null end
  where target_order.id = target.id;
  insert into private.pickup_order_events (
    order_id, event_version, prior_state, current_state, actor_type, actor_id
  ) values (
    target.id, target.version + 1, target.state, next_state, 'merchant', actor
  );
  response := private.pickup_order_json(target.id);
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'transition_pay_in_person_pickup_order', key_hash, request_hash, response);
  perform private.write_audit_event(
    actor, target.business_id, 'pickup_order.' || next_state, 'pickup_order',
    target.public_id::text, jsonb_build_object('prior_state', target.state)
  );
  return response;
end;
$$;

create or replace function public.expire_pay_in_person_pickup_orders(batch_size integer default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  expired_count integer := 0;
  target record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if batch_size is null or batch_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'INVALID_BATCH_SIZE';
  end if;
  for target in
    select target_order.id, target_order.version
    from private.pickup_orders target_order
    where target_order.state = 'pending_acceptance'
      and target_order.acceptance_expires_at <= now()
    order by target_order.acceptance_expires_at, target_order.id
    for update skip locked
    limit batch_size
  loop
    update private.pickup_orders target_order
    set state = 'expired', version = target_order.version + 1, updated_at = now()
    where target_order.id = target.id;
    insert into private.pickup_order_events (
      order_id, event_version, prior_state, current_state, actor_type
    ) values (target.id, target.version + 1, 'pending_acceptance', 'expired', 'system');
    expired_count := expired_count + 1;
  end loop;
  return jsonb_build_object(
    'expired', expired_count,
    'more_work', exists (
      select 1 from private.pickup_orders target_order
      where target_order.state = 'pending_acceptance'
        and target_order.acceptance_expires_at <= now()
    )
  );
end;
$$;

revoke all on function public.get_pay_in_person_pickup_menu(uuid),
  public.create_pay_in_person_pickup_order(uuid, uuid, timestamptz, jsonb, text, text),
  public.get_my_pay_in_person_pickup_orders(integer),
  public.get_business_pay_in_person_pickup_orders(uuid, integer),
  public.cancel_pay_in_person_pickup_order(uuid, integer, text),
  public.transition_pay_in_person_pickup_order(uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_pay_in_person_pickup_menu(uuid),
  public.create_pay_in_person_pickup_order(uuid, uuid, timestamptz, jsonb, text, text),
  public.get_my_pay_in_person_pickup_orders(integer),
  public.get_business_pay_in_person_pickup_orders(uuid, integer),
  public.cancel_pay_in_person_pickup_order(uuid, integer, text),
  public.transition_pay_in_person_pickup_order(uuid, integer, text, text)
  to authenticated;

revoke all on function public.expire_pay_in_person_pickup_orders(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.expire_pay_in_person_pickup_orders(integer) to service_role;

-- Surface the independent runtime state to merchant settings without ever
-- treating a merchant opt-in as authority to enable the service.
create or replace function public.get_business_pickup_ordering_preferences(
  target_business_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_kind public.business_kind;
  target_state public.business_state;
  target_verification public.verification_state;
  target_preference public.business_pickup_ordering_preferences%rowtype;
  category_eligible boolean := false;
  runtime_enabled boolean := false;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;
  perform private.require_aal2();
  if target_business_id is null or not private.is_business_member(
    target_business_id, actor, array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;
  select business.kind, business.state, business.verification
  into target_kind, target_state, target_verification
  from public.businesses business
  where business.id = target_business_id;
  if target_kind is null then
    raise exception using errcode = 'P0002', message = 'Business not found';
  end if;
  category_eligible := target_kind in ('restaurant', 'food_truck');
  select preference.* into target_preference
  from public.business_pickup_ordering_preferences preference
  where preference.business_id = target_business_id;
  select config.enabled into runtime_enabled
  from private.pickup_ordering_runtime_config config
  where config.singleton;
  runtime_enabled := coalesce(runtime_enabled, false)
    and category_eligible
    and target_state = 'published'
    and target_verification = 'verified'
    and coalesce(target_preference.opted_in, false);

  return jsonb_build_object(
    'business_id', target_business_id,
    'eligible_kind', category_eligible,
    'merchant_opted_in', category_eligible and coalesce(target_preference.opted_in, false),
    'accepted_payment_options', case
      when category_eligible and coalesce(target_preference.opted_in, false)
        then to_jsonb(target_preference.accepted_payment_options)
      else '[]'::jsonb
    end,
    'customer_ordering_enabled', runtime_enabled,
    'online_payment_processing_enabled', false,
    'listing_state', target_state::text,
    'verification_state', target_verification::text,
    'payment_options', jsonb_build_array(
      jsonb_build_object(
        'kind', 'pay_in_person', 'label', 'Pay in person',
        'configuration_allowed', true, 'charge_enabled', false,
        'unavailable_reason', null
      ),
      jsonb_build_object(
        'kind', 'card', 'label', 'Card in Spottr',
        'configuration_allowed', false, 'charge_enabled', false,
        'unavailable_reason',
          'Unavailable until provider, KYB, PCI/SCA, webhook, refund, and domain-entitlement controls are approved.'
      ),
      jsonb_build_object(
        'kind', 'apple_pay', 'label', 'Apple Pay in Spottr',
        'configuration_allowed', false, 'charge_enabled', false,
        'unavailable_reason',
          'Unavailable until provider, KYB, PCI/SCA, webhook, refund, and domain-entitlement controls are approved.'
      )
    )
  );
end;
$$;

revoke all on function public.get_business_pickup_ordering_preferences(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_pickup_ordering_preferences(uuid)
  to authenticated;

-- Add the customer's commercial request history to portability before Auth
-- deletion anonymizes customer_id. No merchant user IDs or payment secrets are
-- present in this data.
do $pickup_export_core$
begin
  if pg_catalog.to_regprocedure('public.account_export_payload_pre_pickup(uuid)') is null then
    alter function public.account_export_payload(uuid)
      rename to account_export_payload_pre_pickup;
  end if;
end;
$pickup_export_core$;

create or replace function public.account_export_payload(target_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.account_export_payload_pre_pickup(target_user_id)
    || jsonb_build_object(
      'pay_in_person_pickup_orders', coalesce((
        select jsonb_agg(private.pickup_order_json(target.id)
          order by target.created_at, target.id)
        from private.pickup_orders target
        where target.customer_id = target_user_id
      ), '[]'::jsonb)
    );
$$;

revoke all on function public.account_export_payload_pre_pickup(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.account_export_payload_pre_pickup(uuid) to service_role;
revoke all on function public.account_export_payload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.account_export_payload(uuid) to service_role;

create or replace function public.create_pay_in_person_pickup_order(
  target_business_id uuid,
  target_location_id uuid,
  target_requested_pickup_at timestamptz,
  target_lines jsonb,
  target_customer_note text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  config private.pickup_ordering_runtime_config%rowtype;
  key_hash text;
  request_hash text;
  prior_response jsonb;
  target_order_id uuid := gen_random_uuid();
  target_line jsonb;
  target_item record;
  target_item_id uuid;
  target_quantity integer;
  target_currency text;
  target_subtotal bigint := 0;
  target_line_subtotal bigint;
  target_sort integer := 0;
  seen_item_ids uuid[] := '{}'::uuid[];
  snapshot_lines jsonb[] := '{}'::jsonb[];
  response jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if target_business_id is null or target_location_id is null
    or target_requested_pickup_at is null
    or jsonb_typeof(target_lines) <> 'array'
    or jsonb_array_length(target_lines) not between 1 and 20
    or (target_customer_note is not null and (
      char_length(btrim(target_customer_note)) not between 1 and 240
      or not private.content_is_professional(target_customer_note)
    ))
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_REQUEST';
  end if;
  perform private.consume_rate_limit(actor, 'create_pay_in_person_pickup_order', 20, 3600);
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'location_id', target_location_id,
    'requested_pickup_at', target_requested_pickup_at,
    'lines', target_lines,
    'customer_note', nullif(btrim(target_customer_note), '')
  ));
  prior_response := private.order_idempotent_response(
    actor, 'create_pay_in_person_pickup_order', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;

  select * into config
  from private.pickup_ordering_runtime_config
  where singleton
  for update;
  if not found or not config.enabled then
    raise exception using errcode = '55000', message = 'PICKUP_ORDERING_NOT_AVAILABLE';
  end if;
  perform 1 from public.businesses business
  where business.id = target_business_id
    and business.kind in ('restaurant', 'food_truck')
    and business.verification = 'verified'
  for update;
  if not found
    or not private.is_business_publicly_eligible(target_business_id)
    or not exists (
      select 1 from public.business_pickup_ordering_preferences preference
      where preference.business_id = target_business_id
        and preference.opted_in
        and preference.accepted_payment_options = array['pay_in_person']::text[]
    )
  then
    raise exception using errcode = '55000', message = 'PICKUP_ORDERING_NOT_AVAILABLE';
  end if;
  if not exists (
    select 1 from public.business_locations location
    where location.id = target_location_id
      and location.business_id = target_business_id
      and location.publication_state = 'published'
      and location.public_address
      and not location.is_approximate
      and location.address_line is not null
  ) then
    raise exception using errcode = '55000', message = 'PICKUP_LOCATION_UNAVAILABLE';
  end if;
  if target_requested_pickup_at < now() + make_interval(mins => config.minimum_lead_minutes)
    or target_requested_pickup_at > now() + make_interval(mins => config.maximum_advance_minutes)
  then
    raise exception using errcode = '22023', message = 'PICKUP_TIME_UNAVAILABLE';
  end if;
  if (
    select count(*) from private.pickup_orders existing
    where existing.customer_id = actor
      and existing.state in ('pending_acceptance', 'accepted', 'preparing', 'ready')
  ) >= 10 then
    raise exception using errcode = '54000', message = 'ACTIVE_PICKUP_ORDER_LIMIT';
  end if;

  for target_line in select value from jsonb_array_elements(target_lines) loop
    if jsonb_typeof(target_line) <> 'object'
      or target_line - array['menu_item_id', 'quantity'] <> '{}'::jsonb
      or not target_line ? 'menu_item_id'
      or not target_line ? 'quantity'
    then
      raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_LINE';
    end if;
    begin
      target_item_id := (target_line ->> 'menu_item_id')::uuid;
      target_quantity := (target_line ->> 'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_LINE';
    end;
    if target_quantity not between 1 and 20 or target_item_id = any(seen_item_ids) then
      raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_LINE';
    end if;
    select item.id, item.name, item.price_minor, item.currency, item.allergen_note
    into target_item
    from public.menu_items item
    join public.menu_sections section on section.id = item.section_id
    where item.id = target_item_id
      and section.business_id = target_business_id
      and section.is_published
      and item.is_published
      and item.availability = 'available';
    if not found then
      raise exception using errcode = '55000', message = 'PICKUP_ITEM_UNAVAILABLE';
    end if;
    if target_currency is null then target_currency := target_item.currency; end if;
    if target_item.currency <> target_currency then
      raise exception using errcode = '55000', message = 'PICKUP_MENU_CURRENCY_MISMATCH';
    end if;
    target_line_subtotal := target_item.price_minor::bigint * target_quantity;
    target_subtotal := target_subtotal + target_line_subtotal;
    if target_subtotal > 100000000 then
      raise exception using errcode = '22003', message = 'PICKUP_ORDER_TOTAL_TOO_LARGE';
    end if;
    seen_item_ids := array_append(seen_item_ids, target_item_id);
    snapshot_lines := array_append(snapshot_lines, jsonb_build_object(
      'menu_item_id', target_item.id,
      'name', target_item.name,
      'quantity', target_quantity,
      'unit_price_minor', target_item.price_minor,
      'line_subtotal_minor', target_line_subtotal,
      'allergen_note', target_item.allergen_note,
      'sort_order', target_sort
    ));
    target_sort := target_sort + 1;
  end loop;

  insert into private.pickup_orders (
    id, customer_id, business_id, location_id, currency,
    item_subtotal_minor, requested_pickup_at, acceptance_expires_at,
    customer_note, terms_version
  ) values (
    target_order_id, actor, target_business_id, target_location_id, target_currency,
    target_subtotal, target_requested_pickup_at,
    least(
      now() + make_interval(mins => config.acceptance_timeout_minutes),
      target_requested_pickup_at - interval '1 second'
    ),
    nullif(btrim(target_customer_note), ''), config.terms_version
  );
  insert into private.pickup_order_items (
    order_id, menu_item_id, name, quantity, unit_price_minor,
    line_subtotal_minor, allergen_note, sort_order
  )
  select target_order_id, item.menu_item_id, item.name, item.quantity,
    item.unit_price_minor, item.line_subtotal_minor, item.allergen_note, item.sort_order
  from jsonb_to_recordset(to_jsonb(snapshot_lines)) as item(
    menu_item_id uuid,
    name text,
    quantity smallint,
    unit_price_minor integer,
    line_subtotal_minor integer,
    allergen_note text,
    sort_order smallint
  );
  insert into private.pickup_order_events (
    order_id, event_version, prior_state, current_state, actor_type, actor_id
  ) values (
    target_order_id, 1, null, 'pending_acceptance', 'customer', actor
  );
  response := private.pickup_order_json(target_order_id);
  if response is null or octet_length(response::text) > 16384 then
    raise exception using errcode = '22003', message = 'PICKUP_ORDER_RESPONSE_TOO_LARGE';
  end if;
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'create_pay_in_person_pickup_order', key_hash, request_hash, response);
  perform private.write_audit_event(
    actor, target_business_id, 'pickup_order.created', 'pickup_order',
    (response ->> 'order_public_id'),
    jsonb_build_object(
      'payment_method', 'pay_in_person',
      'requested_pickup_at', target_requested_pickup_at
    )
  );
  return response;
end;
$$;
