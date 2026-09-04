-- Merchant pickup preferences are intentionally separate from the staff-only
-- shadow-order controls. Recording an opt-in must not enable public checkout,
-- create a charge, or grant access to internal pilot settings.

create table if not exists public.business_pickup_ordering_preferences (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  opted_in boolean not null default false,
  accepted_payment_options text[] not null default '{}'::text[],
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint business_pickup_payment_options_launch_slice check (
    (not opted_in and accepted_payment_options = '{}'::text[])
    or (opted_in and accepted_payment_options = array['pay_in_person']::text[])
  )
);

alter table public.business_pickup_ordering_preferences enable row level security;

revoke all privileges on table public.business_pickup_ordering_preferences
  from public, anon, authenticated;
grant select on table public.business_pickup_ordering_preferences to authenticated;

drop policy if exists "owners and managers read pickup preferences"
  on public.business_pickup_ordering_preferences;
create policy "owners and managers read pickup preferences"
  on public.business_pickup_ordering_preferences
  for select
  to authenticated
  using (
    private.has_aal2()
    and private.is_business_member(
      business_id,
      auth.uid(),
      array['owner', 'manager']::public.member_role[]
    )
  );

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
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;
  perform private.require_aal2();
  if target_business_id is null or not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
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
  select preference.*
  into target_preference
  from public.business_pickup_ordering_preferences preference
  where preference.business_id = target_business_id;

  return jsonb_build_object(
    'business_id', target_business_id,
    'eligible_kind', category_eligible,
    'merchant_opted_in', category_eligible and coalesce(target_preference.opted_in, false),
    'accepted_payment_options', case
      when category_eligible and coalesce(target_preference.opted_in, false)
        then to_jsonb(target_preference.accepted_payment_options)
      else '[]'::jsonb
    end,
    -- These runtime fields are hard false in this slice. The merchant
    -- preference never acts as a customer-checkout or payment entitlement.
    'customer_ordering_enabled', false,
    'online_payment_processing_enabled', false,
    'listing_state', target_state::text,
    'verification_state', target_verification::text,
    'payment_options', jsonb_build_array(
      jsonb_build_object(
        'kind', 'pay_in_person',
        'label', 'Pay in person',
        'configuration_allowed', true,
        'charge_enabled', false,
        'unavailable_reason', null
      ),
      jsonb_build_object(
        'kind', 'card',
        'label', 'Card in Spottr',
        'configuration_allowed', false,
        'charge_enabled', false,
        'unavailable_reason',
          'Unavailable until provider, KYB, PCI/SCA, webhook, refund, and domain-entitlement controls are approved.'
      ),
      jsonb_build_object(
        'kind', 'apple_pay',
        'label', 'Apple Pay in Spottr',
        'configuration_allowed', false,
        'charge_enabled', false,
        'unavailable_reason',
          'Unavailable until provider, KYB, PCI/SCA, webhook, refund, and domain-entitlement controls are approved.'
      )
    )
  );
end;
$$;

create or replace function public.set_business_pickup_ordering_preferences(
  target_business_id uuid,
  pickup_ordering_opt_in boolean,
  accepted_payment_options text[]
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
  prior_opted_in boolean := false;
  prior_payment_options text[] := '{}'::text[];
  preference_changed boolean := false;
begin
  if actor is null or not private.is_active_user(actor) then
    raise exception using errcode = '42501', message = 'Active account required';
  end if;
  perform private.require_aal2();
  if target_business_id is null
    or pickup_ordering_opt_in is null
    or accepted_payment_options is null
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_ORDERING_PREFERENCES';
  end if;
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;

  -- Serialize configuration with membership and publication transitions, then
  -- re-check authority while the business row is locked.
  select business.kind, business.state, business.verification
  into target_kind, target_state, target_verification
  from public.businesses business
  where business.id = target_business_id
  for update;
  if target_kind is null then
    raise exception using errcode = 'P0002', message = 'Business not found';
  end if;
  if not private.is_business_member(
    target_business_id,
    actor,
    array['owner', 'manager']::public.member_role[]
  ) then
    raise exception using errcode = '42501', message = 'Business owner or manager role required';
  end if;
  if target_kind not in ('restaurant', 'food_truck') then
    raise exception using errcode = '22023', message = 'PICKUP_ORDERING_KIND_NOT_ELIGIBLE';
  end if;

  if accepted_payment_options && array['card', 'apple_pay']::text[] then
    raise exception using errcode = '55000', message = 'ONLINE_PAYMENT_PROCESSING_UNAVAILABLE';
  end if;
  if (pickup_ordering_opt_in and accepted_payment_options <> array['pay_in_person']::text[])
    or (not pickup_ordering_opt_in and accepted_payment_options <> '{}'::text[])
  then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_PAYMENT_OPTIONS';
  end if;
  if pickup_ordering_opt_in
    and (target_state <> 'published' or target_verification <> 'verified')
  then
    raise exception using errcode = '55000', message = 'VERIFIED_PUBLISHED_BUSINESS_REQUIRED';
  end if;

  perform private.consume_rate_limit(
    actor,
    'business_pickup_ordering_preferences',
    30,
    86400
  );

  select preference.opted_in, preference.accepted_payment_options
  into prior_opted_in, prior_payment_options
  from public.business_pickup_ordering_preferences preference
  where preference.business_id = target_business_id
  for update;
  if not found then
    prior_opted_in := false;
    prior_payment_options := '{}'::text[];
  end if;
  preference_changed := prior_opted_in is distinct from pickup_ordering_opt_in
    or prior_payment_options is distinct from accepted_payment_options;

  insert into public.business_pickup_ordering_preferences (
    business_id,
    opted_in,
    accepted_payment_options,
    updated_by,
    updated_at
  ) values (
    target_business_id,
    pickup_ordering_opt_in,
    accepted_payment_options,
    actor,
    now()
  )
  on conflict (business_id) do update
  set opted_in = excluded.opted_in,
      accepted_payment_options = excluded.accepted_payment_options,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  if preference_changed then
    perform private.write_audit_event(
      actor,
      target_business_id,
      case
        when pickup_ordering_opt_in then 'business.pickup_ordering_opted_in'
        else 'business.pickup_ordering_opted_out'
      end,
      'business_pickup_ordering_preferences',
      target_business_id::text,
      jsonb_build_object(
        'merchant_opted_in', pickup_ordering_opt_in,
        'accepted_payment_options', accepted_payment_options,
        'customer_ordering_enabled', false,
        'online_payment_processing_enabled', false
      )
    );
  end if;

  return public.get_business_pickup_ordering_preferences(target_business_id);
end;
$$;

revoke all on function public.get_business_pickup_ordering_preferences(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_business_pickup_ordering_preferences(uuid)
  to authenticated;

revoke all on function public.set_business_pickup_ordering_preferences(
  uuid,
  boolean,
  text[]
) from public, anon, authenticated, service_role;
grant execute on function public.set_business_pickup_ordering_preferences(
  uuid,
  boolean,
  text[]
) to authenticated;
