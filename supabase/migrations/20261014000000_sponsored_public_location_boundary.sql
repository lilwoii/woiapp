-- Sponsored selection is a public discovery surface. Qualify a campaign only
-- through the same location lifecycle and coordinate-redaction boundary used
-- by organic nearby/map discovery. This prevents a caller from probing a raw
-- private/approximate coordinate through the presence of a sponsored result.
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
  selected_campaign_id uuid;
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
  on conflict on constraint ad_request_buckets_pkey
  do update set request_count = private.ad_request_buckets.request_count + 1
    where private.ad_request_buckets.request_count < 60
  returning request_count into accepted_count;
  if accepted_count is null then
    raise exception using errcode = 'P0001', message = 'SPONSORED_RATE_LIMITED';
  end if;

  select campaign.id, business.id,
    case
      when business.kind = 'food_truck' then 'matches_category'
      else 'near_you'
    end
  into selected_campaign_id, selected_business_id, selected_reason
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
      from public.public_business_locations location
      where location.business_id = business.id
        and public.st_dwithin(
          public.st_setsrid(
            public.st_makepoint(location.longitude, location.latitude),
            4326
          )::public.geography,
          public.st_setsrid(
            public.st_makepoint(search_lng, search_lat),
            4326
          )::public.geography,
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

  if selected_campaign_id is null then
    return null;
  end if;

  select * into selected_campaign
  from public.ad_campaigns
  where id = selected_campaign_id;

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
) from public, anon, authenticated, service_role;
grant execute on function public.select_sponsored_placement(
  text, double precision, double precision, integer,
  public.business_kind[], text, text, uuid
) to service_role;

do $$
declare
  definition text;
begin
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.select_sponsored_placement(text,double precision,double precision,integer,public.business_kind[],text,text,uuid)'::regprocedure
  )) into definition;

  if position('from public.public_business_locations location' in definition) = 0
    or position('public.st_makepoint(location.longitude, location.latitude)' in definition) = 0
    or position('from public.business_locations location' in definition) > 0
  then
    raise exception 'Sponsored selection is not bound to the public redacted location projection';
  end if;
end;
$$;
