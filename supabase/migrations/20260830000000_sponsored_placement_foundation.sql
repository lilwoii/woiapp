-- Contextual sponsored-placement foundation. Organic discovery remains entirely
-- independent from these tables. Serving is disabled by default and can only be
-- enabled through a controlled database operation after legal, billing, fraud,
-- and finance gates are satisfied.

do $$ begin
  create type public.ad_campaign_state as enum (
    'draft', 'submitted', 'active', 'paused', 'ended', 'rejected'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.ad_billing_model as enum ('shadow', 'cpc');
exception when duplicate_object then null;
end $$;

create table if not exists public.pricing_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  region_code text not null,
  currency char(3) not null,
  click_floor_minor integer not null,
  click_ceiling_minor integer not null,
  state text not null default 'draft' check (state in ('draft', 'approved', 'retired')),
  effective_at timestamptz not null,
  expires_at timestamptz,
  approval_reference text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint pricing_versions_version_length
    check (char_length(btrim(version)) between 1 and 80),
  constraint pricing_versions_region_length
    check (char_length(btrim(region_code)) between 2 and 80),
  constraint pricing_versions_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint pricing_versions_click_range check (
    click_floor_minor between 0 and 100000000
    and click_ceiling_minor between click_floor_minor and 100000000
  ),
  constraint pricing_versions_window check (expires_at is null or expires_at > effective_at),
  constraint pricing_versions_approval check (
    state <> 'approved'
    or (
      approved_at is not null
      and approval_reference is not null
      and char_length(btrim(approval_reference)) between 3 and 200
    )
  )
);

create table if not exists public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,
  business_id uuid not null references public.businesses(id) on delete restrict,
  objective text not null default 'discovery' check (objective = 'discovery'),
  billing_model public.ad_billing_model not null default 'shadow',
  state public.ad_campaign_state not null default 'draft',
  currency char(3) not null,
  bid_cap_minor integer not null,
  daily_budget_minor integer not null,
  lifetime_budget_minor integer not null,
  pricing_version_id uuid not null references public.pricing_versions(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  approved_at timestamptz,
  approval_reference text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_campaigns_identity unique (id, business_id),
  constraint ad_campaigns_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint ad_campaigns_budget_range check (
    bid_cap_minor between 1 and 100000000
    and daily_budget_minor between bid_cap_minor and 10000000000
    and lifetime_budget_minor between daily_budget_minor and 100000000000
  ),
  constraint ad_campaigns_window check (
    ends_at > starts_at and ends_at <= starts_at + interval '366 days'
  ),
  constraint ad_campaigns_approval check (
    state <> 'active'
    or (
      approved_at is not null
      and approval_reference is not null
      and char_length(btrim(approval_reference)) between 3 and 200
    )
  )
);

create index if not exists ad_campaigns_serving_idx
  on public.ad_campaigns (state, starts_at, ends_at, bid_cap_minor desc);
create index if not exists ad_campaigns_business_idx
  on public.ad_campaigns (business_id, updated_at desc);

create table if not exists public.ad_targets (
  campaign_id uuid primary key references public.ad_campaigns(id) on delete cascade,
  business_kinds public.business_kind[] not null,
  cuisine_labels text[] not null default '{}',
  center public.geography(Point, 4326) not null,
  radius_meters integer not null,
  weekdays smallint[] not null default array[0,1,2,3,4,5,6]::smallint[],
  local_starts_at time,
  local_ends_at time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_targets_kind_count check (cardinality(business_kinds) between 1 and 5),
  constraint ad_targets_cuisine_count check (cardinality(cuisine_labels) <= 12),
  constraint ad_targets_radius check (radius_meters between 500 and 80467),
  constraint ad_targets_weekdays check (
    cardinality(weekdays) between 1 and 7
    and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
  ),
  constraint ad_targets_daypart check (
    (local_starts_at is null and local_ends_at is null)
    or (local_starts_at is not null and local_ends_at is not null)
  )
);

create index if not exists ad_targets_center_idx on public.ad_targets using gist (center);

create table if not exists public.ad_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  business_id uuid not null,
  media_asset_id uuid references public.media_assets(id) on delete restrict,
  moderation public.moderation_state not null default 'pending',
  moderation_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_creatives_campaign_business_fkey
    foreign key (campaign_id, business_id)
    references public.ad_campaigns(id, business_id)
    on delete cascade,
  constraint ad_creatives_moderation_version check (
    moderation <> 'approved'
    or (
      moderation_version is not null
      and char_length(btrim(moderation_version)) between 1 and 80
    )
  )
);

create unique index if not exists ad_creatives_one_approved_idx
  on public.ad_creatives (campaign_id) where moderation = 'approved';

drop trigger if exists ad_campaigns_set_updated_at on public.ad_campaigns;
create trigger ad_campaigns_set_updated_at
before update on public.ad_campaigns
for each row execute function public.set_updated_at();

drop trigger if exists ad_targets_set_updated_at on public.ad_targets;
create trigger ad_targets_set_updated_at
before update on public.ad_targets
for each row execute function public.set_updated_at();

drop trigger if exists ad_creatives_set_updated_at on public.ad_creatives;
create trigger ad_creatives_set_updated_at
before update on public.ad_creatives
for each row execute function public.set_updated_at();

create table if not exists public.ad_campaign_daily_rollups (
  campaign_id uuid not null references public.ad_campaigns(id) on delete restrict,
  service_date date not null,
  impressions bigint not null default 0 check (impressions >= 0),
  opens bigint not null default 0 check (opens >= 0),
  directions bigint not null default 0 check (directions >= 0),
  menu_views bigint not null default 0 check (menu_views >= 0),
  invalid_events bigint not null default 0 check (invalid_events >= 0),
  billed_minor bigint not null default 0 check (billed_minor >= 0),
  credited_minor bigint not null default 0 check (credited_minor >= 0),
  updated_at timestamptz not null default now(),
  primary key (campaign_id, service_date)
);

create table if not exists private.ad_runtime_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  shadow_only boolean not null default true,
  token_secret bytea not null default gen_random_bytes(32),
  approval_reference text,
  updated_at timestamptz not null default now(),
  constraint ad_runtime_config_token_secret check (octet_length(token_secret) = 32),
  constraint ad_runtime_config_enablement check (
    not enabled
    or (
      approval_reference is not null
      and char_length(btrim(approval_reference)) between 3 and 200
    )
  )
);

insert into private.ad_runtime_config (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists private.ad_request_buckets (
  subject_hmac char(64) not null,
  bucket_started_at timestamptz not null,
  request_count integer not null default 1 check (request_count between 1 and 120),
  primary key (subject_hmac, bucket_started_at),
  constraint ad_request_buckets_hmac check (subject_hmac ~ '^[0-9a-f]{64}$')
);

create index if not exists ad_request_buckets_cleanup_idx
  on private.ad_request_buckets (bucket_started_at);

create table if not exists private.ad_serving_decisions (
  id uuid primary key,
  campaign_id uuid not null references public.ad_campaigns(id) on delete restrict,
  business_id uuid not null references public.businesses(id) on delete restrict,
  surface text not null check (surface in ('discover', 'map')),
  organic_filter_hash char(64) not null,
  subject_hmac char(64) not null,
  reason_category text not null check (reason_category in ('near_you', 'matches_category', 'open_nearby')),
  billing_model public.ad_billing_model not null,
  reserved_minor integer not null check (reserved_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  shadow boolean not null,
  selected_at timestamptz not null,
  expires_at timestamptz not null,
  token_hash char(64) not null unique,
  constraint ad_serving_decisions_filter_hash check (organic_filter_hash ~ '^[0-9a-f]{64}$'),
  constraint ad_serving_decisions_subject_hmac check (subject_hmac ~ '^[0-9a-f]{64}$'),
  constraint ad_serving_decisions_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint ad_serving_decisions_expiry check (
    expires_at > selected_at and expires_at <= selected_at + interval '5 minutes'
  )
);

create index if not exists ad_serving_decisions_expiry_idx
  on private.ad_serving_decisions (expires_at);

create table if not exists private.ad_events (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references private.ad_serving_decisions(id) on delete restrict,
  campaign_id uuid not null references public.ad_campaigns(id) on delete restrict,
  event_type text not null check (event_type in ('impression', 'open', 'menu_view', 'directions', 'hide', 'report')),
  idempotency_key text not null,
  valid boolean not null,
  invalid_reason text,
  server_time timestamptz not null default clock_timestamp(),
  constraint ad_events_idempotency_length check (char_length(idempotency_key) between 16 and 128),
  constraint ad_events_validity check (
    (valid and invalid_reason is null)
    or (not valid and invalid_reason is not null and char_length(invalid_reason) between 1 and 120)
  ),
  unique (decision_id, event_type),
  unique (decision_id, idempotency_key)
);

create index if not exists ad_events_campaign_time_idx
  on private.ad_events (campaign_id, server_time);

create table if not exists private.ad_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique references private.ad_serving_decisions(id) on delete restrict,
  campaign_id uuid not null references public.ad_campaigns(id) on delete restrict,
  amount_minor integer not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  state text not null default 'held' check (state in ('held', 'consumed', 'released')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint ad_budget_reservations_expiry check (
    expires_at > created_at and expires_at <= created_at + interval '5 minutes'
  )
);

create index if not exists ad_budget_reservations_active_idx
  on private.ad_budget_reservations (campaign_id, expires_at) where state = 'held';

create table if not exists private.billing_ledger (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  campaign_id uuid references public.ad_campaigns(id) on delete restrict,
  entry_kind text not null check (entry_kind in ('debit', 'credit')),
  amount_minor integer not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  source_type text not null check (source_type in ('sponsored_open', 'manual_credit')),
  source_id uuid not null,
  reverses_entry_id uuid references private.billing_ledger(id) on delete restrict,
  effective_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  constraint billing_ledger_source_unique unique (source_type, source_id),
  constraint billing_ledger_reversal check (
    (entry_kind = 'debit' and reverses_entry_id is null)
    or (entry_kind = 'credit' and reverses_entry_id is not null)
  )
);

create index if not exists billing_ledger_campaign_time_idx
  on private.billing_ledger (campaign_id, effective_at);

revoke all on table
  public.pricing_versions,
  public.ad_campaigns,
  public.ad_targets,
  public.ad_creatives,
  public.ad_campaign_daily_rollups,
  private.ad_runtime_config,
  private.ad_request_buckets,
  private.ad_serving_decisions,
  private.ad_events,
  private.ad_budget_reservations,
  private.billing_ledger
  from public, anon, authenticated, service_role;

alter table public.pricing_versions enable row level security;
alter table public.ad_campaigns enable row level security;
alter table public.ad_targets enable row level security;
alter table public.ad_creatives enable row level security;
alter table public.ad_campaign_daily_rollups enable row level security;

grant select on table
  public.pricing_versions,
  public.ad_campaigns,
  public.ad_targets,
  public.ad_creatives,
  public.ad_campaign_daily_rollups
  to authenticated;

drop policy if exists "members read campaign pricing" on public.pricing_versions;
create policy "members read campaign pricing" on public.pricing_versions
  for select to authenticated
  using (
    private.has_aal2()
    and exists (
      select 1
      from public.ad_campaigns campaign
      where campaign.pricing_version_id = pricing_versions.id
        and private.is_business_member(campaign.business_id, auth.uid())
    )
  );

drop policy if exists "members read campaigns" on public.ad_campaigns;
create policy "members read campaigns" on public.ad_campaigns
  for select to authenticated
  using (private.has_aal2() and private.is_business_member(business_id, auth.uid()));

drop policy if exists "members read campaign targets" on public.ad_targets;
create policy "members read campaign targets" on public.ad_targets
  for select to authenticated
  using (
    private.has_aal2()
    and exists (
      select 1 from public.ad_campaigns campaign
      where campaign.id = ad_targets.campaign_id
        and private.is_business_member(campaign.business_id, auth.uid())
    )
  );

drop policy if exists "members read campaign creatives" on public.ad_creatives;
create policy "members read campaign creatives" on public.ad_creatives
  for select to authenticated
  using (private.has_aal2() and private.is_business_member(business_id, auth.uid()));

drop policy if exists "members read campaign rollups" on public.ad_campaign_daily_rollups;
create policy "members read campaign rollups" on public.ad_campaign_daily_rollups
  for select to authenticated
  using (
    private.has_aal2()
    and exists (
      select 1 from public.ad_campaigns campaign
      where campaign.id = ad_campaign_daily_rollups.campaign_id
        and private.is_business_member(campaign.business_id, auth.uid())
    )
  );

create or replace function private.ad_hmac_hex(payload text, secret bytea)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  extension_schema text;
  output text;
begin
  select namespace.nspname into strict extension_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  execute pg_catalog.format(
    'select pg_catalog.encode(%I.hmac(pg_catalog.convert_to($1, ''UTF8''), $2, ''sha256''), ''hex'')',
    extension_schema
  ) into output using payload, secret;
  return output;
end;
$$;

create or replace function private.ad_sha256_hex(payload text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  extension_schema text;
  output text;
begin
  select namespace.nspname into strict extension_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  execute pg_catalog.format(
    'select pg_catalog.encode(%I.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')',
    extension_schema
  ) into output using payload;
  return output;
end;
$$;

revoke all on function private.ad_hmac_hex(text, bytea)
  from public, anon, authenticated, service_role;
revoke all on function private.ad_sha256_hex(text)
  from public, anon, authenticated, service_role;

create or replace function private.prevent_billing_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'BILLING_LEDGER_APPEND_ONLY';
end;
$$;

revoke all on function private.prevent_billing_ledger_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists billing_ledger_append_only on private.billing_ledger;
create trigger billing_ledger_append_only
before update or delete on private.billing_ledger
for each row execute function private.prevent_billing_ledger_mutation();

create or replace function private.enforce_pricing_version_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'PRICING_VERSION_IMMUTABLE';
  end if;
  if old.state in ('approved', 'retired') and not (
    old.state = 'approved'
    and new.state = 'retired'
    and new.id = old.id
    and new.version = old.version
    and new.region_code = old.region_code
    and new.currency = old.currency
    and new.click_floor_minor = old.click_floor_minor
    and new.click_ceiling_minor = old.click_ceiling_minor
    and new.effective_at = old.effective_at
    and new.expires_at is not distinct from old.expires_at
    and new.approval_reference = old.approval_reference
    and new.approved_at = old.approved_at
    and new.created_at = old.created_at
  ) then
    raise exception using errcode = '55000', message = 'PRICING_VERSION_IMMUTABLE';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_pricing_version_immutability()
  from public, anon, authenticated, service_role;

drop trigger if exists pricing_versions_immutable on public.pricing_versions;
create trigger pricing_versions_immutable
before update or delete on public.pricing_versions
for each row execute function private.enforce_pricing_version_immutability();

create or replace function public.select_sponsored_placement(
  target_surface text,
  search_lat double precision,
  search_lng double precision,
  search_radius_meters integer,
  requested_kinds public.business_kind[],
  organic_filter_hash text,
  subject_hmac text,
  target_account_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  now_value timestamptz := pg_catalog.clock_timestamp();
  bucket_start timestamptz;
  accepted_count integer;
  config private.ad_runtime_config%rowtype;
  selected_campaign public.ad_campaigns%rowtype;
  selected_business_id uuid;
  selected_reason text;
  decision_id uuid := gen_random_uuid();
  expiry_value timestamptz;
  token_payload text;
  token_value text;
  spent_lifetime bigint;
  spent_today bigint;
  held_total bigint;
begin
  if target_surface not in ('discover', 'map')
    or search_lat is null or search_lat not between -90 and 90
    or search_lng is null or search_lng not between -180 and 180
    or search_radius_meters is null or search_radius_meters not between 500 and 80467
    or requested_kinds is null or cardinality(requested_kinds) not between 1 and 5
    or organic_filter_hash is null or organic_filter_hash !~ '^[0-9a-f]{64}$'
    or subject_hmac is null or subject_hmac !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_SPONSORED_CONTEXT';
  end if;

  select * into config from private.ad_runtime_config where singleton;
  if not config.enabled then
    return null;
  end if;

  bucket_start := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', now_value) / 60) * 60
  );
  insert into private.ad_request_buckets (subject_hmac, bucket_started_at, request_count)
  values (subject_hmac, bucket_start, 1)
  on conflict (subject_hmac, bucket_started_at)
  do update set request_count = private.ad_request_buckets.request_count + 1
    where private.ad_request_buckets.request_count < 60
  returning request_count into accepted_count;
  if accepted_count is null then
    raise exception using errcode = 'P0001', message = 'SPONSORED_RATE_LIMITED';
  end if;

  select campaign, business.id,
    case
      when business.kind = 'food_truck' then 'matches_category'
      else 'near_you'
    end
  into selected_campaign, selected_business_id, selected_reason
  from public.ad_campaigns campaign
  join public.pricing_versions pricing on pricing.id = campaign.pricing_version_id
  join public.ad_targets target on target.campaign_id = campaign.id
  join public.ad_creatives creative
    on creative.campaign_id = campaign.id
   and creative.business_id = campaign.business_id
   and creative.moderation = 'approved'
  join public.businesses business on business.id = campaign.business_id
  where campaign.state = 'active'
    and campaign.starts_at <= now_value
    and campaign.ends_at > now_value
    and campaign.currency = pricing.currency
    and campaign.bid_cap_minor between pricing.click_floor_minor and pricing.click_ceiling_minor
    and pricing.state = 'approved'
    and pricing.effective_at <= now_value
    and (pricing.expires_at is null or pricing.expires_at > now_value)
    and business.verification = 'verified'
    and private.is_business_publicly_eligible(business.id)
    and business.kind = any(target.business_kinds)
    and business.kind = any(requested_kinds)
    and (
      cardinality(target.cuisine_labels) = 0
      or business.cuisine_labels && target.cuisine_labels
    )
    and extract(dow from now_value at time zone business.timezone)::smallint = any(target.weekdays)
    and (
      target.local_starts_at is null
      or case
        when target.local_starts_at <= target.local_ends_at then
          (now_value at time zone business.timezone)::time >= target.local_starts_at
          and (now_value at time zone business.timezone)::time < target.local_ends_at
        else
          (now_value at time zone business.timezone)::time >= target.local_starts_at
          or (now_value at time zone business.timezone)::time < target.local_ends_at
      end
    )
    and public.st_dwithin(
      target.center,
      public.st_setsrid(public.st_makepoint(search_lng, search_lat), 4326)::public.geography,
      target.radius_meters
    )
    and exists (
      select 1
      from public.business_locations location
      where location.business_id = business.id
        and location.publication_state = 'published'
        and location.point is not null
        and public.st_dwithin(
          location.point,
          public.st_setsrid(public.st_makepoint(search_lng, search_lat), 4326)::public.geography,
          search_radius_meters
        )
    )
    and (
      creative.media_asset_id is null
      or exists (
        select 1 from public.media_assets media
        where media.id = creative.media_asset_id
          and media.business_id = business.id
          and media.quarantine_state = 'clean'
          and media.moderation = 'approved'
          and media.processed_storage_path is not null
      )
    )
    and (
      target_account_id is null
      or not private.is_business_member(business.id, target_account_id)
    )
    and campaign.bid_cap_minor <= campaign.lifetime_budget_minor - (
      coalesce((
        select sum(case ledger.entry_kind when 'debit' then ledger.amount_minor else -ledger.amount_minor end)
        from private.billing_ledger ledger
        where ledger.campaign_id = campaign.id
      ), 0)
      + coalesce((
        select sum(reservation.amount_minor)
        from private.ad_budget_reservations reservation
        where reservation.campaign_id = campaign.id
          and reservation.state = 'held'
          and reservation.expires_at > now_value
      ), 0)
    )
    and campaign.bid_cap_minor <= campaign.daily_budget_minor - (
      coalesce((
        select sum(case ledger.entry_kind when 'debit' then ledger.amount_minor else -ledger.amount_minor end)
        from private.billing_ledger ledger
        where ledger.campaign_id = campaign.id
          and ledger.effective_at >= pg_catalog.date_trunc('day', now_value)
      ), 0)
      + coalesce((
        select sum(reservation.amount_minor)
        from private.ad_budget_reservations reservation
        where reservation.campaign_id = campaign.id
          and reservation.state = 'held'
          and reservation.expires_at > now_value
      ), 0)
    )
  order by campaign.bid_cap_minor desc,
    pg_catalog.md5(organic_filter_hash || campaign.public_id::text)
  limit 1
  for update of campaign skip locked;

  if selected_campaign.id is null then
    return null;
  end if;

  -- Recompute the financial snapshot while the campaign row lock is held.
  select
    coalesce(sum(case entry_kind when 'debit' then amount_minor else -amount_minor end), 0),
    coalesce(sum(case when effective_at >= pg_catalog.date_trunc('day', now_value)
      then case entry_kind when 'debit' then amount_minor else -amount_minor end else 0 end), 0)
  into spent_lifetime, spent_today
  from private.billing_ledger
  where campaign_id = selected_campaign.id;

  select coalesce(sum(amount_minor), 0) into held_total
  from private.ad_budget_reservations
  where campaign_id = selected_campaign.id
    and state = 'held'
    and expires_at > now_value;

  if selected_campaign.bid_cap_minor > selected_campaign.lifetime_budget_minor - spent_lifetime - held_total
    or selected_campaign.bid_cap_minor > selected_campaign.daily_budget_minor - spent_today - held_total
  then
    return null;
  end if;

  expiry_value := now_value + interval '5 minutes';
  token_payload := decision_id::text || '.' ||
    pg_catalog.floor(pg_catalog.date_part('epoch', expiry_value))::bigint::text;
  token_value := token_payload || '.' || private.ad_hmac_hex(token_payload, config.token_secret);

  insert into private.ad_serving_decisions (
    id, campaign_id, business_id, surface, organic_filter_hash, subject_hmac,
    reason_category, billing_model, reserved_minor, currency, shadow,
    selected_at, expires_at, token_hash
  ) values (
    decision_id, selected_campaign.id, selected_business_id, target_surface,
    organic_filter_hash, subject_hmac, selected_reason,
    selected_campaign.billing_model, selected_campaign.bid_cap_minor,
    selected_campaign.currency,
    config.shadow_only or selected_campaign.billing_model = 'shadow',
    now_value, expiry_value, private.ad_sha256_hex(token_value)
  );

  insert into private.ad_budget_reservations (
    decision_id, campaign_id, amount_minor, currency, state, expires_at,
    created_at, updated_at
  ) values (
    decision_id, selected_campaign.id, selected_campaign.bid_cap_minor,
    selected_campaign.currency, 'held', expiry_value, now_value, now_value
  );

  insert into private.ad_events (
    decision_id, campaign_id, event_type, idempotency_key, valid, server_time
  ) values (
    decision_id, selected_campaign.id, 'impression',
    'server:impression:' || decision_id::text, true, now_value
  );

  return pg_catalog.jsonb_build_object(
    'business_id', selected_business_id,
    'placement_id', decision_id,
    'disclosure', 'Sponsored ad',
    'reason', case selected_reason
      when 'matches_category' then 'Matches your food-truck search'
      when 'open_nearby' then 'Open near you'
      else 'Near your selected area'
    end,
    'placement_token', token_value,
    'expires_at', expiry_value
  );
end;
$$;

revoke all on function public.select_sponsored_placement(
  text, double precision, double precision, integer,
  public.business_kind[], text, text, uuid
) from public, anon, authenticated;
grant execute on function public.select_sponsored_placement(
  text, double precision, double precision, integer,
  public.business_kind[], text, text, uuid
) to service_role;

create or replace function public.record_sponsored_interaction(
  placement_token text,
  interaction_type text,
  idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  now_value timestamptz := pg_catalog.clock_timestamp();
  decision private.ad_serving_decisions%rowtype;
  config private.ad_runtime_config%rowtype;
  event_id uuid;
  existing_event boolean := false;
  event_valid boolean := true;
  invalid_reason_value text;
  billed boolean := false;
begin
  if placement_token is null
    or char_length(placement_token) not between 110 and 180
    or placement_token !~ '^[0-9a-f-]{36}\.[0-9]{10}\.[0-9a-f]{64}$'
    or interaction_type not in ('open', 'menu_view', 'directions', 'hide', 'report')
    or idempotency_key is null
    or idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_SPONSORED_INTERACTION';
  end if;

  select * into decision
  from private.ad_serving_decisions
  where token_hash = private.ad_sha256_hex(placement_token)
  for update;

  if decision.id is null or decision.expires_at <= now_value then
    raise exception using errcode = '22023', message = 'SPONSORED_TOKEN_EXPIRED';
  end if;

  select * into config from private.ad_runtime_config where singleton;
  if not config.enabled then
    event_valid := false;
    invalid_reason_value := 'runtime_disabled';
  end if;

  if event_valid and interaction_type = 'open' and not exists (
    select 1
    from public.ad_campaigns campaign
    where campaign.id = decision.campaign_id
      and campaign.state = 'active'
      and campaign.starts_at <= now_value
      and campaign.ends_at > now_value
      and private.is_business_publicly_eligible(campaign.business_id)
  ) then
    event_valid := false;
    invalid_reason_value := 'campaign_ineligible';
  end if;

  insert into private.ad_events (
    decision_id, campaign_id, event_type, idempotency_key,
    valid, invalid_reason, server_time
  ) values (
    decision.id, decision.campaign_id, interaction_type, idempotency_key,
    event_valid, invalid_reason_value, now_value
  )
  on conflict (decision_id, event_type) do nothing
  returning id into event_id;

  if event_id is null then
    existing_event := true;
    select id, valid into event_id, event_valid
    from private.ad_events
    where decision_id = decision.id and event_type = interaction_type;
  elsif interaction_type = 'open' then
    if event_valid and not decision.shadow and not config.shadow_only then
      insert into private.billing_ledger (
        business_id, campaign_id, entry_kind, amount_minor, currency,
        source_type, source_id, metadata, effective_at
      ) values (
        decision.business_id, decision.campaign_id, 'debit',
        decision.reserved_minor, decision.currency,
        'sponsored_open', event_id,
        pg_catalog.jsonb_build_object('decision_id', decision.id), now_value
      )
      on conflict (source_type, source_id) do nothing;
      billed := found;
      update private.ad_budget_reservations
      set state = 'consumed', updated_at = now_value
      where decision_id = decision.id and state = 'held';
    else
      update private.ad_budget_reservations
      set state = 'released', updated_at = now_value
      where decision_id = decision.id and state = 'held';
    end if;
  elsif interaction_type in ('hide', 'report') then
    update private.ad_budget_reservations
    set state = 'released', updated_at = now_value
    where decision_id = decision.id and state = 'held';
  end if;

  if existing_event then
    billed := exists (
      select 1 from private.billing_ledger ledger
      where ledger.source_type = 'sponsored_open' and ledger.source_id = event_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'receipt_id', event_id,
    'accepted', event_valid,
    'duplicate', existing_event,
    'billed', billed
  );
end;
$$;

revoke all on function public.record_sponsored_interaction(text, text, text)
  from public;
grant execute on function public.record_sponsored_interaction(text, text, text)
  to anon, authenticated;

create or replace function public.reconcile_sponsored_reservations(
  result_limit integer default 500
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bounded_limit integer := greatest(1, least(coalesce(result_limit, 500), 2000));
  released_count integer := 0;
  backlog boolean := false;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('spottr:sponsored-reservations', 0)
  ) then
    return pg_catalog.jsonb_build_object(
      'released', 0, 'more_work', true, 'skipped', true
    );
  end if;

  with targets as materialized (
    select reservation.id
    from private.ad_budget_reservations reservation
    where reservation.state = 'held'
      and reservation.expires_at <= pg_catalog.clock_timestamp()
    order by reservation.expires_at, reservation.id
    limit bounded_limit
    for update of reservation skip locked
  )
  update private.ad_budget_reservations reservation
  set state = 'released', updated_at = pg_catalog.clock_timestamp()
  from targets
  where reservation.id = targets.id;

  get diagnostics released_count = row_count;

  select exists (
    select 1 from private.ad_budget_reservations reservation
    where reservation.state = 'held'
      and reservation.expires_at <= pg_catalog.clock_timestamp()
  ) into backlog;

  delete from private.ad_request_buckets bucket
  where bucket.bucket_started_at < pg_catalog.clock_timestamp() - interval '10 minutes';

  return pg_catalog.jsonb_build_object(
    'released', released_count,
    'more_work', backlog,
    'skipped', false
  );
end;
$$;

revoke all on function public.reconcile_sponsored_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.reconcile_sponsored_reservations(integer)
  to service_role;
