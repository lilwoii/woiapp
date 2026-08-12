-- Spottr ordering phase O1: server-authoritative, zero-money shadow orders.
-- This migration intentionally contains no payment-provider integration and
-- cannot create a charge. Shadow creation is restricted to AAL2 platform staff.

create table if not exists public.business_order_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  pilot_mode text not null default 'disabled' check (pilot_mode in ('disabled', 'shadow')),
  accepting_orders boolean not null default false,
  acceptance_mode text not null default 'manual' check (acceptance_mode in ('automatic', 'manual')),
  acceptance_timeout_seconds integer not null default 300 check (acceptance_timeout_seconds between 60 and 1800),
  minimum_lead_minutes integer not null default 15 check (minimum_lead_minutes between 5 and 1440),
  maximum_advance_minutes integer not null default 180 check (maximum_advance_minutes between 15 and 10080),
  default_capacity integer not null default 10 check (default_capacity between 1 and 1000),
  refund_policy_version text not null,
  terms_version text not null,
  paused_until timestamptz,
  pause_reason text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint business_order_settings_versions check (
    char_length(refund_policy_version) between 1 and 80 and char_length(terms_version) between 1 and 80
  ),
  constraint business_order_settings_pause check (
    (paused_until is null and pause_reason is null)
    or (paused_until is not null and pause_reason is not null and char_length(btrim(pause_reason)) between 1 and 240)
  ),
  constraint business_order_settings_advance check (maximum_advance_minutes >= minimum_lead_minutes)
);

create table if not exists public.order_catalog_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  version integer not null check (version between 1 and 2147483647),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  state text not null default 'draft' check (state in ('draft', 'published', 'retired')),
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  constraint order_catalog_publication check (
    (state = 'draft' and published_at is null and published_by is null)
    or (state in ('published', 'retired') and published_at is not null and published_by is not null)
  ),
  unique (business_id, version),
  unique (id, business_id)
);

create unique index if not exists order_catalog_one_published_idx
  on public.order_catalog_versions (business_id) where state = 'published';

create table if not exists public.order_item_versions (
  id uuid primary key default gen_random_uuid(),
  catalog_version_id uuid not null references public.order_catalog_versions(id) on delete cascade,
  stable_item_id uuid not null,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name text not null,
  description text not null default '',
  unit_price_minor integer not null check (unit_price_minor between 0 and 100000000),
  tax_category text not null,
  allergen_note text,
  maximum_quantity smallint not null default 20 check (maximum_quantity between 1 and 100),
  orderable boolean not null default true,
  sort_order integer not null default 0 check (sort_order between -10000 and 10000),
  constraint order_item_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint order_item_description_length check (char_length(description) <= 1000),
  constraint order_item_tax_category_length check (char_length(tax_category) between 1 and 80),
  constraint order_item_allergen_length check (allergen_note is null or char_length(allergen_note) <= 500),
  unique (catalog_version_id, stable_item_id),
  unique (id, catalog_version_id)
);

create table if not exists public.order_option_groups (
  id uuid primary key default gen_random_uuid(),
  item_version_id uuid not null references public.order_item_versions(id) on delete cascade,
  stable_group_id uuid not null,
  name text not null,
  minimum_selections smallint not null default 0 check (minimum_selections between 0 and 50),
  maximum_selections smallint not null default 1 check (maximum_selections between 1 and 50),
  sort_order integer not null default 0 check (sort_order between -10000 and 10000),
  constraint order_option_group_bounds check (maximum_selections >= minimum_selections),
  constraint order_option_group_name_length check (char_length(btrim(name)) between 1 and 80),
  unique (item_version_id, stable_group_id),
  unique (id, item_version_id)
);

create table if not exists public.order_option_versions (
  id uuid primary key default gen_random_uuid(),
  option_group_id uuid not null references public.order_option_groups(id) on delete cascade,
  stable_option_id uuid not null,
  name text not null,
  price_delta_minor integer not null check (price_delta_minor between 0 and 100000000),
  orderable boolean not null default true,
  sort_order integer not null default 0 check (sort_order between -10000 and 10000),
  constraint order_option_name_length check (char_length(btrim(name)) between 1 and 80),
  unique (option_group_id, stable_option_id),
  unique (id, option_group_id)
);

create table if not exists public.order_capacity_slots (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid not null,
  mobile_stop_id uuid references public.mobile_stops(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null check (capacity between 1 and 1000),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_capacity_window check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours'),
  constraint order_capacity_bounds check (reserved_count + accepted_count <= capacity),
  constraint order_capacity_location_business_fkey foreign key (location_id, business_id)
    references public.business_locations(id, business_id) on delete cascade,
  unique nulls not distinct (business_id, location_id, mobile_stop_id, starts_at, ends_at),
  unique (id, business_id)
);

create index if not exists order_capacity_active_idx
  on public.order_capacity_slots (business_id, starts_at, ends_at);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  customer_id uuid not null references auth.users(id) on delete restrict,
  business_id uuid not null references public.businesses(id) on delete restrict,
  location_id uuid not null,
  mobile_stop_id uuid references public.mobile_stops(id) on delete restrict,
  catalog_version_id uuid not null,
  capacity_slot_id uuid not null,
  is_shadow boolean not null default true check (is_shadow),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  item_subtotal_minor integer not null check (item_subtotal_minor between 0 and 1000000000),
  shadow_discount_minor integer not null check (shadow_discount_minor >= 0),
  tax_minor integer not null default 0 check (tax_minor = 0),
  tip_minor integer not null default 0 check (tip_minor = 0),
  fee_minor integer not null default 0 check (fee_minor = 0),
  total_minor integer not null default 0 check (total_minor = 0),
  fulfillment_state text not null default 'pending_acceptance'
    check (fulfillment_state in ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled')),
  payment_state text not null default 'not_required' check (payment_state = 'not_required'),
  pickup_starts_at timestamptz not null,
  pickup_ends_at timestamptz not null,
  acceptance_expires_at timestamptz not null,
  promised_ready_at timestamptz,
  terms_version text not null,
  refund_policy_version text not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint orders_shadow_zero_total check (shadow_discount_minor = item_subtotal_minor),
  constraint orders_pickup_window check (pickup_ends_at > pickup_starts_at),
  constraint orders_acceptance_expiry check (acceptance_expires_at > created_at and acceptance_expires_at <= pickup_starts_at),
  constraint orders_location_business_fkey foreign key (location_id, business_id)
    references public.business_locations(id, business_id),
  constraint orders_catalog_business_fkey foreign key (catalog_version_id, business_id)
    references public.order_catalog_versions(id, business_id),
  constraint orders_capacity_business_fkey foreign key (capacity_slot_id, business_id)
    references public.order_capacity_slots(id, business_id)
);

create index if not exists orders_customer_created_idx on public.orders (customer_id, created_at desc);
create index if not exists orders_business_queue_idx
  on public.orders (business_id, fulfillment_state, pickup_starts_at, created_at);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  item_version_id uuid not null references public.order_item_versions(id) on delete restrict,
  stable_item_id uuid not null,
  name text not null,
  quantity smallint not null check (quantity between 1 and 100),
  unit_price_minor integer not null check (unit_price_minor between 0 and 100000000),
  option_unit_total_minor integer not null default 0 check (option_unit_total_minor between 0 and 100000000),
  line_subtotal_minor integer not null check (line_subtotal_minor between 0 and 1000000000),
  allergen_note text,
  sort_order smallint not null check (sort_order between 0 and 99),
  constraint order_items_snapshot_name check (char_length(btrim(name)) between 1 and 120),
  constraint order_items_snapshot_allergen check (allergen_note is null or char_length(allergen_note) <= 500),
  unique (order_id, sort_order), unique (id, order_id)
);

create table if not exists public.order_item_options (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  option_version_id uuid not null references public.order_option_versions(id) on delete restrict,
  stable_option_id uuid not null,
  group_name text not null,
  option_name text not null,
  price_delta_minor integer not null check (price_delta_minor between 0 and 100000000),
  sort_order smallint not null check (sort_order between 0 and 49),
  constraint order_item_options_names check (
    char_length(btrim(group_name)) between 1 and 80 and char_length(btrim(option_name)) between 1 and 80
  ),
  unique (order_item_id, option_version_id), unique (order_item_id, sort_order)
);

create table if not exists public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  event_version integer not null check (event_version > 0),
  prior_state text,
  current_state text not null,
  actor_type text not null check (actor_type in ('customer', 'merchant', 'staff', 'system')),
  actor_id uuid references auth.users(id) on delete set null,
  reason_code text,
  created_at timestamptz not null default now(),
  constraint order_events_states check (
    prior_state is null or prior_state in ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled')
  ),
  constraint order_events_current_state check (
    current_state in ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled')
  ),
  constraint order_events_reason check (reason_code is null or char_length(reason_code) between 1 and 80),
  unique (order_id, event_version)
);

create index if not exists order_events_order_time_idx on public.order_events (order_id, created_at, id);

create table if not exists private.order_rpc_idempotency (
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  key_hash text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, action, key_hash),
  constraint order_rpc_idempotency_action check (char_length(action) between 1 and 80),
  constraint order_rpc_idempotency_hashes check (key_hash ~ '^[0-9a-f]{64}$' and request_hash ~ '^[0-9a-f]{64}$'),
  constraint order_rpc_idempotency_response_size check (octet_length(response::text) <= 16384)
);

create or replace function private.prevent_published_order_catalog_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.state in ('published', 'retired') then
    raise exception using errcode = '55000', message = 'PUBLISHED_CATALOG_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' and old.state in ('published', 'retired') then
    if not (
      old.state = 'published'
      and new.state = 'retired'
      and (to_jsonb(new) - 'state') = (to_jsonb(old) - 'state')
    ) then
      raise exception using errcode = '55000', message = 'PUBLISHED_CATALOG_IMMUTABLE';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists order_catalog_immutable on public.order_catalog_versions;
create trigger order_catalog_immutable before update or delete on public.order_catalog_versions
for each row execute function private.prevent_published_order_catalog_mutation();

create or replace function private.require_order_catalog_draft()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target_catalog_id uuid;
begin
  if tg_table_name = 'order_item_versions' then
    target_catalog_id := case when tg_op = 'DELETE' then old.catalog_version_id else new.catalog_version_id end;
  elsif tg_table_name = 'order_option_groups' then
    select i.catalog_version_id into target_catalog_id
    from public.order_item_versions i
    where i.id = case when tg_op = 'DELETE' then old.item_version_id else new.item_version_id end;
  elsif tg_table_name = 'order_option_versions' then
    select i.catalog_version_id into target_catalog_id
    from public.order_option_groups g
    join public.order_item_versions i on i.id = g.item_version_id
    where g.id = case when tg_op = 'DELETE' then old.option_group_id else new.option_group_id end;
  else
    raise exception using errcode = '22023', message = 'UNKNOWN_ORDER_CATALOG_TABLE';
  end if;
  if target_catalog_id is null or not exists (
    select 1 from public.order_catalog_versions c
    where c.id = target_catalog_id and c.state = 'draft'
  ) then
    raise exception using errcode = '55000', message = 'PUBLISHED_CATALOG_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists order_item_catalog_draft_only on public.order_item_versions;
create trigger order_item_catalog_draft_only
before insert or update or delete on public.order_item_versions
for each row execute function private.require_order_catalog_draft();
drop trigger if exists order_option_group_catalog_draft_only on public.order_option_groups;
create trigger order_option_group_catalog_draft_only
before insert or update or delete on public.order_option_groups
for each row execute function private.require_order_catalog_draft();
drop trigger if exists order_option_catalog_draft_only on public.order_option_versions;
create trigger order_option_catalog_draft_only
before insert or update or delete on public.order_option_versions
for each row execute function private.require_order_catalog_draft();

create or replace function private.prevent_order_snapshot_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'ORDER_SNAPSHOT_IMMUTABLE';
end;
$$;

drop trigger if exists order_items_immutable on public.order_items;
create trigger order_items_immutable before update or delete on public.order_items
for each row execute function private.prevent_order_snapshot_mutation();
drop trigger if exists order_item_options_immutable on public.order_item_options;
create trigger order_item_options_immutable before update or delete on public.order_item_options
for each row execute function private.prevent_order_snapshot_mutation();
drop trigger if exists order_events_append_only on public.order_events;
create trigger order_events_append_only before update or delete on public.order_events
for each row execute function private.prevent_order_snapshot_mutation();

create or replace function private.order_access_allowed(target_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.orders o where o.id = target_order_id and (
      o.customer_id = auth.uid()
      or private.is_business_member(o.business_id, auth.uid())
      or private.is_platform_staff(auth.uid())
    )
  );
$$;

create or replace function private.order_idempotent_response(
  target_actor_id uuid, target_action text, target_key_hash text, target_request_hash text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare stored private.order_rpc_idempotency%rowtype;
begin
  perform private.lock_idempotency_request(target_actor_id, target_action, target_key_hash);
  select * into stored from private.order_rpc_idempotency i
  where i.actor_id = target_actor_id and i.action = target_action and i.key_hash = target_key_hash;
  if found then
    if stored.request_hash <> target_request_hash then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return stored.response;
  end if;
  return null;
end;
$$;

create or replace function public.create_shadow_order(
  target_business_id uuid, target_location_id uuid, target_mobile_stop_id uuid,
  target_capacity_slot_id uuid, target_pickup_starts_at timestamptz,
  target_pickup_ends_at timestamptz, target_lines jsonb, idempotency_key text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); key_hash text; request_hash text; prior_response jsonb;
  settings public.business_order_settings%rowtype; catalog public.order_catalog_versions%rowtype;
  capacity public.order_capacity_slots%rowtype; target_order_id uuid := gen_random_uuid();
  target_public_id uuid := gen_random_uuid(); line jsonb; target_item public.order_item_versions%rowtype;
  target_quantity integer; target_line_subtotal bigint; target_subtotal bigint := 0;
  target_sort integer := 0; response jsonb;
begin
  if actor is null or not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'create_shadow_order', 20, 3600);
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id, 'location_id', target_location_id,
    'mobile_stop_id', target_mobile_stop_id, 'capacity_slot_id', target_capacity_slot_id,
    'pickup_starts_at', target_pickup_starts_at, 'pickup_ends_at', target_pickup_ends_at,
    'lines', target_lines
  ));
  prior_response := private.order_idempotent_response(actor, 'create_shadow_order', key_hash, request_hash);
  if prior_response is not null then return prior_response; end if;

  select * into settings from public.business_order_settings s
  where s.business_id = target_business_id for update;
  if not found or settings.pilot_mode <> 'shadow' or not settings.accepting_orders
    or (settings.paused_until is not null and settings.paused_until > now()) then
    raise exception using errcode = '55000', message = 'ORDERING_NOT_AVAILABLE';
  end if;
  if not private.is_business_publicly_eligible(target_business_id) then
    raise exception using errcode = '55000', message = 'BUSINESS_NOT_ELIGIBLE';
  end if;
  select * into catalog from public.order_catalog_versions c
  where c.business_id = target_business_id and c.state = 'published';
  if not found then raise exception using errcode = '55000', message = 'ORDERABLE_CATALOG_REQUIRED'; end if;

  select * into capacity from public.order_capacity_slots slot
  where slot.id = target_capacity_slot_id and slot.business_id = target_business_id
    and slot.location_id = target_location_id
    and slot.mobile_stop_id is not distinct from target_mobile_stop_id for update;
  if not found or target_pickup_starts_at < capacity.starts_at or target_pickup_ends_at > capacity.ends_at
    or target_pickup_ends_at <= target_pickup_starts_at
    or target_pickup_starts_at < now() + make_interval(mins => settings.minimum_lead_minutes)
    or target_pickup_starts_at > now() + make_interval(mins => settings.maximum_advance_minutes)
    or capacity.reserved_count + capacity.accepted_count >= capacity.capacity then
    raise exception using errcode = '55000', message = 'PICKUP_CAPACITY_UNAVAILABLE';
  end if;
  if target_mobile_stop_id is not null and not exists (
    select 1 from public.mobile_stops ms where ms.id = target_mobile_stop_id
      and ms.business_id = target_business_id and ms.location_id = target_location_id
      and ms.state in ('scheduled', 'live') and target_pickup_starts_at >= ms.starts_at
      and target_pickup_ends_at <= ms.ends_at
  ) then raise exception using errcode = '55000', message = 'MOBILE_STOP_UNAVAILABLE'; end if;
  if jsonb_typeof(target_lines) <> 'array' or jsonb_array_length(target_lines) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_ORDER_LINES';
  end if;

  insert into public.orders (
    id, public_id, customer_id, business_id, location_id, mobile_stop_id, catalog_version_id,
    capacity_slot_id, currency, item_subtotal_minor, shadow_discount_minor, pickup_starts_at,
    pickup_ends_at, acceptance_expires_at, terms_version, refund_policy_version
  ) values (
    target_order_id, target_public_id, actor, target_business_id, target_location_id,
    target_mobile_stop_id, catalog.id, capacity.id, catalog.currency, 0, 0,
    target_pickup_starts_at, target_pickup_ends_at,
    least(now() + make_interval(secs => settings.acceptance_timeout_seconds), target_pickup_starts_at),
    settings.terms_version, settings.refund_policy_version
  );
  for line in select value from jsonb_array_elements(target_lines) loop
    if jsonb_typeof(line) <> 'object' or line - array['item_version_id', 'quantity'] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'INVALID_ORDER_LINE';
    end if;
    begin target_quantity := (line ->> 'quantity')::integer;
    exception when others then raise exception using errcode = '22023', message = 'INVALID_ORDER_QUANTITY'; end;
    begin
      select * into target_item from public.order_item_versions item
      where item.id = (line ->> 'item_version_id')::uuid
        and item.catalog_version_id = catalog.id and item.orderable;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'INVALID_ORDER_ITEM_ID';
    end;
    if not found or target_quantity not between 1 and target_item.maximum_quantity then
      raise exception using errcode = '55000', message = 'ORDER_ITEM_UNAVAILABLE';
    end if;
    if exists (select 1 from public.order_items existing
      where existing.order_id = target_order_id and existing.item_version_id = target_item.id) then
      raise exception using errcode = '22023', message = 'DUPLICATE_ORDER_ITEM';
    end if;
    target_line_subtotal := target_item.unit_price_minor::bigint * target_quantity;
    target_subtotal := target_subtotal + target_line_subtotal;
    if target_subtotal > 1000000000 then
      raise exception using errcode = '22003', message = 'ORDER_TOTAL_TOO_LARGE';
    end if;
    insert into public.order_items (
      order_id, item_version_id, stable_item_id, name, quantity, unit_price_minor,
      line_subtotal_minor, allergen_note, sort_order
    ) values (
      target_order_id, target_item.id, target_item.stable_item_id, target_item.name,
      target_quantity, target_item.unit_price_minor, target_line_subtotal,
      target_item.allergen_note, target_sort
    );
    target_sort := target_sort + 1;
  end loop;
  update public.orders set item_subtotal_minor = target_subtotal, shadow_discount_minor = target_subtotal
  where id = target_order_id;
  update public.order_capacity_slots set reserved_count = reserved_count + 1,
    version = version + 1, updated_at = now() where id = capacity.id;
  insert into public.order_events (order_id, event_version, prior_state, current_state, actor_type, actor_id)
  values (target_order_id, 1, null, 'pending_acceptance', 'staff', actor);
  response := jsonb_build_object(
    'order_public_id', target_public_id, 'version', 1, 'fulfillment_state', 'pending_acceptance',
    'payment_state', 'not_required', 'is_shadow', true, 'total_minor', 0, 'currency', catalog.currency
  );
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'create_shadow_order', key_hash, request_hash, response);
  perform private.write_audit_event(actor, target_business_id, 'shadow_order.created', 'order',
    target_public_id::text, jsonb_build_object('capacity_slot_id', capacity.id));
  return response;
end;
$$;

create or replace function public.transition_shadow_order(
  target_order_public_id uuid, expected_version integer, next_state text,
  reason_code text, idempotency_key text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); target_order public.orders%rowtype; key_hash text;
  request_hash text; prior_response jsonb; response jsonb;
begin
  if actor is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'transition_shadow_order', 120, 3600);
  if next_state not in ('accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled')
    or expected_version < 1 or (reason_code is not null and char_length(reason_code) not between 1 and 80) then
    raise exception using errcode = '22023', message = 'INVALID_ORDER_TRANSITION';
  end if;
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'order_public_id', target_order_public_id, 'expected_version', expected_version,
    'next_state', next_state, 'reason_code', reason_code
  ));
  prior_response := private.order_idempotent_response(actor, 'transition_shadow_order', key_hash, request_hash);
  if prior_response is not null then return prior_response; end if;
  select * into target_order from public.orders o where o.public_id = target_order_public_id for update;
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
    (target_order.fulfillment_state = 'pending_acceptance' and next_state in ('accepted', 'rejected', 'cancelled'))
    or (target_order.fulfillment_state = 'accepted' and next_state in ('preparing', 'cancelled'))
    or (target_order.fulfillment_state = 'preparing' and next_state in ('ready', 'cancelled'))
    or (target_order.fulfillment_state = 'ready' and next_state in ('completed', 'cancelled'))
  ) then raise exception using errcode = '55000', message = 'ORDER_TRANSITION_NOT_ALLOWED'; end if;
  if next_state in ('rejected', 'cancelled') and reason_code is null then
    raise exception using errcode = '22023', message = 'ORDER_REASON_REQUIRED';
  end if;
  if target_order.fulfillment_state = 'pending_acceptance' and next_state = 'accepted'
    and target_order.acceptance_expires_at <= now() then
    raise exception using errcode = '55000', message = 'ORDER_ACCEPTANCE_EXPIRED';
  end if;
  if target_order.fulfillment_state = 'pending_acceptance' then
    if next_state = 'accepted' then
      update public.order_capacity_slots set reserved_count = reserved_count - 1,
        accepted_count = accepted_count + 1, version = version + 1, updated_at = now()
      where id = target_order.capacity_slot_id and reserved_count > 0;
    else
      update public.order_capacity_slots set reserved_count = reserved_count - 1,
        version = version + 1, updated_at = now()
      where id = target_order.capacity_slot_id and reserved_count > 0;
    end if;
    if not found then raise exception using errcode = '55000', message = 'CAPACITY_RESERVATION_MISSING'; end if;
  elsif next_state in ('completed', 'cancelled') then
    update public.order_capacity_slots set accepted_count = accepted_count - 1,
      version = version + 1, updated_at = now()
    where id = target_order.capacity_slot_id and accepted_count > 0;
    if not found then raise exception using errcode = '55000', message = 'CAPACITY_ACCEPTANCE_MISSING'; end if;
  end if;
  update public.orders set fulfillment_state = next_state, version = version + 1,
    updated_at = now(), completed_at = case when next_state = 'completed' then now() else completed_at end
  where id = target_order.id;
  insert into public.order_events (
    order_id, event_version, prior_state, current_state, actor_type, actor_id, reason_code
  ) values (
    target_order.id, expected_version + 1, target_order.fulfillment_state, next_state, 'merchant', actor, reason_code
  );
  response := jsonb_build_object('order_public_id', target_order.public_id,
    'version', expected_version + 1, 'fulfillment_state', next_state,
    'payment_state', 'not_required', 'is_shadow', true);
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'transition_shadow_order', key_hash, request_hash, response);
  perform private.write_audit_event(actor, target_order.business_id, 'shadow_order.transitioned',
    'order', target_order.public_id::text,
    jsonb_build_object('from', target_order.fulfillment_state, 'to', next_state));
  return response;
end;
$$;

create or replace function public.get_my_order(target_order_public_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'order_public_id', o.public_id, 'business_id', o.business_id, 'location_id', o.location_id,
    'is_shadow', o.is_shadow, 'currency', o.currency, 'item_subtotal_minor', o.item_subtotal_minor,
    'shadow_discount_minor', o.shadow_discount_minor, 'total_minor', o.total_minor,
    'fulfillment_state', o.fulfillment_state, 'payment_state', o.payment_state,
    'pickup_starts_at', o.pickup_starts_at, 'pickup_ends_at', o.pickup_ends_at, 'version', o.version,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'name', oi.name, 'quantity', oi.quantity, 'unit_price_minor', oi.unit_price_minor,
      'line_subtotal_minor', oi.line_subtotal_minor, 'allergen_note', oi.allergen_note
    ) order by oi.sort_order) from public.order_items oi where oi.order_id = o.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'version', oe.event_version, 'state', oe.current_state, 'reason_code', oe.reason_code,
      'created_at', oe.created_at
    ) order by oe.event_version) from public.order_events oe where oe.order_id = o.id), '[]'::jsonb)
  ) from public.orders o where o.public_id = target_order_public_id
    and private.order_access_allowed(o.id);
$$;

create or replace function public.get_business_shadow_order_queue(
  target_business_id uuid,
  result_limit integer default 50
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null or not private.is_business_member(target_business_id, actor) then
    raise exception using errcode = '42501', message = 'BUSINESS_MEMBERSHIP_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'get_business_shadow_order_queue', 240, 3600);
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_public_id', queue.public_id,
    'fulfillment_state', queue.fulfillment_state,
    'payment_state', queue.payment_state,
    'pickup_starts_at', queue.pickup_starts_at,
    'pickup_ends_at', queue.pickup_ends_at,
    'version', queue.version,
    'item_count', queue.item_count,
    'total_minor', queue.total_minor,
    'currency', queue.currency,
    'is_shadow', true
  ) order by queue.pickup_starts_at, queue.created_at, queue.public_id), '[]'::jsonb)
  into result
  from (
    select o.public_id, o.fulfillment_state, o.payment_state, o.pickup_starts_at,
      o.pickup_ends_at, o.version, o.total_minor, o.currency, o.created_at,
      coalesce(sum(oi.quantity), 0)::integer as item_count
    from public.orders o
    left join public.order_items oi on oi.order_id = o.id
    where o.business_id = target_business_id
      and o.is_shadow
      and o.fulfillment_state in ('pending_acceptance', 'accepted', 'preparing', 'ready')
    group by o.id
    order by o.pickup_starts_at, o.created_at, o.public_id
    limit least(greatest(coalesce(result_limit, 50), 1), 100)
  ) queue;
  return result;
end;
$$;

create or replace function private.expire_shadow_orders(batch_limit integer default 100)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  expired_order public.orders%rowtype;
  expired_count integer := 0;
begin
  if batch_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_BATCH_LIMIT';
  end if;
  for expired_order in
    select o.* from public.orders o
    where o.is_shadow
      and o.fulfillment_state = 'pending_acceptance'
      and o.acceptance_expires_at <= now()
    order by o.acceptance_expires_at, o.id
    for update skip locked
    limit batch_limit
  loop
    update public.order_capacity_slots
    set reserved_count = reserved_count - 1,
        version = version + 1,
        updated_at = now()
    where id = expired_order.capacity_slot_id and reserved_count > 0;
    if not found then
      raise exception using errcode = '55000', message = 'CAPACITY_RESERVATION_MISSING';
    end if;
    update public.orders
    set fulfillment_state = 'cancelled', version = version + 1, updated_at = now()
    where id = expired_order.id;
    insert into public.order_events (
      order_id, event_version, prior_state, current_state, actor_type, reason_code
    ) values (
      expired_order.id, expired_order.version + 1, 'pending_acceptance',
      'cancelled', 'system', 'acceptance_timeout'
    );
    perform private.write_audit_event(
      null, expired_order.business_id, 'shadow_order.expired', 'order',
      expired_order.public_id::text, '{}'::jsonb
    );
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end;
$$;

alter table public.business_order_settings enable row level security;
alter table public.order_catalog_versions enable row level security;
alter table public.order_item_versions enable row level security;
alter table public.order_option_groups enable row level security;
alter table public.order_option_versions enable row level security;
alter table public.order_capacity_slots enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_item_options enable row level security;
alter table public.order_events enable row level security;

create policy "members read order settings" on public.business_order_settings
  for select to authenticated using (private.is_business_member(business_id, auth.uid()));
create policy "members read order catalogs" on public.order_catalog_versions
  for select to authenticated using (private.is_business_member(business_id, auth.uid()));
create policy "members read order items" on public.order_item_versions for select to authenticated using (exists (
  select 1 from public.order_catalog_versions c where c.id = catalog_version_id
    and private.is_business_member(c.business_id, auth.uid())
));
create policy "members read order option groups" on public.order_option_groups for select to authenticated using (exists (
  select 1 from public.order_item_versions i join public.order_catalog_versions c on c.id = i.catalog_version_id
  where i.id = item_version_id and private.is_business_member(c.business_id, auth.uid())
));
create policy "members read order options" on public.order_option_versions for select to authenticated using (exists (
  select 1 from public.order_option_groups g join public.order_item_versions i on i.id = g.item_version_id
  join public.order_catalog_versions c on c.id = i.catalog_version_id where g.id = option_group_id
    and private.is_business_member(c.business_id, auth.uid())
));
create policy "members read capacity" on public.order_capacity_slots
  for select to authenticated using (private.is_business_member(business_id, auth.uid()));
create policy "order participants read orders" on public.orders
  for select to authenticated using (private.order_access_allowed(id));
create policy "order participants read items" on public.order_items
  for select to authenticated using (private.order_access_allowed(order_id));
create policy "order participants read options" on public.order_item_options for select to authenticated using (exists (
  select 1 from public.order_items oi where oi.id = order_item_id
    and private.order_access_allowed(oi.order_id)
));
create policy "order participants read events" on public.order_events
  for select to authenticated using (private.order_access_allowed(order_id));

revoke all on public.business_order_settings, public.order_catalog_versions,
  public.order_item_versions, public.order_option_groups, public.order_option_versions,
  public.order_capacity_slots, public.orders, public.order_items,
  public.order_item_options, public.order_events from public, anon, authenticated;
grant select on public.business_order_settings, public.order_catalog_versions,
  public.order_item_versions, public.order_option_groups, public.order_option_versions,
  public.order_capacity_slots, public.orders, public.order_items,
  public.order_item_options, public.order_events to authenticated;
revoke all on function public.create_shadow_order(uuid, uuid, uuid, uuid, timestamptz, timestamptz, jsonb, text) from public;
grant execute on function public.create_shadow_order(uuid, uuid, uuid, uuid, timestamptz, timestamptz, jsonb, text) to authenticated;
revoke all on function public.transition_shadow_order(uuid, integer, text, text, text) from public;
grant execute on function public.transition_shadow_order(uuid, integer, text, text, text) to authenticated;
revoke all on function public.get_my_order(uuid) from public;
grant execute on function public.get_my_order(uuid) to authenticated;
revoke all on function public.get_business_shadow_order_queue(uuid, integer) from public;
grant execute on function public.get_business_shadow_order_queue(uuid, integer) to authenticated;
revoke all on function private.prevent_published_order_catalog_mutation() from public, anon, authenticated;
revoke all on function private.require_order_catalog_draft() from public, anon, authenticated;
revoke all on function private.prevent_order_snapshot_mutation() from public, anon, authenticated;
revoke all on function private.order_access_allowed(uuid) from public, anon, authenticated;
grant execute on function private.order_access_allowed(uuid) to authenticated;
revoke all on function private.order_idempotent_response(uuid, text, text, text) from public, anon, authenticated;
revoke all on function private.expire_shadow_orders(integer) from public, anon, authenticated;
