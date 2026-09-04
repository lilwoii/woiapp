-- Production prepaid pickup foundation. Provider-backed checkout remains
-- independently fail-closed in both the database and Edge runtime. Spottr
-- never receives or stores PAN, CVV, or wallet cryptograms.

create table private.prepaid_pickup_runtime_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  provider text not null default 'stripe' check (provider = 'stripe'),
  application_fee_bps integer not null default 1000 check (application_fee_bps between 0 and 3000),
  checkout_expiry_minutes integer not null default 30 check (checkout_expiry_minutes between 30 and 1440),
  terms_version text not null default 'prepaid-pickup-v1',
  refund_policy_version text not null default 'prepaid-pickup-refunds-v1',
  updated_at timestamptz not null default now(),
  constraint prepaid_pickup_versions check (
    char_length(btrim(terms_version)) between 1 and 80
    and char_length(btrim(refund_policy_version)) between 1 and 80
  )
);

insert into private.prepaid_pickup_runtime_config (singleton)
values (true) on conflict (singleton) do nothing;

create table private.merchant_payment_accounts (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_account_id text not null unique,
  country char(2) not null check (country ~ '^[A-Z]{2}$'),
  default_currency char(3),
  details_submitted boolean not null default false,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  accept_prepaid boolean not null default false,
  requirements_due_count integer not null default 0 check (requirements_due_count between 0 and 1000),
  updated_at timestamptz not null default now(),
  constraint merchant_payment_provider_id check (provider_account_id ~ '^acct_[A-Za-z0-9]{12,128}$'),
  constraint merchant_payment_currency check (default_currency is null or default_currency ~ '^[A-Z]{3}$'),
  constraint merchant_payment_acceptance check (
    not accept_prepaid or (details_submitted and charges_enabled and payouts_enabled)
  )
);

create table private.pickup_checkout_drafts (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  customer_id uuid references auth.users(id) on delete set null,
  business_id uuid not null references public.businesses(id) on delete restrict,
  location_id uuid not null,
  state text not null default 'prepared' check (
    state in ('prepared', 'open', 'completed', 'expired', 'failed', 'refund_pending', 'refunded')
  ),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  item_subtotal_minor integer not null check (item_subtotal_minor between 50 and 100000000),
  application_fee_minor integer not null check (application_fee_minor between 0 and 100000000),
  requested_pickup_at timestamptz not null,
  customer_note text,
  terms_version text not null,
  refund_policy_version text not null,
  idempotency_key_hash text not null,
  request_hash text not null,
  provider_checkout_id text unique,
  provider_payment_intent_id text unique,
  order_id uuid unique references private.pickup_orders(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pickup_checkout_location_business_fkey foreign key (location_id, business_id)
    references public.business_locations(id, business_id) on delete restrict,
  constraint pickup_checkout_note check (
    customer_note is null
    or (char_length(btrim(customer_note)) between 1 and 240 and private.content_is_professional(customer_note))
  ),
  constraint pickup_checkout_hashes check (
    idempotency_key_hash ~ '^[0-9a-f]{64}$' and request_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint pickup_checkout_provider_ids check (
    (provider_checkout_id is null or provider_checkout_id ~ '^cs_[A-Za-z0-9_]{12,128}$')
    and (provider_payment_intent_id is null or provider_payment_intent_id ~ '^pi_[A-Za-z0-9]{12,128}$')
  ),
  constraint pickup_checkout_expiry check (expires_at > created_at),
  unique (customer_id, idempotency_key_hash)
);

create index pickup_checkout_customer_idx
  on private.pickup_checkout_drafts (customer_id, created_at desc) where customer_id is not null;
create index pickup_checkout_expiry_idx
  on private.pickup_checkout_drafts (expires_at) where state in ('prepared', 'open');

create table private.pickup_checkout_lines (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null references private.pickup_checkout_drafts(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name text not null,
  quantity smallint not null check (quantity between 1 and 20),
  unit_price_minor integer not null check (unit_price_minor between 0 and 100000000),
  line_subtotal_minor integer not null check (line_subtotal_minor between 0 and 100000000),
  allergen_note text,
  sort_order smallint not null check (sort_order between 0 and 19),
  constraint pickup_checkout_line_name check (char_length(btrim(name)) between 1 and 120),
  constraint pickup_checkout_line_math check (line_subtotal_minor = unit_price_minor * quantity),
  constraint pickup_checkout_line_allergen check (allergen_note is null or char_length(allergen_note) <= 500),
  unique (checkout_id, sort_order),
  unique (checkout_id, menu_item_id)
);

create table private.pickup_payment_refunds (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  order_id uuid unique references private.pickup_orders(id) on delete cascade,
  checkout_id uuid unique references private.pickup_checkout_drafts(id) on delete cascade,
  provider_payment_intent_id text not null,
  provider_refund_id text unique,
  amount_minor integer not null check (amount_minor between 1 and 100000000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  state text not null default 'pending' check (state in ('pending', 'claimed', 'provider_pending', 'retry', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 20),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pickup_refund_target check ((order_id is null) <> (checkout_id is null)),
  constraint pickup_refund_provider_ids check (
    provider_payment_intent_id ~ '^pi_[A-Za-z0-9]{12,128}$'
    and (provider_refund_id is null or provider_refund_id ~ '^re_[A-Za-z0-9]{12,128}$')
  ),
  constraint pickup_refund_lease check (
    (state = 'claimed' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'claimed' and lease_token is null and lease_expires_at is null)
  )
);

create index pickup_payment_refund_claim_idx
  on private.pickup_payment_refunds (next_attempt_at, created_at)
  where state in ('pending', 'retry', 'provider_pending');

create table private.stripe_webhook_events (
  provider_event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now(),
  constraint stripe_webhook_event_id check (provider_event_id ~ '^evt_[A-Za-z0-9]{12,128}$'),
  constraint stripe_webhook_event_type check (char_length(event_type) between 1 and 120)
);

revoke all privileges on table private.prepaid_pickup_runtime_config,
  private.merchant_payment_accounts, private.pickup_checkout_drafts,
  private.pickup_checkout_lines, private.pickup_payment_refunds,
  private.stripe_webhook_events
  from public, anon, authenticated, service_role;
grant select, update on table private.prepaid_pickup_runtime_config to service_role;

alter table private.pickup_orders
  drop constraint if exists pickup_orders_payment_method_check,
  drop constraint if exists pickup_orders_payment_state_check;
alter table private.pickup_orders
  add column tax_minor integer not null default 0 check (tax_minor between 0 and 100000000),
  add column platform_fee_minor integer not null default 0 check (platform_fee_minor between 0 and 100000000),
  add column total_minor integer not null default 0 check (total_minor between 0 and 100000000),
  add column provider_checkout_id text unique,
  add column provider_payment_intent_id text unique;
update private.pickup_orders set total_minor = item_subtotal_minor where payment_method = 'pay_in_person';
alter table private.pickup_orders
  add constraint pickup_orders_payment_method_check check (payment_method in ('pay_in_person', 'card_or_wallet')),
  add constraint pickup_orders_payment_state_check check (
    payment_state in ('due_at_pickup', 'captured', 'refund_pending', 'refunded', 'partially_refunded', 'disputed')
  ),
  add constraint pickup_orders_payment_binding check (
    (
      payment_method = 'pay_in_person' and payment_state = 'due_at_pickup'
      and tax_minor = 0 and platform_fee_minor = 0 and total_minor = item_subtotal_minor
      and provider_checkout_id is null and provider_payment_intent_id is null
    ) or (
      payment_method = 'card_or_wallet' and payment_state <> 'due_at_pickup'
      and total_minor = item_subtotal_minor + tax_minor
      and platform_fee_minor <= item_subtotal_minor
      and provider_checkout_id ~ '^cs_[A-Za-z0-9_]{12,128}$'
      and provider_payment_intent_id ~ '^pi_[A-Za-z0-9]{12,128}$'
    )
  );

create or replace function private.pickup_order_json(target_order_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'order_public_id', target.public_id,
    'business_id', target.business_id,
    'business_name', (select business.name from public.businesses business where business.id = target.business_id),
    'location_id', target.location_id,
    'location', (select jsonb_build_object(
      'label', location.label, 'address', location.address_line, 'city', location.city,
      'region', location.region, 'postal_code', location.postal_code
    ) from public.business_locations location where location.id = target.location_id),
    'state', target.state,
    'payment_method', target.payment_method,
    'payment_state', target.payment_state,
    'currency', target.currency,
    'item_subtotal_minor', target.item_subtotal_minor,
    'tax_minor', target.tax_minor,
    'total_minor', target.total_minor,
    'requested_pickup_at', target.requested_pickup_at,
    'acceptance_expires_at', target.acceptance_expires_at,
    'customer_note', target.customer_note,
    'terms_version', target.terms_version,
    'version', target.version,
    'created_at', target.created_at,
    'updated_at', target.updated_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
      'menu_item_id', item.menu_item_id, 'name', item.name, 'quantity', item.quantity,
      'unit_price_minor', item.unit_price_minor, 'line_subtotal_minor', item.line_subtotal_minor,
      'allergen_note', item.allergen_note
    ) order by item.sort_order) from private.pickup_order_items item where item.order_id = target.id), '[]'::jsonb)
  ) from private.pickup_orders target where target.id = target_order_id;
$$;
revoke all on function private.pickup_order_json(uuid) from public, anon, authenticated, service_role;

create or replace function private.normalize_pickup_order_payment_totals()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.payment_method = 'pay_in_person' then
    new.tax_minor := 0;
    new.platform_fee_minor := 0;
    new.total_minor := new.item_subtotal_minor;
  end if;
  return new;
end;
$$;
revoke all on function private.normalize_pickup_order_payment_totals()
  from public, anon, authenticated, service_role;
drop trigger if exists normalize_pickup_order_payment_totals on private.pickup_orders;
create trigger normalize_pickup_order_payment_totals
before insert on private.pickup_orders for each row
execute function private.normalize_pickup_order_payment_totals();

create or replace function private.require_payment_service_role()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
end;
$$;
revoke all on function private.require_payment_service_role() from public, anon, authenticated, service_role;
grant execute on function private.require_payment_service_role() to service_role;

create or replace function private.payment_account_payload(target_business_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'business_id', target.business_id,
    'provider_account_id', target.provider_account_id,
    'country', target.country,
    'default_currency', target.default_currency,
    'details_submitted', target.details_submitted,
    'charges_enabled', target.charges_enabled,
    'payouts_enabled', target.payouts_enabled,
    'accept_prepaid', target.accept_prepaid,
    'requirements_due_count', target.requirements_due_count,
    'updated_at', target.updated_at
  ) from private.merchant_payment_accounts target where target.business_id = target_business_id;
$$;
revoke all on function private.payment_account_payload(uuid) from public, anon, authenticated, service_role;

create or replace function public.authorize_business_payment_management(target_business_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED';
  end if;
  perform private.require_aal2();
  if target_business_id is null or not private.is_business_member(
    target_business_id, actor, array['owner', 'manager']::public.member_role[]
  ) then raise exception using errcode = '42501', message = 'BUSINESS_OWNER_OR_MANAGER_REQUIRED'; end if;
  if not exists (select 1 from public.businesses business where business.id = target_business_id and business.kind in ('restaurant', 'food_truck')) then
    raise exception using errcode = '22023', message = 'PAYMENT_BUSINESS_NOT_ELIGIBLE';
  end if;
  return true;
end;
$$;
revoke all on function public.authorize_business_payment_management(uuid) from public, anon, authenticated, service_role;
grant execute on function public.authorize_business_payment_management(uuid) to authenticated;

create or replace function public.set_business_prepaid_acceptance(target_business_id uuid, should_accept boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare actor uuid := auth.uid(); target private.merchant_payment_accounts%rowtype; config_enabled boolean;
begin
  perform public.authorize_business_payment_management(target_business_id);
  if should_accept is null then raise exception using errcode = '22023', message = 'INVALID_PAYMENT_ACCEPTANCE'; end if;
  perform private.consume_rate_limit(actor, 'set_business_prepaid_acceptance', 20, 86400);
  select enabled into config_enabled from private.prepaid_pickup_runtime_config where singleton;
  select * into target from private.merchant_payment_accounts account
  where account.business_id = target_business_id for update;
  if not found then raise exception using errcode = '55000', message = 'PAYMENT_ONBOARDING_REQUIRED'; end if;
  if should_accept and (
    not config_enabled or not target.details_submitted or not target.charges_enabled or not target.payouts_enabled
  ) then raise exception using errcode = '55000', message = 'PAYMENT_ACCOUNT_NOT_READY'; end if;
  update private.merchant_payment_accounts set accept_prepaid = should_accept, updated_at = now()
  where business_id = target_business_id;
  perform private.write_audit_event(actor, target_business_id,
    case when should_accept then 'payment.prepaid_enabled' else 'payment.prepaid_disabled' end,
    'merchant_payment_account', target_business_id::text, '{}'::jsonb);
  return (private.payment_account_payload(target_business_id) - 'provider_account_id');
end;
$$;
revoke all on function public.set_business_prepaid_acceptance(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_business_prepaid_acceptance(uuid, boolean) to authenticated;

create or replace function public.get_business_prepaid_payment_status(target_business_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare payload jsonb;
begin
  perform public.authorize_business_payment_management(target_business_id);
  payload := private.payment_account_payload(target_business_id);
  if payload is null then
    return jsonb_build_object(
      'business_id', target_business_id, 'onboarding_started', false,
      'details_submitted', false, 'charges_enabled', false, 'payouts_enabled', false,
      'accept_prepaid', false, 'requirements_due_count', 0, 'country', null,
      'default_currency', null, 'updated_at', null
    );
  end if;
  return (payload - 'provider_account_id') || jsonb_build_object('onboarding_started', true);
end;
$$;
revoke all on function public.get_business_prepaid_payment_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_business_prepaid_payment_status(uuid) to authenticated;

create or replace function public.get_payment_account_server(target_business_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin perform private.require_payment_service_role(); return private.payment_account_payload(target_business_id); end;
$$;
create or replace function public.upsert_payment_account_server(
  target_business_id uuid, target_provider_account_id text, target_country text,
  target_default_currency text, target_details_submitted boolean, target_charges_enabled boolean,
  target_payouts_enabled boolean, target_requirements_due_count integer
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_payment_service_role();
  if target_business_id is null or target_provider_account_id !~ '^acct_[A-Za-z0-9]{12,128}$'
    or target_country !~ '^[A-Z]{2}$'
    or (target_default_currency is not null and target_default_currency !~ '^[A-Z]{3}$')
    or target_details_submitted is null or target_charges_enabled is null or target_payouts_enabled is null
    or target_requirements_due_count not between 0 and 1000
  then raise exception using errcode = '22023', message = 'INVALID_PAYMENT_ACCOUNT'; end if;
  insert into private.merchant_payment_accounts (
    business_id, provider_account_id, country, default_currency, details_submitted,
    charges_enabled, payouts_enabled, requirements_due_count
  ) values (
    target_business_id, target_provider_account_id, target_country, target_default_currency,
    target_details_submitted, target_charges_enabled, target_payouts_enabled, target_requirements_due_count
  ) on conflict (business_id) do update set
    default_currency = excluded.default_currency,
    details_submitted = excluded.details_submitted,
    charges_enabled = excluded.charges_enabled,
    payouts_enabled = excluded.payouts_enabled,
    requirements_due_count = excluded.requirements_due_count,
    accept_prepaid = case when excluded.details_submitted and excluded.charges_enabled and excluded.payouts_enabled
      then private.merchant_payment_accounts.accept_prepaid else false end,
    updated_at = now()
  where private.merchant_payment_accounts.provider_account_id = excluded.provider_account_id
    and private.merchant_payment_accounts.country = excluded.country;
  if not found then raise exception using errcode = '23505', message = 'PAYMENT_ACCOUNT_BINDING_CONFLICT'; end if;
  return private.payment_account_payload(target_business_id);
end;
$$;

create or replace function public.refresh_payment_account_server(
  target_business_id uuid, target_provider_account_id text, target_country text,
  target_default_currency text, target_details_submitted boolean, target_charges_enabled boolean,
  target_payouts_enabled boolean, target_requirements_due_count integer
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_payment_service_role();
  if target_business_id is null or target_provider_account_id !~ '^acct_[A-Za-z0-9]{12,128}$'
    or target_country !~ '^[A-Z]{2}$'
    or (target_default_currency is not null and target_default_currency !~ '^[A-Z]{3}$')
    or target_details_submitted is null or target_charges_enabled is null or target_payouts_enabled is null
    or target_requirements_due_count not between 0 and 1000
  then raise exception using errcode = '22023', message = 'INVALID_PAYMENT_ACCOUNT'; end if;
  update private.merchant_payment_accounts set
    default_currency = target_default_currency,
    details_submitted = target_details_submitted,
    charges_enabled = target_charges_enabled,
    payouts_enabled = target_payouts_enabled,
    requirements_due_count = target_requirements_due_count,
    accept_prepaid = case when target_details_submitted and target_charges_enabled and target_payouts_enabled
      then accept_prepaid else false end,
    updated_at = now()
  where business_id = target_business_id and provider_account_id = target_provider_account_id
    and country = target_country;
  if not found then return jsonb_build_object('status', 'ignored'); end if;
  return private.payment_account_payload(target_business_id);
end;
$$;

create or replace function private.prepaid_checkout_payload(target_checkout_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'checkout_public_id', checkout_row.public_id,
    'state', checkout_row.state,
    'business_id', checkout_row.business_id,
    'business_name', (select business.name from public.businesses business where business.id = checkout_row.business_id),
    'provider_account_id', account.provider_account_id,
    'provider_checkout_id', checkout_row.provider_checkout_id,
    'currency', checkout_row.currency,
    'item_subtotal_minor', checkout_row.item_subtotal_minor,
    'application_fee_minor', checkout_row.application_fee_minor,
    'requested_pickup_at', checkout_row.requested_pickup_at,
    'expires_at', checkout_row.expires_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
      'name', line.name, 'quantity', line.quantity, 'unit_price_minor', line.unit_price_minor
    ) order by line.sort_order) from private.pickup_checkout_lines line where line.checkout_id = checkout_row.id), '[]'::jsonb)
  ) from private.pickup_checkout_drafts checkout_row
  join private.merchant_payment_accounts account on account.business_id = checkout_row.business_id
  where checkout_row.id = target_checkout_id;
$$;
revoke all on function private.prepaid_checkout_payload(uuid) from public, anon, authenticated, service_role;

create or replace function public.prepare_prepaid_pickup_checkout_server(
  target_user_id uuid, target_business_id uuid, target_location_id uuid,
  target_requested_pickup_at timestamptz, target_lines jsonb, target_customer_note text,
  target_idempotency_key text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  config private.prepaid_pickup_runtime_config%rowtype; account private.merchant_payment_accounts%rowtype;
  key_hash text; request_hash text; prior private.pickup_checkout_drafts%rowtype;
  checkout_id uuid := gen_random_uuid(); target_line jsonb; target_item record;
  item_id uuid; quantity integer; currency text; subtotal bigint := 0; line_total bigint;
  sort_index integer := 0; seen uuid[] := '{}'::uuid[]; snapshots jsonb[] := '{}'::jsonb[];
begin
  perform private.require_payment_service_role();
  if target_user_id is null or not private.is_active_user(target_user_id)
    or target_business_id is null or target_location_id is null or target_requested_pickup_at is null
    or jsonb_typeof(target_lines) <> 'array' or jsonb_array_length(target_lines) not between 1 and 20
    or (target_customer_note is not null and (char_length(btrim(target_customer_note)) not between 1 and 240 or not private.content_is_professional(target_customer_note)))
  then raise exception using errcode = '22023', message = 'INVALID_PREPAID_CHECKOUT'; end if;
  key_hash := private.idempotency_key_hash(target_idempotency_key);
  request_hash := private.json_request_hash(jsonb_build_object(
    'business_id', target_business_id, 'location_id', target_location_id,
    'requested_pickup_at', target_requested_pickup_at, 'lines', target_lines,
    'customer_note', nullif(btrim(target_customer_note), '')
  ));
  perform private.lock_idempotency_request(target_user_id, 'prepare_prepaid_pickup_checkout', key_hash);
  select * into prior from private.pickup_checkout_drafts checkout_row
  where checkout_row.customer_id = target_user_id and checkout_row.idempotency_key_hash = key_hash;
  if found then
    if prior.request_hash <> request_hash then raise exception using errcode = '23505', message = 'IDEMPOTENCY_CONFLICT'; end if;
    return private.prepaid_checkout_payload(prior.id);
  end if;
  perform private.consume_rate_limit(target_user_id, 'prepare_prepaid_pickup_checkout', 20, 3600);
  select * into config from private.prepaid_pickup_runtime_config where singleton for update;
  if not found or not config.enabled then raise exception using errcode = '55000', message = 'PREPAID_PICKUP_DISABLED'; end if;
  perform 1 from public.businesses business where business.id = target_business_id
    and business.kind in ('restaurant', 'food_truck') and business.verification = 'verified' for update;
  if not found or not private.is_business_publicly_eligible(target_business_id) then
    raise exception using errcode = '55000', message = 'PREPAID_PICKUP_UNAVAILABLE';
  end if;
  select * into account from private.merchant_payment_accounts payment
  where payment.business_id = target_business_id for update;
  if not found or not account.accept_prepaid or not account.details_submitted
    or not account.charges_enabled or not account.payouts_enabled
  then raise exception using errcode = '55000', message = 'PREPAID_PICKUP_UNAVAILABLE'; end if;
  if not exists (select 1 from public.business_pickup_ordering_preferences preference
    where preference.business_id = target_business_id and preference.opted_in)
    or not exists (select 1 from public.business_locations location
      where location.id = target_location_id and location.business_id = target_business_id
        and location.publication_state = 'published' and location.public_address
        and not location.is_approximate and location.address_line is not null)
  then raise exception using errcode = '55000', message = 'PREPAID_PICKUP_UNAVAILABLE'; end if;
  if target_requested_pickup_at < now() + make_interval(mins => config.checkout_expiry_minutes + 10)
    or target_requested_pickup_at > now() + interval '7 days'
  then raise exception using errcode = '22023', message = 'PICKUP_TIME_UNAVAILABLE'; end if;
  if (select count(*) from private.pickup_orders existing where existing.customer_id = target_user_id
    and existing.state in ('pending_acceptance', 'accepted', 'preparing', 'ready')) >= 10
  then raise exception using errcode = '54000', message = 'ACTIVE_PICKUP_ORDER_LIMIT'; end if;

  for target_line in select value from jsonb_array_elements(target_lines) loop
    if jsonb_typeof(target_line) <> 'object' or target_line - array['menu_item_id', 'quantity'] <> '{}'::jsonb
      or not target_line ? 'menu_item_id' or not target_line ? 'quantity'
    then raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_LINE'; end if;
    begin item_id := (target_line ->> 'menu_item_id')::uuid; quantity := (target_line ->> 'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_LINE'; end;
    if quantity not between 1 and 20 or item_id = any(seen) then
      raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDER_LINE'; end if;
    select item.id, item.name, item.price_minor, item.currency, item.allergen_note into target_item
    from public.menu_items item join public.menu_sections section on section.id = item.section_id
    where item.id = item_id and section.business_id = target_business_id and section.is_published
      and item.is_published and item.availability = 'available';
    if not found then raise exception using errcode = '55000', message = 'PICKUP_ITEM_UNAVAILABLE'; end if;
    if currency is null then currency := target_item.currency; end if;
    if target_item.currency <> currency then raise exception using errcode = '55000', message = 'PICKUP_MENU_CURRENCY_MISMATCH'; end if;
    line_total := target_item.price_minor::bigint * quantity; subtotal := subtotal + line_total;
    if subtotal > 100000000 then raise exception using errcode = '22003', message = 'PICKUP_ORDER_TOTAL_TOO_LARGE'; end if;
    seen := array_append(seen, item_id);
    snapshots := array_append(snapshots, jsonb_build_object(
      'menu_item_id', target_item.id, 'name', target_item.name, 'quantity', quantity,
      'unit_price_minor', target_item.price_minor, 'line_subtotal_minor', line_total,
      'allergen_note', target_item.allergen_note, 'sort_order', sort_index
    )); sort_index := sort_index + 1;
  end loop;
  if subtotal < 50 then raise exception using errcode = '22023', message = 'PREPAID_TOTAL_TOO_SMALL'; end if;
  insert into private.pickup_checkout_drafts (
    id, customer_id, business_id, location_id, currency, item_subtotal_minor,
    application_fee_minor, requested_pickup_at, customer_note, terms_version,
    refund_policy_version, idempotency_key_hash, request_hash, expires_at
  ) values (
    checkout_id, target_user_id, target_business_id, target_location_id, currency, subtotal,
    floor(subtotal * config.application_fee_bps / 10000.0)::integer,
    target_requested_pickup_at, nullif(btrim(target_customer_note), ''), config.terms_version,
    config.refund_policy_version, key_hash, request_hash,
    now() + make_interval(mins => config.checkout_expiry_minutes)
  );
  insert into private.pickup_checkout_lines (
    checkout_id, menu_item_id, name, quantity, unit_price_minor, line_subtotal_minor, allergen_note, sort_order
  ) select checkout_id, line.menu_item_id, line.name, line.quantity, line.unit_price_minor,
    line.line_subtotal_minor, line.allergen_note, line.sort_order
  from jsonb_to_recordset(to_jsonb(snapshots)) as line(
    menu_item_id uuid, name text, quantity smallint, unit_price_minor integer,
    line_subtotal_minor integer, allergen_note text, sort_order smallint
  );
  return private.prepaid_checkout_payload(checkout_id);
end;
$$;

create or replace function public.attach_prepaid_checkout_provider_server(
  target_checkout_public_id uuid, target_provider_checkout_id text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare checkout_row private.pickup_checkout_drafts%rowtype;
begin
  perform private.require_payment_service_role();
  if target_provider_checkout_id !~ '^cs_[A-Za-z0-9_]{12,128}$' then
    raise exception using errcode = '22023', message = 'INVALID_PROVIDER_CHECKOUT'; end if;
  select * into checkout_row from private.pickup_checkout_drafts target
  where target.public_id = target_checkout_public_id for update;
  if not found or checkout_row.state not in ('prepared', 'open') then
    raise exception using errcode = 'P0002', message = 'CHECKOUT_NOT_FOUND'; end if;
  if checkout_row.provider_checkout_id is not null and checkout_row.provider_checkout_id <> target_provider_checkout_id then
    raise exception using errcode = '23505', message = 'CHECKOUT_PROVIDER_CONFLICT'; end if;
  update private.pickup_checkout_drafts set provider_checkout_id = target_provider_checkout_id,
    state = 'open', updated_at = now() where id = checkout_row.id;
  return private.prepaid_checkout_payload(checkout_row.id);
end;
$$;

create or replace function public.get_my_prepaid_pickup_checkout_status(target_checkout_public_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); checkout_row private.pickup_checkout_drafts%rowtype;
begin
  if actor is null or not private.is_active_user(actor) then raise exception using errcode = '42501', message = 'ACTIVE_ACCOUNT_REQUIRED'; end if;
  select * into checkout_row from private.pickup_checkout_drafts target
  where target.public_id = target_checkout_public_id and target.customer_id = actor;
  if not found then raise exception using errcode = 'P0002', message = 'CHECKOUT_NOT_FOUND'; end if;
  return jsonb_build_object(
    'checkout_public_id', checkout_row.public_id, 'state', checkout_row.state,
    'order', case when checkout_row.order_id is null then null else private.pickup_order_json(checkout_row.order_id) end,
    'expires_at', checkout_row.expires_at, 'updated_at', checkout_row.updated_at
  );
end;
$$;
revoke all on function public.get_my_prepaid_pickup_checkout_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_my_prepaid_pickup_checkout_status(uuid) to authenticated;

create or replace function private.record_stripe_webhook_event(target_event_id text, target_event_type text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_payment_service_role();
  if target_event_id !~ '^evt_[A-Za-z0-9]{12,128}$' or char_length(target_event_type) not between 1 and 120
  then raise exception using errcode = '22023', message = 'INVALID_WEBHOOK_EVENT'; end if;
  insert into private.stripe_webhook_events (provider_event_id, event_type)
  values (target_event_id, target_event_type) on conflict do nothing;
  return found;
end;
$$;

create or replace function public.complete_prepaid_checkout_server(
  target_event_id text, target_event_type text, target_checkout_public_id uuid, target_provider_checkout_id text,
  target_provider_payment_intent_id text, target_currency text,
  target_total_minor integer, target_tax_minor integer
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare checkout_row private.pickup_checkout_drafts%rowtype; new_order_id uuid := gen_random_uuid();
  ordering_config private.pickup_ordering_runtime_config%rowtype; inserted_event boolean;
begin
  perform private.require_payment_service_role();
  if target_event_type not in ('checkout.session.completed', 'checkout.session.async_payment_succeeded') then
    raise exception using errcode = '22023', message = 'INVALID_CHECKOUT_EVENT_TYPE';
  end if;
  inserted_event := private.record_stripe_webhook_event(target_event_id, target_event_type);
  if not inserted_event then return jsonb_build_object('status', 'duplicate'); end if;
  if target_provider_checkout_id !~ '^cs_[A-Za-z0-9_]{12,128}$'
    or target_provider_payment_intent_id !~ '^pi_[A-Za-z0-9]{12,128}$'
    or target_currency !~ '^[A-Z]{3}$' or target_total_minor not between 1 and 100000000
    or target_tax_minor not between 0 and 100000000
  then raise exception using errcode = '22023', message = 'INVALID_CHECKOUT_COMPLETION'; end if;
  select * into checkout_row from private.pickup_checkout_drafts target
  where target.public_id = target_checkout_public_id for update;
  if not found or checkout_row.provider_checkout_id is distinct from target_provider_checkout_id
    or checkout_row.currency <> target_currency
    or target_total_minor <> checkout_row.item_subtotal_minor + target_tax_minor
  then raise exception using errcode = '55000', message = 'CHECKOUT_COMPLETION_MISMATCH'; end if;
  if checkout_row.state = 'completed' then return jsonb_build_object('status', 'completed'); end if;
  if checkout_row.state not in ('open', 'prepared') then raise exception using errcode = '55000', message = 'CHECKOUT_NOT_COMPLETABLE'; end if;
  update private.pickup_checkout_drafts set provider_payment_intent_id = target_provider_payment_intent_id,
    updated_at = now() where id = checkout_row.id;
  if checkout_row.customer_id is null or not private.is_active_user(checkout_row.customer_id)
    or checkout_row.requested_pickup_at <= now() + interval '5 minutes'
  then
    insert into private.pickup_payment_refunds (
      checkout_id, provider_payment_intent_id, amount_minor, currency
    ) values (checkout_row.id, target_provider_payment_intent_id, target_total_minor, target_currency);
    update private.pickup_checkout_drafts set state = 'refund_pending', updated_at = now() where id = checkout_row.id;
    return jsonb_build_object('status', 'refund_pending');
  end if;
  select * into ordering_config from private.pickup_ordering_runtime_config where singleton;
  if not found or not ordering_config.enabled then
    insert into private.pickup_payment_refunds (
      checkout_id, provider_payment_intent_id, amount_minor, currency
    ) values (checkout_row.id, target_provider_payment_intent_id, target_total_minor, target_currency);
    update private.pickup_checkout_drafts set state = 'refund_pending', updated_at = now() where id = checkout_row.id;
    return jsonb_build_object('status', 'refund_pending');
  end if;
  insert into private.pickup_orders (
    id, customer_id, business_id, location_id, state, payment_method, payment_state,
    currency, item_subtotal_minor, tax_minor, platform_fee_minor, total_minor,
    requested_pickup_at, acceptance_expires_at, customer_note, terms_version,
    provider_checkout_id, provider_payment_intent_id
  ) values (
    new_order_id, checkout_row.customer_id, checkout_row.business_id, checkout_row.location_id,
    'pending_acceptance', 'card_or_wallet', 'captured', checkout_row.currency,
    checkout_row.item_subtotal_minor, target_tax_minor, checkout_row.application_fee_minor,
    target_total_minor, checkout_row.requested_pickup_at,
    least(now() + make_interval(mins => ordering_config.acceptance_timeout_minutes), checkout_row.requested_pickup_at - interval '1 second'),
    checkout_row.customer_note, checkout_row.terms_version,
    target_provider_checkout_id, target_provider_payment_intent_id
  );
  insert into private.pickup_order_items (
    order_id, menu_item_id, name, quantity, unit_price_minor, line_subtotal_minor, allergen_note, sort_order
  ) select new_order_id, line.menu_item_id, line.name, line.quantity, line.unit_price_minor,
    line.line_subtotal_minor, line.allergen_note, line.sort_order
  from private.pickup_checkout_lines line where line.checkout_id = checkout_row.id;
  insert into private.pickup_order_events (order_id, event_version, prior_state, current_state, actor_type, actor_id)
  values (new_order_id, 1, null, 'pending_acceptance', 'customer', checkout_row.customer_id);
  update private.pickup_checkout_drafts set state = 'completed', order_id = new_order_id,
    provider_payment_intent_id = target_provider_payment_intent_id, updated_at = now()
  where id = checkout_row.id;
  perform private.write_audit_event(checkout_row.customer_id, checkout_row.business_id,
    'pickup_order.prepaid_created', 'pickup_order', (select public_id::text from private.pickup_orders where id = new_order_id),
    jsonb_build_object('payment_method', 'card_or_wallet'));
  return jsonb_build_object('status', 'completed');
end;
$$;

create or replace function public.close_prepaid_checkout_server(
  target_event_id text, target_event_type text, target_checkout_public_id uuid,
  target_provider_checkout_id text, target_state text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare inserted_event boolean; checkout_row private.pickup_checkout_drafts%rowtype;
begin
  perform private.require_payment_service_role();
  if target_event_type not in ('checkout.session.expired', 'checkout.session.async_payment_failed')
    or target_state not in ('expired', 'failed')
    or (target_event_type = 'checkout.session.expired') <> (target_state = 'expired')
    or target_provider_checkout_id !~ '^cs_[A-Za-z0-9_]{12,128}$'
  then raise exception using errcode = '22023', message = 'INVALID_CHECKOUT_CLOSE_EVENT'; end if;
  inserted_event := private.record_stripe_webhook_event(target_event_id, target_event_type);
  if not inserted_event then return jsonb_build_object('status', 'duplicate'); end if;
  select * into checkout_row from private.pickup_checkout_drafts target
  where target.public_id = target_checkout_public_id for update;
  if not found or checkout_row.provider_checkout_id is distinct from target_provider_checkout_id
  then raise exception using errcode = 'P0002', message = 'CHECKOUT_NOT_FOUND'; end if;
  if checkout_row.state in ('completed', 'refund_pending', 'refunded') then
    return jsonb_build_object('status', checkout_row.state);
  end if;
  update private.pickup_checkout_drafts set state = target_state, updated_at = now()
  where id = checkout_row.id and state in ('prepared', 'open');
  return jsonb_build_object('status', target_state);
end;
$$;

create or replace function private.enqueue_pickup_refund_on_terminal_state()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.payment_method = 'card_or_wallet' and old.payment_state = 'captured'
    and old.state is distinct from new.state and new.state in ('rejected', 'cancelled', 'expired')
  then
    new.payment_state := 'refund_pending';
    insert into private.pickup_payment_refunds (
      order_id, provider_payment_intent_id, amount_minor, currency
    ) values (old.id, old.provider_payment_intent_id, old.total_minor, old.currency)
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_pickup_refund_on_terminal_state() from public, anon, authenticated, service_role;
drop trigger if exists enqueue_pickup_refund_on_terminal_state on private.pickup_orders;
create trigger enqueue_pickup_refund_on_terminal_state
before update of state on private.pickup_orders for each row
execute function private.enqueue_pickup_refund_on_terminal_state();

create or replace function public.claim_pickup_payment_refunds(batch_size integer default 20)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare lease uuid := gen_random_uuid(); result jsonb;
begin
  perform private.require_payment_service_role();
  if batch_size is null or batch_size not between 1 and 50 then raise exception using errcode = '22023', message = 'INVALID_BATCH_SIZE'; end if;
  update private.pickup_payment_refunds target set state = 'retry', lease_token = null,
    lease_expires_at = null, next_attempt_at = now(), updated_at = now()
  where target.state = 'claimed' and target.lease_expires_at <= now();
  update private.pickup_payment_refunds target set state = 'failed',
    last_error_code = 'RETRY_LIMIT_EXCEEDED', updated_at = now()
  where target.state in ('pending', 'retry', 'provider_pending') and target.attempts >= 20;
  with selected as (
    select target.id from private.pickup_payment_refunds target
    where target.state in ('pending', 'retry', 'provider_pending')
      and target.attempts < 20 and target.next_attempt_at <= now()
    order by target.next_attempt_at, target.created_at, target.id for update skip locked limit batch_size
  ), claimed as (
    update private.pickup_payment_refunds target set state = 'claimed', attempts = target.attempts + 1,
      lease_token = lease, lease_expires_at = now() + interval '2 minutes', updated_at = now()
    from selected where target.id = selected.id
    returning target.public_id, target.provider_payment_intent_id, target.provider_refund_id, target.amount_minor,
      target.currency, target.attempts, target.lease_token,
      coalesce(
        (select source.platform_fee_minor > 0 from private.pickup_orders source where source.id = target.order_id),
        (select source.application_fee_minor > 0 from private.pickup_checkout_drafts source where source.id = target.checkout_id),
        false
      ) as refund_application_fee
  ) select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into result from claimed;
  return result;
end;
$$;

create or replace function public.finish_pickup_payment_refund(
  target_public_id uuid, target_lease_token uuid, target_outcome text,
  target_provider_refund_id text, target_error_code text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare target private.pickup_payment_refunds%rowtype; normalized_outcome text := target_outcome;
begin
  perform private.require_payment_service_role();
  if target_outcome not in ('succeeded', 'provider_pending', 'retry', 'failed')
    or (target_provider_refund_id is not null and target_provider_refund_id !~ '^re_[A-Za-z0-9]{12,128}$')
    or (target_error_code is not null and (char_length(target_error_code) not between 1 and 80 or target_error_code !~ '^[A-Z0-9_]+$'))
  then raise exception using errcode = '22023', message = 'INVALID_REFUND_RESULT'; end if;
  select * into target from private.pickup_payment_refunds operation
  where operation.public_id = target_public_id and operation.state = 'claimed'
    and operation.lease_token = target_lease_token and operation.lease_expires_at > now() for update;
  if not found then raise exception using errcode = 'P0002', message = 'REFUND_LEASE_NOT_FOUND'; end if;
  if normalized_outcome in ('retry', 'provider_pending') and target.attempts >= 20 then
    normalized_outcome := 'failed';
    target_error_code := 'RETRY_LIMIT_EXCEEDED';
  end if;
  update private.pickup_payment_refunds operation set
    state = normalized_outcome,
    provider_refund_id = coalesce(target_provider_refund_id, operation.provider_refund_id),
    last_error_code = target_error_code,
    next_attempt_at = case when normalized_outcome = 'retry'
      then now() + make_interval(secs => least(3600, 15 * (2 ^ least(operation.attempts, 8))::integer))
      when normalized_outcome = 'provider_pending' then now() + interval '15 minutes'
      else operation.next_attempt_at end,
    lease_token = null, lease_expires_at = null, updated_at = now()
  where operation.id = target.id;
  if normalized_outcome = 'succeeded' then
    update private.pickup_orders set payment_state = 'refunded', updated_at = now() where id = target.order_id;
    update private.pickup_checkout_drafts set state = 'refunded', updated_at = now() where id = target.checkout_id;
  end if;
  return jsonb_build_object('status', normalized_outcome);
end;
$$;

create or replace function public.apply_refund_webhook_server(
  target_event_id text, target_payment_intent_id text, target_fully_refunded boolean
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare inserted_event boolean;
begin
  perform private.require_payment_service_role();
  inserted_event := private.record_stripe_webhook_event(target_event_id, 'charge.refunded');
  if not inserted_event then return jsonb_build_object('status', 'duplicate'); end if;
  if target_payment_intent_id !~ '^pi_[A-Za-z0-9]{12,128}$' or target_fully_refunded is null
  then raise exception using errcode = '22023', message = 'INVALID_REFUND_EVENT'; end if;
  update private.pickup_payment_refunds set state = case when target_fully_refunded then 'succeeded' else 'provider_pending' end,
    lease_token = null, lease_expires_at = null, updated_at = now()
  where provider_payment_intent_id = target_payment_intent_id and state <> 'succeeded';
  update private.pickup_orders set payment_state = case when target_fully_refunded then 'refunded' else 'partially_refunded' end,
    updated_at = now() where provider_payment_intent_id = target_payment_intent_id;
  update private.pickup_checkout_drafts set state = case when target_fully_refunded then 'refunded' else state end,
    updated_at = now() where provider_payment_intent_id = target_payment_intent_id;
  return jsonb_build_object('status', 'processed');
end;
$$;

create or replace function public.apply_refund_status_webhook_server(
  target_event_id text, target_event_type text, target_payment_intent_id text,
  target_provider_refund_id text, target_provider_status text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare inserted_event boolean; normalized_state text;
begin
  perform private.require_payment_service_role();
  if target_event_type not in ('refund.updated', 'refund.failed')
    or target_payment_intent_id !~ '^pi_[A-Za-z0-9]{12,128}$'
    or target_provider_refund_id !~ '^re_[A-Za-z0-9]{12,128}$'
    or target_provider_status not in ('pending', 'succeeded', 'failed', 'canceled')
  then raise exception using errcode = '22023', message = 'INVALID_REFUND_STATUS_EVENT'; end if;
  inserted_event := private.record_stripe_webhook_event(target_event_id, target_event_type);
  if not inserted_event then return jsonb_build_object('status', 'duplicate'); end if;
  normalized_state := case target_provider_status
    when 'succeeded' then 'succeeded'
    when 'pending' then 'provider_pending'
    else 'failed' end;
  update private.pickup_payment_refunds set state = normalized_state,
    provider_refund_id = target_provider_refund_id,
    last_error_code = case when normalized_state = 'failed' then 'PROVIDER_REFUND_FAILED' else null end,
    lease_token = null, lease_expires_at = null, updated_at = now()
  where provider_payment_intent_id = target_payment_intent_id and state <> 'succeeded';
  if normalized_state = 'succeeded' then
    update private.pickup_orders set payment_state = 'refunded', updated_at = now()
    where provider_payment_intent_id = target_payment_intent_id;
    update private.pickup_checkout_drafts set state = 'refunded', updated_at = now()
    where provider_payment_intent_id = target_payment_intent_id;
  end if;
  return jsonb_build_object('status', normalized_state);
end;
$$;

create or replace function public.apply_dispute_webhook_server(
  target_event_id text, target_payment_intent_id text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare inserted_event boolean;
begin
  perform private.require_payment_service_role();
  inserted_event := private.record_stripe_webhook_event(target_event_id, 'charge.dispute.created');
  if not inserted_event then return jsonb_build_object('status', 'duplicate'); end if;
  if target_payment_intent_id !~ '^pi_[A-Za-z0-9]{12,128}$' then raise exception using errcode = '22023', message = 'INVALID_DISPUTE_EVENT'; end if;
  update private.pickup_orders set payment_state = 'disputed', updated_at = now()
  where provider_payment_intent_id = target_payment_intent_id;
  return jsonb_build_object('status', 'processed');
end;
$$;

create or replace function public.expire_prepaid_pickup_checkouts(batch_size integer default 200)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare expired_count integer;
begin
  perform private.require_payment_service_role();
  if batch_size is null or batch_size not between 1 and 1000 then raise exception using errcode = '22023', message = 'INVALID_BATCH_SIZE'; end if;
  with selected as (
    select target.id from private.pickup_checkout_drafts target
    where target.state in ('prepared', 'open') and target.expires_at <= now()
    order by target.expires_at, target.id for update skip locked limit batch_size
  ), updated as (
    update private.pickup_checkout_drafts target set state = 'expired', updated_at = now()
    from selected where target.id = selected.id returning target.id
  ) select count(*) into expired_count from updated;
  return jsonb_build_object('expired', expired_count, 'more_work', exists (
    select 1 from private.pickup_checkout_drafts target
    where target.state in ('prepared', 'open') and target.expires_at <= now()
  ));
end;
$$;

do $prepaid_export_core$
begin
  if pg_catalog.to_regprocedure('public.account_export_payload_pre_prepaid(uuid)') is null then
    alter function public.account_export_payload(uuid)
      rename to account_export_payload_pre_prepaid;
  end if;
end;
$prepaid_export_core$;
create or replace function public.account_export_payload(target_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.account_export_payload_pre_prepaid(target_user_id) || jsonb_build_object(
    'prepaid_pickup_checkouts', coalesce((select jsonb_agg(jsonb_build_object(
      'checkout_public_id', target.public_id, 'business_id', target.business_id,
      'state', target.state, 'currency', target.currency,
      'item_subtotal_minor', target.item_subtotal_minor,
      'requested_pickup_at', target.requested_pickup_at,
      'created_at', target.created_at, 'updated_at', target.updated_at
    ) order by target.created_at, target.id) from private.pickup_checkout_drafts target
    where target.customer_id = target_user_id), '[]'::jsonb)
  );
$$;
revoke all on function public.account_export_payload_pre_prepaid(uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_export_payload_pre_prepaid(uuid) to service_role;
revoke all on function public.account_export_payload(uuid) from public, anon, authenticated, service_role;
grant execute on function public.account_export_payload(uuid) to service_role;

revoke all on function public.get_payment_account_server(uuid),
  public.upsert_payment_account_server(uuid, text, text, text, boolean, boolean, boolean, integer),
  public.refresh_payment_account_server(uuid, text, text, text, boolean, boolean, boolean, integer),
  public.prepare_prepaid_pickup_checkout_server(uuid, uuid, uuid, timestamptz, jsonb, text, text),
  public.attach_prepaid_checkout_provider_server(uuid, text),
  private.record_stripe_webhook_event(text, text),
  public.complete_prepaid_checkout_server(text, text, uuid, text, text, text, integer, integer),
  public.close_prepaid_checkout_server(text, text, uuid, text, text),
  public.apply_refund_webhook_server(text, text, boolean),
  public.apply_refund_status_webhook_server(text, text, text, text, text),
  public.apply_dispute_webhook_server(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_payment_account_server(uuid),
  public.upsert_payment_account_server(uuid, text, text, text, boolean, boolean, boolean, integer),
  public.refresh_payment_account_server(uuid, text, text, text, boolean, boolean, boolean, integer),
  public.prepare_prepaid_pickup_checkout_server(uuid, uuid, uuid, timestamptz, jsonb, text, text),
  public.attach_prepaid_checkout_provider_server(uuid, text),
  private.record_stripe_webhook_event(text, text),
  public.complete_prepaid_checkout_server(text, text, uuid, text, text, text, integer, integer),
  public.close_prepaid_checkout_server(text, text, uuid, text, text),
  public.apply_refund_webhook_server(text, text, boolean),
  public.apply_refund_status_webhook_server(text, text, text, text, text),
  public.apply_dispute_webhook_server(text, text)
  to service_role;

revoke all on function public.claim_pickup_payment_refunds(integer),
  public.finish_pickup_payment_refund(uuid, uuid, text, text, text),
  public.expire_prepaid_pickup_checkouts(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_pickup_payment_refunds(integer),
  public.finish_pickup_payment_refund(uuid, uuid, text, text, text),
  public.expire_prepaid_pickup_checkouts(integer)
  to service_role;
