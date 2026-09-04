-- Spottr ordering phase O1: employee-only, zero-money menu -> quote -> place
-- -> cancel workflow.  This is deliberately a shadow-only vertical slice.
-- There is no payment state other than `not_required`, and no public/live
-- ordering path is enabled by this migration.

create table if not exists public.pickup_order_quotes (
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
  payment_state text not null default 'not_required' check (payment_state = 'not_required'),
  pickup_starts_at timestamptz not null,
  pickup_ends_at timestamptz not null,
  terms_version text not null,
  refund_policy_version text not null,
  version integer not null default 1 check (version = 1),
  snapshot jsonb not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'open'
    check (status in ('open', 'placed', 'expired', 'cancelled')),
  placed_order_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pickup_order_quotes_location_business_fkey foreign key (location_id, business_id)
    references public.business_locations(id, business_id),
  constraint pickup_order_quotes_catalog_business_fkey foreign key (catalog_version_id, business_id)
    references public.order_catalog_versions(id, business_id),
  constraint pickup_order_quotes_capacity_business_fkey foreign key (capacity_slot_id, business_id)
    references public.order_capacity_slots(id, business_id),
  constraint pickup_order_quotes_pickup_window check (pickup_ends_at > pickup_starts_at),
  constraint pickup_order_quotes_expiry check (expires_at > created_at and expires_at <= pickup_starts_at),
  constraint pickup_order_quotes_snapshot_shape check (
    coalesce(jsonb_typeof(snapshot) = 'object', false)
    and coalesce(jsonb_typeof(snapshot -> 'lines') = 'array', false)
    and coalesce(jsonb_array_length(snapshot -> 'lines'), 0) between 1 and 100
  ),
  constraint pickup_order_quotes_zero_money check (shadow_discount_minor = item_subtotal_minor),
  constraint pickup_order_quotes_state_link check (
    (status = 'placed' and placed_order_id is not null)
    or (status in ('open', 'expired', 'cancelled') and placed_order_id is null)
  )
);

create index if not exists pickup_order_quotes_customer_created_idx
  on public.pickup_order_quotes (customer_id, created_at desc);
create index if not exists pickup_order_quotes_expiry_idx
  on public.pickup_order_quotes (status, expires_at);
create index if not exists pickup_order_quotes_business_created_idx
  on public.pickup_order_quotes (business_id, created_at desc);

-- An order can be placed from one quote at most once.  The quote is retained
-- for the receipt/audit trail; it is never deleted as a way to cancel it.
alter table public.orders add column if not exists quote_id uuid;
create unique index if not exists orders_quote_once_idx
  on public.orders (quote_id) where quote_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_quote_id_fkey'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_quote_id_fkey
      foreign key (quote_id) references public.pickup_order_quotes(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'pickup_order_quotes_placed_order_fkey'
      and conrelid = 'public.pickup_order_quotes'::regclass
  ) then
    alter table public.pickup_order_quotes
      add constraint pickup_order_quotes_placed_order_fkey
      foreign key (placed_order_id) references public.orders(id) on delete restrict;
  end if;
end;
$$;

create or replace function private.prevent_pickup_order_quote_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_IMMUTABLE';
  end if;

  -- Status is the only mutable quote field.  The canonical snapshot, all
  -- monetary/binding fields, owner, expiry, and version cannot be rewritten.
  if (to_jsonb(new) - array['status', 'placed_order_id', 'updated_at']) <>
     (to_jsonb(old) - array['status', 'placed_order_id', 'updated_at']) then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_IMMUTABLE';
  end if;
  if old.status <> 'open' or new.status not in ('placed', 'expired', 'cancelled') then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_STATE_INVALID';
  end if;
  if new.status = 'placed' and new.placed_order_id is null then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_ORDER_REQUIRED';
  end if;
  if new.status <> 'placed' and new.placed_order_id is not null then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_ORDER_UNEXPECTED';
  end if;
  return new;
end;
$$;

drop trigger if exists pickup_order_quote_immutable on public.pickup_order_quotes;
create trigger pickup_order_quote_immutable
before update or delete on public.pickup_order_quotes
for each row execute function private.prevent_pickup_order_quote_mutation();

-- The menu projection is safe to call only inside the employee shadow pilot.
-- In particular, it does not turn the existing discovery menu into a public
-- checkout surface and it always advertises payment as unavailable.
create or replace function public.get_shadow_orderable_menu(
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
  settings public.business_order_settings%rowtype;
  catalog public.order_catalog_versions%rowtype;
  result jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'get_shadow_orderable_menu', 240, 3600);

  select * into settings
  from public.business_order_settings target_settings
  where target_settings.business_id = target_business_id;
  if not found then
    raise exception using errcode = '55000', message = 'ORDERING_NOT_AVAILABLE';
  end if;
  if settings.pilot_mode <> 'shadow'
    or not settings.accepting_orders
    or (settings.paused_until is not null and settings.paused_until > now())
  then
    raise exception using errcode = '55000', message = 'ORDERING_NOT_AVAILABLE';
  end if;
  if settings.acceptance_mode <> 'manual' then
    raise exception using errcode = '55000', message = 'SHADOW_MANUAL_ACCEPTANCE_REQUIRED';
  end if;
  if not private.is_business_publicly_eligible(target_business_id) then
    raise exception using errcode = '55000', message = 'BUSINESS_NOT_ELIGIBLE';
  end if;

  select * into catalog
  from public.order_catalog_versions target_catalog
  where target_catalog.business_id = target_business_id
    and target_catalog.state = 'published';
  if not found then
    raise exception using errcode = '55000', message = 'ORDERABLE_CATALOG_REQUIRED';
  end if;

  select jsonb_build_object(
    'business_id', target_business_id,
    'catalog_version_id', catalog.id,
    'catalog_version', catalog.version,
    'currency', catalog.currency,
    'acceptance_mode', settings.acceptance_mode,
    'acceptance_timeout_seconds', settings.acceptance_timeout_seconds,
    'terms_version', settings.terms_version,
    'refund_policy_version', settings.refund_policy_version,
    'quote_ttl_seconds', 300,
    'public_ordering_enabled', false,
    'payment_enabled', false,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_version_id', item.id,
        'stable_item_id', item.stable_item_id,
        'name', item.name,
        'description', item.description,
        'unit_price_minor', item.unit_price_minor,
        'maximum_quantity', item.maximum_quantity,
        'allergen_note', item.allergen_note,
        'sort_order', item.sort_order,
        'option_groups', coalesce((
           select jsonb_agg(jsonb_build_object(
             'option_group_id', option_group.id,
             'stable_group_id', option_group.stable_group_id,
             'name', option_group.name,
             'minimum_selections', option_group.minimum_selections,
             'maximum_selections', least(
               option_group.maximum_selections::bigint,
               (select count(*)
                from public.order_option_versions available_option
                where available_option.option_group_id = option_group.id
                  and available_option.orderable)
             ),
            'sort_order', option_group.sort_order,
            'options', coalesce((
              select jsonb_agg(jsonb_build_object(
                'option_version_id', option_version.id,
                'stable_option_id', option_version.stable_option_id,
                'name', option_version.name,
                'price_delta_minor', option_version.price_delta_minor,
                'sort_order', option_version.sort_order
              ) order by option_version.sort_order, option_version.id)
              from public.order_option_versions option_version
              where option_version.option_group_id = option_group.id
                and option_version.orderable
            ), '[]'::jsonb)
           ) order by option_group.sort_order, option_group.id)
           from public.order_option_groups option_group
           where option_group.item_version_id = item.id
             and exists (
               select 1
               from public.order_option_versions available_option
               where available_option.option_group_id = option_group.id
                 and available_option.orderable
             )
         ), '[]'::jsonb)
      ) order by item.sort_order, item.id)
      from public.order_item_versions item
      where item.catalog_version_id = catalog.id
        and item.orderable
        and not exists (
          select 1
          from public.order_option_groups required_group
          where required_group.item_version_id = item.id
            and required_group.minimum_selections > (
              select count(*)
              from public.order_option_versions available_option
              where available_option.option_group_id = required_group.id
                and available_option.orderable
            )
        )
    ), '[]'::jsonb),
    'pickup_windows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capacity_slot_id', slot.id,
        'location_id', slot.location_id,
        'mobile_stop_id', slot.mobile_stop_id,
        'starts_at', slot.starts_at,
        'ends_at', slot.ends_at,
        'remaining_capacity', greatest(slot.capacity - slot.reserved_count - slot.accepted_count, 0)
      ) order by slot.starts_at, slot.ends_at, slot.id)
      from public.order_capacity_slots slot
      where slot.business_id = target_business_id
        and slot.ends_at > now()
        and slot.starts_at >= now() + make_interval(mins => settings.minimum_lead_minutes)
        and slot.starts_at <= now() + make_interval(mins => settings.maximum_advance_minutes)
        and slot.reserved_count + slot.accepted_count < slot.capacity
        and (slot.mobile_stop_id is null or exists (
          select 1 from public.mobile_stops stop
          where stop.id = slot.mobile_stop_id
            and stop.business_id = target_business_id
            and stop.location_id = slot.location_id
            and stop.state in ('scheduled', 'live')
        ))
    ), '[]'::jsonb)
  ) into result;
  if octet_length(result::text) > 262144 then
    raise exception using errcode = '22003', message = 'ORDER_MENU_TOO_LARGE';
  end if;
  return result;
end;
$$;

create or replace function public.quote_shadow_order(
  target_business_id uuid,
  target_capacity_slot_id uuid,
  target_pickup_starts_at timestamptz,
  target_pickup_ends_at timestamptz,
  target_lines jsonb,
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
  settings public.business_order_settings%rowtype;
  catalog public.order_catalog_versions%rowtype;
  capacity public.order_capacity_slots%rowtype;
  target_quote_id uuid := gen_random_uuid();
  target_quote_public_id uuid := gen_random_uuid();
  line jsonb;
  target_item public.order_item_versions%rowtype;
  target_item_id uuid;
  target_option_ids uuid[];
  target_option_id uuid;
  target_group record;
  target_option record;
  target_quantity integer;
  target_option_total bigint;
  target_line_subtotal bigint;
  target_subtotal bigint := 0;
  target_sort integer := 0;
  seen_item_ids uuid[] := '{}'::uuid[];
  options_json jsonb;
  normalized_line jsonb;
  snapshot_lines jsonb[] := '{}'::jsonb[];
  snapshot jsonb;
  snapshot_hash text;
  quote_expires_at timestamptz;
  response jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'quote_shadow_order', 60, 3600);

  if target_business_id is null or target_capacity_slot_id is null
    or target_pickup_starts_at is null or target_pickup_ends_at is null
    or jsonb_typeof(target_lines) <> 'array'
    or jsonb_array_length(target_lines) not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'INVALID_ORDER_QUOTE_REQUEST';
  end if;
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id,
    'capacity_slot_id', target_capacity_slot_id,
    'pickup_starts_at', target_pickup_starts_at,
    'pickup_ends_at', target_pickup_ends_at,
    'lines', target_lines
  ));
  prior_response := private.order_idempotent_response(
    actor, 'quote_shadow_order', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;

  select * into settings
  from public.business_order_settings target_settings
  where target_settings.business_id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'ORDERING_NOT_AVAILABLE';
  end if;
  if settings.pilot_mode <> 'shadow'
    or not settings.accepting_orders
    or (settings.paused_until is not null and settings.paused_until > now())
  then
    raise exception using errcode = '55000', message = 'ORDERING_NOT_AVAILABLE';
  end if;
  if settings.acceptance_mode <> 'manual' then
    raise exception using errcode = '55000', message = 'SHADOW_MANUAL_ACCEPTANCE_REQUIRED';
  end if;
  if not private.is_business_publicly_eligible(target_business_id) then
    raise exception using errcode = '55000', message = 'BUSINESS_NOT_ELIGIBLE';
  end if;

  select * into capacity
  from public.order_capacity_slots target_capacity
  where target_capacity.id = target_capacity_slot_id
    and target_capacity.business_id = target_business_id
  for update;
  if not found
    or target_pickup_starts_at < capacity.starts_at
    or target_pickup_ends_at > capacity.ends_at
    or target_pickup_ends_at <= target_pickup_starts_at
    or target_pickup_starts_at < now() + make_interval(mins => settings.minimum_lead_minutes)
    or target_pickup_starts_at > now() + make_interval(mins => settings.maximum_advance_minutes)
    or capacity.reserved_count + capacity.accepted_count >= capacity.capacity
  then
    raise exception using errcode = '55000', message = 'PICKUP_CAPACITY_UNAVAILABLE';
  end if;
  if capacity.mobile_stop_id is not null and not exists (
    select 1 from public.mobile_stops stop
    where stop.id = capacity.mobile_stop_id
      and stop.business_id = target_business_id
      and stop.location_id = capacity.location_id
      and stop.state in ('scheduled', 'live')
      and target_pickup_starts_at >= stop.starts_at
      and target_pickup_ends_at <= stop.ends_at
  ) then
    raise exception using errcode = '55000', message = 'MOBILE_STOP_UNAVAILABLE';
  end if;

  -- The first line selects the published catalog; every subsequent line must
  -- be in that exact immutable version.
  line := target_lines -> 0;
  begin
    target_item_id := (line ->> 'item_version_id')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_ORDER_ITEM_ID';
  end;
  select item.* into target_item
  from public.order_item_versions item
  join public.order_catalog_versions target_catalog on target_catalog.id = item.catalog_version_id
  where item.id = target_item_id
    and target_catalog.business_id = target_business_id
    and target_catalog.state = 'published';
  if not found then
    raise exception using errcode = '55000', message = 'ORDERABLE_CATALOG_REQUIRED';
  end if;
  select * into catalog from public.order_catalog_versions target_catalog
  where target_catalog.id = target_item.catalog_version_id;

  for line in select value from jsonb_array_elements(target_lines) loop
    if jsonb_typeof(line) <> 'object'
      or line - array['item_version_id', 'quantity', 'option_version_ids'] <> '{}'::jsonb
      or not line ? 'item_version_id'
      or not line ? 'quantity'
      or not line ? 'option_version_ids'
      or jsonb_typeof(line -> 'option_version_ids') <> 'array'
    then
      raise exception using errcode = '22023', message = 'INVALID_ORDER_LINE';
    end if;
    begin
      target_item_id := (line ->> 'item_version_id')::uuid;
      target_quantity := (line ->> 'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'INVALID_ORDER_LINE';
    end;
    select item.* into target_item
    from public.order_item_versions item
    where item.id = target_item_id
      and item.catalog_version_id = catalog.id
      and item.orderable;
    if not found or target_quantity not between 1 and target_item.maximum_quantity then
      raise exception using errcode = '55000', message = 'ORDER_ITEM_UNAVAILABLE';
    end if;
    if target_item.id = any(seen_item_ids) then
      raise exception using errcode = '22023', message = 'DUPLICATE_ORDER_ITEM';
    end if;
    seen_item_ids := array_append(seen_item_ids, target_item.id);

    begin
      select coalesce(array_agg(value::uuid), '{}'::uuid[])
      into target_option_ids
      from jsonb_array_elements_text(line -> 'option_version_ids') as option_value(value);
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'INVALID_ORDER_OPTION_ID';
    end;
    if cardinality(target_option_ids) > 50
      or cardinality(target_option_ids) <> (
        select count(distinct selected.option_id)
        from unnest(target_option_ids) selected(option_id)
      )
    then
      raise exception using errcode = '22023', message = 'INVALID_ORDER_OPTION_SET';
    end if;
    foreach target_option_id in array target_option_ids loop
      select option_version.* into target_option
      from public.order_option_versions option_version
      join public.order_option_groups option_group
        on option_group.id = option_version.option_group_id
      where option_version.id = target_option_id
        and option_group.item_version_id = target_item.id
        and option_version.orderable;
      if not found then
        raise exception using errcode = '55000', message = 'ORDER_OPTION_UNAVAILABLE';
      end if;
    end loop;
    for target_group in
      select option_group.id, option_group.minimum_selections, option_group.maximum_selections
      from public.order_option_groups option_group
      where option_group.item_version_id = target_item.id
    loop
      if (
        select count(*)
        from public.order_option_versions option_version
        where option_version.option_group_id = target_group.id
          and option_version.id = any(target_option_ids)
          and option_version.orderable
      ) not between target_group.minimum_selections and target_group.maximum_selections then
        raise exception using errcode = '55000', message = 'ORDER_OPTION_SELECTIONS_INVALID';
      end if;
    end loop;

    select coalesce(sum(option_version.price_delta_minor), 0)
    into target_option_total
    from public.order_option_versions option_version
    where option_version.id = any(target_option_ids);
    if target_option_total > 100000000 then
      raise exception using errcode = '22003', message = 'ORDER_OPTION_TOTAL_TOO_LARGE';
    end if;
    target_line_subtotal :=
      (target_item.unit_price_minor::bigint + target_option_total) * target_quantity;
    target_subtotal := target_subtotal + target_line_subtotal;
    if target_line_subtotal > 1000000000 or target_subtotal > 1000000000 then
      raise exception using errcode = '22003', message = 'ORDER_TOTAL_TOO_LARGE';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'option_version_id', selected_option.id,
      'stable_option_id', selected_option.stable_option_id,
      'group_name', selected_option.group_name,
      'name', selected_option.option_name,
      'option_name', selected_option.option_name,
      'price_delta_minor', selected_option.price_delta_minor,
      'sort_order', selected_option.option_position
    ) order by selected_option.option_position), '[]'::jsonb)
    into options_json
    from (
      select option_version.id, option_version.stable_option_id,
        option_group.name as group_name, option_version.name as option_name,
        option_version.price_delta_minor,
        row_number() over (
          order by option_group.sort_order, option_group.id,
            option_version.sort_order, option_version.id
        ) - 1 as option_position
      from public.order_option_versions option_version
      join public.order_option_groups option_group
        on option_group.id = option_version.option_group_id
      where option_version.id = any(target_option_ids)
        and option_group.item_version_id = target_item.id
    ) selected_option;

    normalized_line := jsonb_build_object(
      'item_version_id', target_item.id,
      'stable_item_id', target_item.stable_item_id,
      'name', target_item.name,
      'description', target_item.description,
      'quantity', target_quantity,
      'unit_price_minor', target_item.unit_price_minor,
      'base_unit_price_minor', target_item.unit_price_minor,
      'unit_total_minor', target_item.unit_price_minor + target_option_total,
      'option_unit_total_minor', target_option_total,
      'line_subtotal_minor', target_line_subtotal,
      'allergen_note', target_item.allergen_note,
      'sort_order', target_sort,
      'options', options_json
    );
    snapshot_lines := array_append(snapshot_lines, normalized_line);
    target_sort := target_sort + 1;
  end loop;

  quote_expires_at := least(
    now() + interval '5 minutes',
    target_pickup_starts_at - interval '1 second'
  );
  snapshot := jsonb_build_object(
    'business_id', target_business_id,
    'location_id', capacity.location_id,
    'mobile_stop_id', capacity.mobile_stop_id,
    'catalog_version_id', catalog.id,
    'capacity_slot_id', capacity.id,
    'currency', catalog.currency,
    'pickup_starts_at', target_pickup_starts_at,
    'pickup_ends_at', target_pickup_ends_at,
    'lines', to_jsonb(snapshot_lines),
    'item_subtotal_minor', target_subtotal,
    'shadow_discount_minor', target_subtotal,
    'tax_minor', 0,
    'tip_minor', 0,
    'fee_minor', 0,
    'total_minor', 0,
    'payment_state', 'not_required',
    'terms_version', settings.terms_version,
    'refund_policy_version', settings.refund_policy_version,
    'acceptance_mode', settings.acceptance_mode,
    'acceptance_timeout_seconds', settings.acceptance_timeout_seconds
  );
  snapshot_hash := private.json_request_hash(snapshot);
  insert into public.pickup_order_quotes (
    id, public_id, customer_id, business_id, location_id, mobile_stop_id,
    catalog_version_id, capacity_slot_id, currency, item_subtotal_minor,
    shadow_discount_minor, tax_minor, tip_minor, fee_minor, total_minor,
    payment_state, pickup_starts_at, pickup_ends_at, terms_version,
    refund_policy_version, snapshot, snapshot_hash, expires_at
  ) values (
    target_quote_id, target_quote_public_id, actor, target_business_id,
    capacity.location_id, capacity.mobile_stop_id, catalog.id, capacity.id,
    catalog.currency, target_subtotal, target_subtotal, 0, 0, 0, 0,
    'not_required', target_pickup_starts_at, target_pickup_ends_at,
    settings.terms_version, settings.refund_policy_version, snapshot,
    snapshot_hash, quote_expires_at
  );
  response := jsonb_build_object(
    'quote_public_id', target_quote_public_id,
    'version', 1,
    'quote_version', 1,
    'status', 'open',
    'business_id', target_business_id,
    'location_id', capacity.location_id,
    'mobile_stop_id', capacity.mobile_stop_id,
    'capacity_slot_id', capacity.id,
    'catalog_version_id', catalog.id,
    'currency', catalog.currency,
    'pickup_starts_at', target_pickup_starts_at,
    'pickup_ends_at', target_pickup_ends_at,
    'expires_at', quote_expires_at,
    'terms_version', settings.terms_version,
    'refund_policy_version', settings.refund_policy_version,
    'acceptance_mode', snapshot ->> 'acceptance_mode',
    'item_subtotal_minor', target_subtotal,
    'shadow_discount_minor', target_subtotal,
    'tax_minor', 0,
    'tip_minor', 0,
    'fee_minor', 0,
    'total_minor', 0,
    'payment_state', 'not_required',
    'is_shadow', true,
    'lines', snapshot -> 'lines'
  );
  if octet_length(response::text) > 16384 then
    raise exception using errcode = '22003', message = 'ORDER_QUOTE_TOO_LARGE';
  end if;
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'quote_shadow_order', key_hash, request_hash, response);
  perform private.write_audit_event(
    actor, target_business_id, 'shadow_order.quote_created', 'order_quote',
    target_quote_public_id::text, jsonb_build_object('expires_at', quote_expires_at)
  );
  return response;
end;
$$;

create or replace function public.place_shadow_order(
  target_quote_public_id uuid,
  expected_quote_version integer,
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
  settings public.business_order_settings%rowtype;
  catalog public.order_catalog_versions%rowtype;
  capacity public.order_capacity_slots%rowtype;
  target_quote public.pickup_order_quotes%rowtype;
  target_order_id uuid := gen_random_uuid();
  target_order_public_id uuid := gen_random_uuid();
  target_quote_acceptance_mode text;
  target_quote_acceptance_timeout_seconds integer;
  target_acceptance_expires_at timestamptz;
  line jsonb;
  option_line jsonb;
  target_item record;
  target_option record;
  target_order_item_id uuid;
  target_sort integer := 0;
  target_subtotal bigint := 0;
  response jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'place_shadow_order', 30, 3600);
  if target_quote_public_id is null or expected_quote_version < 1 then
    raise exception using errcode = '22023', message = 'INVALID_ORDER_QUOTE_REQUEST';
  end if;
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'quote_public_id', target_quote_public_id,
    'expected_quote_version', expected_quote_version
  ));
  prior_response := private.order_idempotent_response(
    actor, 'place_shadow_order', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;

  select * into target_quote
  from public.pickup_order_quotes quote
  where quote.public_id = target_quote_public_id
    and quote.customer_id = actor
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ORDER_QUOTE_NOT_FOUND';
  end if;
  if target_quote.version <> expected_quote_version then
    raise exception using errcode = '40001', message = 'ORDER_QUOTE_VERSION_CONFLICT';
  end if;
  if target_quote.status = 'open' and target_quote.expires_at <= now() then
    -- This call aborts, so the state is intentionally left unchanged here;
    -- the restartable service-only expiry worker persists `expired` without
    -- coupling quote rejection to the caller's transaction.
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_EXPIRED';
  end if;
  if target_quote.status <> 'open' then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_NOT_OPEN';
  end if;
  if private.json_request_hash(target_quote.snapshot) <> target_quote.snapshot_hash then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
  end if;
  target_quote_acceptance_mode := target_quote.snapshot ->> 'acceptance_mode';
  target_quote_acceptance_timeout_seconds :=
    (target_quote.snapshot ->> 'acceptance_timeout_seconds')::integer;
  if target_quote_acceptance_mode is distinct from 'manual'
    or target_quote_acceptance_timeout_seconds is null
    or target_quote_acceptance_timeout_seconds not between 60 and 1800
  then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
  end if;

  select * into settings
  from public.business_order_settings target_settings
  where target_settings.business_id = target_quote.business_id
  for update;
  if not found
    or settings.pilot_mode <> 'shadow'
    or not settings.accepting_orders
    or (settings.paused_until is not null and settings.paused_until > now())
  then
    raise exception using errcode = '55000', message = 'ORDERING_NOT_AVAILABLE';
  end if;
  if settings.acceptance_mode <> target_quote_acceptance_mode
    or settings.acceptance_timeout_seconds <> target_quote_acceptance_timeout_seconds
    or settings.terms_version <> target_quote.terms_version
    or settings.refund_policy_version <> target_quote.refund_policy_version
  then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_POLICY_CHANGED';
  end if;
  if settings.acceptance_mode <> 'manual' then
    raise exception using errcode = '55000', message = 'SHADOW_MANUAL_ACCEPTANCE_REQUIRED';
  end if;
  if not private.is_business_publicly_eligible(target_quote.business_id) then
    raise exception using errcode = '55000', message = 'BUSINESS_NOT_ELIGIBLE';
  end if;
  select * into catalog
  from public.order_catalog_versions target_catalog
  where target_catalog.id = target_quote.catalog_version_id
    and target_catalog.business_id = target_quote.business_id
    and target_catalog.state = 'published';
  if not found then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_CATALOG_CHANGED';
  end if;
  select * into capacity
  from public.order_capacity_slots target_capacity
  where target_capacity.id = target_quote.capacity_slot_id
    and target_capacity.business_id = target_quote.business_id
  for update;
  if not found
    or target_quote.pickup_starts_at < capacity.starts_at
    or target_quote.pickup_ends_at > capacity.ends_at
    or capacity.reserved_count + capacity.accepted_count >= capacity.capacity
  then
    raise exception using errcode = '55000', message = 'PICKUP_CAPACITY_UNAVAILABLE';
  end if;
  if capacity.mobile_stop_id is distinct from target_quote.mobile_stop_id
    or capacity.location_id <> target_quote.location_id
  then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_BINDING_INVALID';
  end if;
  if target_quote.mobile_stop_id is not null and not exists (
    select 1
    from public.mobile_stops stop
    where stop.id = target_quote.mobile_stop_id
      and stop.business_id = target_quote.business_id
      and stop.location_id = target_quote.location_id
      and stop.state in ('scheduled', 'live')
      and target_quote.pickup_starts_at >= stop.starts_at
      and target_quote.pickup_ends_at <= stop.ends_at
  ) then
    raise exception using errcode = '55000', message = 'MOBILE_STOP_UNAVAILABLE';
  end if;

  target_acceptance_expires_at := least(
    now() + make_interval(secs => target_quote_acceptance_timeout_seconds),
    target_quote.pickup_starts_at
  );
  -- The parent row must exist before immutable receipt children are inserted;
  -- all rows remain in this transaction and roll back together on any failure.
  insert into public.orders (
    id, public_id, customer_id, business_id, location_id, mobile_stop_id,
    catalog_version_id, capacity_slot_id, quote_id, currency,
    item_subtotal_minor, shadow_discount_minor, tax_minor, tip_minor, fee_minor,
    total_minor, pickup_starts_at, pickup_ends_at, acceptance_expires_at,
    terms_version, refund_policy_version
  ) values (
    target_order_id, target_order_public_id, actor, target_quote.business_id,
    target_quote.location_id, target_quote.mobile_stop_id,
    target_quote.catalog_version_id, target_quote.capacity_slot_id,
    target_quote.id, target_quote.currency, target_quote.item_subtotal_minor,
    target_quote.shadow_discount_minor, 0, 0, 0, 0,
    target_quote.pickup_starts_at, target_quote.pickup_ends_at,
    target_acceptance_expires_at,
    target_quote.terms_version, target_quote.refund_policy_version
  );

  for line in select value from jsonb_array_elements(target_quote.snapshot -> 'lines') loop
    select item.id, item.stable_item_id, item.name, item.allergen_note
    into target_item
    from public.order_item_versions item
    where item.id = (line ->> 'item_version_id')::uuid
      and item.catalog_version_id = target_quote.catalog_version_id;
    if not found then
      raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
    end if;
    if target_item.stable_item_id <> (line ->> 'stable_item_id')::uuid
      or target_item.name <> (line ->> 'name')
    then
      raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
    end if;
    target_subtotal := target_subtotal + (line ->> 'line_subtotal_minor')::bigint;
    insert into public.order_items (
      order_id, item_version_id, stable_item_id, name, quantity,
      unit_price_minor, option_unit_total_minor, line_subtotal_minor,
      allergen_note, sort_order
    ) values (
      target_order_id, target_item.id, target_item.stable_item_id,
      line ->> 'name', (line ->> 'quantity')::smallint,
      (line ->> 'unit_price_minor')::integer,
      (line ->> 'option_unit_total_minor')::integer,
      (line ->> 'line_subtotal_minor')::integer,
      line ->> 'allergen_note', target_sort
    ) returning id into target_order_item_id;
    for option_line in select value from jsonb_array_elements(line -> 'options') loop
      select option_version.id, option_version.stable_option_id,
        option_group.name as group_name, option_version.name as option_name,
        option_version.price_delta_minor
      into target_option
      from public.order_option_versions option_version
      join public.order_option_groups option_group
        on option_group.id = option_version.option_group_id
      where option_version.id = (option_line ->> 'option_version_id')::uuid
        and option_group.item_version_id = target_item.id;
      if not found then
        raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
      end if;
      if target_option.stable_option_id <> (option_line ->> 'stable_option_id')::uuid
        or target_option.group_name <> (option_line ->> 'group_name')
        or target_option.option_name <> (option_line ->> 'option_name')
        or target_option.price_delta_minor <> (option_line ->> 'price_delta_minor')::integer
      then
        raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
      end if;
      insert into public.order_item_options (
        order_item_id, option_version_id, stable_option_id, group_name,
        option_name, price_delta_minor, sort_order
      ) values (
        target_order_item_id, target_option.id, target_option.stable_option_id,
        target_option.group_name, target_option.option_name,
        target_option.price_delta_minor,
        (option_line ->> 'sort_order')::smallint
      );
    end loop;
    target_sort := target_sort + 1;
  end loop;
  if target_subtotal <> target_quote.item_subtotal_minor
    or target_quote.shadow_discount_minor <> target_subtotal
    or target_quote.tax_minor <> 0 or target_quote.tip_minor <> 0
    or target_quote.fee_minor <> 0 or target_quote.total_minor <> 0
    or target_quote.payment_state <> 'not_required'
  then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_ZERO_MONEY_INVALID';
  end if;

  update public.order_capacity_slots
  set reserved_count = reserved_count + 1,
      version = version + 1,
      updated_at = now()
  where id = capacity.id
    and reserved_count + accepted_count < capacity.capacity;
  if not found then
    raise exception using errcode = '55000', message = 'PICKUP_CAPACITY_UNAVAILABLE';
  end if;
  insert into public.order_events (
    order_id, event_version, prior_state, current_state, actor_type, actor_id
  ) values (
    target_order_id, 1, null, 'pending_acceptance', 'customer', actor
  );
  update public.pickup_order_quotes
  set status = 'placed', placed_order_id = target_order_id, updated_at = now()
  where id = target_quote.id and status = 'open';
  if not found then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_STATE_CONFLICT';
  end if;

  response := jsonb_build_object(
    'quote_public_id', target_quote.public_id,
    'quote_version', target_quote.version,
    'order_public_id', target_order_public_id,
    'version', 1,
    'fulfillment_state', 'pending_acceptance',
    'payment_state', 'not_required',
    'is_shadow', true,
    'business_id', target_quote.business_id,
    'location_id', target_quote.location_id,
    'mobile_stop_id', target_quote.mobile_stop_id,
    'acceptance_mode', target_quote_acceptance_mode,
    'currency', target_quote.currency,
    'item_subtotal_minor', target_quote.item_subtotal_minor,
    'shadow_discount_minor', target_quote.shadow_discount_minor,
    'tax_minor', 0, 'tip_minor', 0, 'fee_minor', 0, 'total_minor', 0,
    'pickup_starts_at', target_quote.pickup_starts_at,
    'pickup_ends_at', target_quote.pickup_ends_at,
    'acceptance_expires_at', target_acceptance_expires_at,
    'terms_version', target_quote.terms_version,
    'refund_policy_version', target_quote.refund_policy_version,
    'lines', target_quote.snapshot -> 'lines'
  );
  if octet_length(response::text) > 16384 then
    raise exception using errcode = '22003', message = 'ORDER_RECEIPT_TOO_LARGE';
  end if;
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'place_shadow_order', key_hash, request_hash, response);
  perform private.write_audit_event(
    actor, target_quote.business_id, 'shadow_order.placed', 'order',
    target_order_public_id::text, jsonb_build_object('quote_public_id', target_quote.public_id)
  );
  return response;
end;
$$;

create or replace function public.cancel_shadow_order(
  target_order_public_id uuid,
  expected_version integer,
  reason_code text,
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
  target_order public.orders%rowtype;
  target_quote public.pickup_order_quotes%rowtype;
  target_acceptance_mode text;
  target_lines jsonb := '[]'::jsonb;
  response jsonb;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  if not private.is_platform_staff(actor) then
    raise exception using errcode = '42501', message = 'STAFF_REQUIRED';
  end if;
  perform private.require_aal2();
  perform private.consume_rate_limit(actor, 'cancel_shadow_order', 30, 3600);
  if target_order_public_id is null or expected_version < 1
    or reason_code is distinct from 'customer_cancelled_before_acceptance'
  then
    raise exception using errcode = '22023', message = 'INVALID_ORDER_CANCELLATION';
  end if;
  key_hash := private.idempotency_key_hash(idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'order_public_id', target_order_public_id,
    'expected_version', expected_version,
    'reason_code', btrim(reason_code)
  ));
  prior_response := private.order_idempotent_response(
    actor, 'cancel_shadow_order', key_hash, request_hash
  );
  if prior_response is not null then return prior_response; end if;

  select * into target_order
  from public.orders order_row
  where order_row.public_id = target_order_public_id
    and order_row.customer_id = actor
  for update;
  if not found or not target_order.is_shadow then
    raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
  end if;
  if target_order.quote_id is null then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_REQUIRED';
  end if;
  select * into target_quote
  from public.pickup_order_quotes quote
  where quote.id = target_order.quote_id;
  if not found then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_NOT_FOUND';
  end if;
  if target_quote.placed_order_id <> target_order.id
    or target_quote.status <> 'placed'
    or private.json_request_hash(target_quote.snapshot) <> target_quote.snapshot_hash
  then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
  end if;
  target_lines := target_quote.snapshot -> 'lines';
  target_acceptance_mode := target_quote.snapshot ->> 'acceptance_mode';
  if target_acceptance_mode is distinct from 'manual'
    or (target_quote.snapshot ->> 'acceptance_timeout_seconds')::integer is null
    or (target_quote.snapshot ->> 'acceptance_timeout_seconds')::integer not between 60 and 1800
  then
    raise exception using errcode = '55000', message = 'ORDER_QUOTE_SNAPSHOT_INVALID';
  end if;
  if target_order.version <> expected_version then
    raise exception using errcode = '40001', message = 'ORDER_VERSION_CONFLICT';
  end if;
  if target_order.fulfillment_state <> 'pending_acceptance' then
    raise exception using errcode = '55000', message = 'ORDER_NOT_CANCELLABLE';
  end if;

  update public.order_capacity_slots
  set reserved_count = reserved_count - 1,
      version = version + 1,
      updated_at = now()
  where id = target_order.capacity_slot_id and reserved_count > 0;
  if not found then
    raise exception using errcode = '55000', message = 'CAPACITY_RESERVATION_MISSING';
  end if;
  update public.orders
  set fulfillment_state = 'cancelled', version = version + 1, updated_at = now()
  where id = target_order.id;
  insert into public.order_events (
    order_id, event_version, prior_state, current_state, actor_type, actor_id, reason_code
  ) values (
    target_order.id, expected_version + 1, target_order.fulfillment_state,
    'cancelled', 'customer', actor, btrim(reason_code)
  );
  response := jsonb_build_object(
    'quote_public_id', case when target_order.quote_id is null then null else target_quote.public_id end,
    'quote_version', case when target_order.quote_id is null then null else target_quote.version end,
    'order_public_id', target_order.public_id,
    'version', expected_version + 1,
    'fulfillment_state', 'cancelled',
    'payment_state', 'not_required',
    'business_id', target_order.business_id,
    'location_id', target_order.location_id,
    'mobile_stop_id', target_order.mobile_stop_id,
    'acceptance_mode', target_acceptance_mode,
    'currency', target_order.currency,
    'item_subtotal_minor', target_order.item_subtotal_minor,
    'shadow_discount_minor', target_order.shadow_discount_minor,
    'tax_minor', target_order.tax_minor,
    'tip_minor', target_order.tip_minor,
    'fee_minor', target_order.fee_minor,
    'total_minor', 0,
    'pickup_starts_at', target_order.pickup_starts_at,
    'pickup_ends_at', target_order.pickup_ends_at,
    'acceptance_expires_at', target_order.acceptance_expires_at,
    'terms_version', target_order.terms_version,
    'refund_policy_version', target_order.refund_policy_version,
    'lines', target_lines,
    'is_shadow', true
  );
  if octet_length(response::text) > 16384 then
    raise exception using errcode = '22003', message = 'ORDER_RECEIPT_TOO_LARGE';
  end if;
  insert into private.order_rpc_idempotency (actor_id, action, key_hash, request_hash, response)
  values (actor, 'cancel_shadow_order', key_hash, request_hash, response);
  perform private.write_audit_event(
    actor, target_order.business_id, 'shadow_order.cancelled', 'order',
    target_order.public_id::text, jsonb_build_object('reason_code', btrim(reason_code))
  );
  return response;
end;
$$;

-- Quote expiry is service-only and does not consume/release capacity because a
-- quote never reserves capacity.  It is restartable and safe under concurrent
-- workers through SKIP LOCKED.
create or replace function private.expire_shadow_order_quotes(batch_limit integer default 200)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  expired_quote public.pickup_order_quotes%rowtype;
  expired_count integer := 0;
begin
  if batch_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_BATCH_LIMIT';
  end if;
  for expired_quote in
    select quote.*
    from public.pickup_order_quotes quote
    where quote.status = 'open' and quote.expires_at <= now()
    order by quote.expires_at, quote.id
    for update skip locked
    limit batch_limit
  loop
    update public.pickup_order_quotes
    set status = 'expired', updated_at = now()
    where id = expired_quote.id and status = 'open';
    if found then
      perform private.write_audit_event(
        null, expired_quote.business_id, 'shadow_order.quote_expired', 'order_quote',
        expired_quote.public_id::text, '{}'::jsonb
      );
      expired_count := expired_count + 1;
    end if;
  end loop;
  return expired_count;
end;
$$;

-- Bounded maintenance entrypoint.  The private worker remains unavailable to
-- clients; this wrapper is service-role-only and serializes overlapping runs.
create or replace function public.expire_shadow_order_quotes(batch_limit integer default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bounded_limit integer := coalesce(batch_limit, 200);
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
    pg_catalog.hashtextextended('spottr:shadow-order-quote-expiry', 0)
  ) then
    return pg_catalog.jsonb_build_object(
      'expired', 0,
      'more_work', true,
      'skipped', true
    );
  end if;
  expired_count := private.expire_shadow_order_quotes(bounded_limit);
  select exists (
    select 1
    from public.pickup_order_quotes quote
    where quote.status = 'open' and quote.expires_at <= now()
  ) into more_work;
  return pg_catalog.jsonb_build_object(
    'expired', greatest(expired_count, 0),
    'more_work', coalesce(more_work, false),
    'skipped', false
  );
end;
$$;

alter table public.pickup_order_quotes enable row level security;
create policy "quote owners read own shadow quotes" on public.pickup_order_quotes
  for select to authenticated using (
    (customer_id = auth.uid() and private.is_active_user(auth.uid()))
    or private.is_platform_staff(auth.uid())
  );

revoke all on public.pickup_order_quotes from public, anon, authenticated;
-- The client receives narrow RPC projections; no direct quote snapshot reads or
-- writes are granted.  RLS remains enabled for service/admin diagnostics.
revoke all on function public.get_shadow_orderable_menu(uuid) from public, anon, authenticated;
grant execute on function public.get_shadow_orderable_menu(uuid) to authenticated;
revoke all on function public.quote_shadow_order(uuid, uuid, timestamptz, timestamptz, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.quote_shadow_order(uuid, uuid, timestamptz, timestamptz, jsonb, text)
  to authenticated;
revoke all on function public.place_shadow_order(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.place_shadow_order(uuid, integer, text) to authenticated;
revoke all on function public.cancel_shadow_order(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.cancel_shadow_order(uuid, integer, text, text) to authenticated;
revoke all on function private.prevent_pickup_order_quote_mutation() from public, anon, authenticated;
revoke all on function private.expire_shadow_order_quotes(integer) from public, anon, authenticated;
revoke all on function public.expire_shadow_order_quotes(integer)
  from public, anon, authenticated;
grant execute on function public.expire_shadow_order_quotes(integer)
  to service_role;
