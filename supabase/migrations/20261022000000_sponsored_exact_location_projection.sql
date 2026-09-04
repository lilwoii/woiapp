-- Mobile discovery has one effective public branch: the current live stop,
-- the explicitly announced next stop while moving, or the deterministic
-- primary fallback. Sponsorship and nearby discovery must call the same
-- resolver so a historical published truck/pop-up branch can never win.
create or replace function private.effective_mobile_public_location_id(
  target_business_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select stop.location_id
      from public.mobile_stops stop
      where stop.business_id = business.id
        and stop.state in ('scheduled', 'live')
        and private.is_business_location_publicly_eligible(stop.location_id)
        and now() >= stop.starts_at
        and now() < stop.ends_at
      order by
        case when stop.state = 'live' then 0 else 1 end,
        stop.confirmed_at desc nulls last,
        stop.starts_at desc,
        stop.id
      limit 1
    ),
    (
      select moving.next_stop_location_id
      from public.public_business_mobile_service moving
      where moving.business_id = business.id
      limit 1
    ),
    (
      select primary_location.id
      from public.business_locations primary_location
      where primary_location.business_id = business.id
        and primary_location.publication_state = 'published'
        and private.is_business_location_publicly_eligible(primary_location.id)
      order by primary_location.is_primary desc, primary_location.id
      limit 1
    )
  )
  from public.businesses business
  where business.id = target_business_id
    and business.kind in ('food_truck', 'pop_up');
$$;

revoke all on function private.effective_mobile_public_location_id(uuid)
  from public, anon, authenticated, service_role;

-- Preserve the nearby contract and ordering while replacing its duplicated
-- mobile branch predicate with the shared resolver above.
create or replace function public.nearby_businesses(
  search_lat double precision,
  search_lng double precision,
  radius_meters integer default 16093,
  result_limit integer default 50,
  result_offset integer default 0
)
returns table (
  business_id uuid,
  name text,
  kind public.business_kind,
  location_id uuid,
  location_label text,
  city text,
  region text,
  latitude double precision,
  longitude double precision,
  distance_meters double precision,
  is_approximate boolean,
  has_more boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select
      public.st_setsrid(
        public.st_makepoint(search_lng, search_lat),
        4326
      )::public.geography as search_point,
      least(greatest(coalesce(radius_meters, 16093), 500), 80467)::double precision
        as exact_radius
    where search_lat between -90 and 90
      and search_lng between -180 and 180
  ),
  coarse_candidates as materialized (
    select
      business.id as business_id,
      business.name,
      business.kind,
      location.id as location_id,
      case
        when business.kind = 'home_kitchen' or not location.public_address
          then 'Approximate area'
        else location.label
      end as location_label,
      location.city,
      location.region,
      case
        when business.kind = 'home_kitchen' or not location.public_address or location.is_approximate
          then public.st_snaptogrid(location.point::public.geometry, 0.05)::public.geography
        else location.point
      end as safe_point,
      (location.is_approximate or not location.public_address or business.kind = 'home_kitchen')
        as is_approximate,
      location.is_primary
    from params params_row
    join public.business_locations location
      on public.st_dwithin(location.point, params_row.search_point, params_row.exact_radius + 10000)
    join public.businesses business on business.id = location.business_id
    where location.publication_state = 'published'
      and private.is_business_publicly_eligible(business.id)
      and private.is_business_location_publicly_eligible(location.id)
      and (
        business.kind not in ('food_truck', 'pop_up')
        or location.id = private.effective_mobile_public_location_id(business.id)
      )
  ),
  exact_candidates as (
    select
      coarse.business_id,
      coarse.name,
      coarse.kind,
      coarse.location_id,
      coarse.location_label,
      coarse.city,
      coarse.region,
      public.st_y(coarse.safe_point::public.geometry) as latitude,
      public.st_x(coarse.safe_point::public.geometry) as longitude,
      public.st_distance(coarse.safe_point, params_row.search_point) as distance_meters,
      coarse.is_approximate,
      row_number() over (
        partition by coarse.business_id
        order by
          public.st_distance(coarse.safe_point, params_row.search_point),
          coarse.is_primary desc,
          coarse.location_id
      ) as location_rank
    from coarse_candidates coarse
    cross join params params_row
    where public.st_dwithin(coarse.safe_point, params_row.search_point, params_row.exact_radius)
  ),
  page_candidates as materialized (
    select candidate.*
    from exact_candidates candidate
    where candidate.location_rank = 1
    order by
      case when candidate.kind = 'food_truck' then 0 else 1 end,
      candidate.distance_meters,
      candidate.business_id
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select
    candidate.business_id,
    candidate.name,
    candidate.kind,
    candidate.location_id,
    candidate.location_label,
    candidate.city,
    candidate.region,
    candidate.latitude,
    candidate.longitude,
    candidate.distance_meters,
    candidate.is_approximate,
    (
      select count(*) > least(greatest(coalesce(result_limit, 50), 1), 100)
      from page_candidates page_count
    ) as has_more
  from page_candidates candidate
  order by
    case when candidate.kind = 'food_truck' then 0 else 1 end,
    candidate.distance_meters,
    candidate.business_id
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
$$;

revoke all on function public.nearby_businesses(
  double precision, double precision, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.nearby_businesses(
  double precision, double precision, integer, integer, integer
) to service_role;

create or replace function private.is_sponsored_public_location_snapshot_current(
  target_business_id uuid,
  target_location_id uuid,
  target_latitude double precision,
  target_longitude double precision
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_business_id is not null
    and target_location_id is not null
    and target_latitude is not null
    and target_longitude is not null
    and exists (
      select 1
      from public.public_business_locations location
      join public.businesses business on business.id = location.business_id
      where location.location_id = target_location_id
        and location.business_id = target_business_id
        and location.latitude = target_latitude
        and location.longitude = target_longitude
        and (
          business.kind not in ('food_truck', 'pop_up')
          or location.location_id = private.effective_mobile_public_location_id(business.id)
        )
    );
$$;

revoke all on function private.is_sponsored_public_location_snapshot_current(
  uuid, uuid, double precision, double precision
) from public, anon, authenticated, service_role;

-- A sponsored placement represents one exact public branch, not only a
-- business. Keep the existing pre-render budget and viewability lifecycle,
-- but make the deterministic public-location choice part of the signed
-- placement response so every client can render the same audited branch.
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
  payload jsonb;
  selected_decision_id uuid;
  removed_event_count integer := 0;
  removed_reservation_count integer := 0;
  selected_location_id uuid;
  selected_latitude double precision;
  selected_longitude double precision;
begin
  payload := private.select_sponsored_placement_pre_render(
    target_surface,
    search_lat,
    search_lng,
    search_radius_meters,
    requested_kinds,
    organic_filter_hash,
    subject_hmac,
    target_account_id
  );
  if payload is null then
    return null;
  end if;

  begin
    selected_decision_id := (payload->>'placement_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end;
  if selected_decision_id is null then
    raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end if;

  perform 1
  from private.ad_serving_decisions decision
  where decision.id = selected_decision_id
    and decision.token_hash = private.ad_sha256_hex(payload->>'placement_token')
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end if;

  -- The nearest eligible public branch wins. UUID is a stable final
  -- tiebreaker when two redacted points have the same computed distance.
  select location.location_id, location.latitude, location.longitude
  into selected_location_id, selected_latitude, selected_longitude
  from public.public_business_locations location
  join private.ad_serving_decisions decision
    on decision.id = selected_decision_id
   and decision.business_id = location.business_id
  join public.businesses business on business.id = decision.business_id
  where public.st_dwithin(
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
    and (
      business.kind not in ('food_truck', 'pop_up')
      or location.location_id = private.effective_mobile_public_location_id(business.id)
    )
  order by public.st_distance(
    public.st_setsrid(
      public.st_makepoint(location.longitude, location.latitude),
      4326
    )::public.geography,
    public.st_setsrid(
      public.st_makepoint(search_lng, search_lat),
      4326
    )::public.geography
  ), location.location_id
  limit 1;
  if selected_location_id is null then
    raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end if;

  update private.ad_serving_decisions decision
  set selected_public_location_id = selected_location_id,
      selected_public_latitude = selected_latitude,
      selected_public_longitude = selected_longitude
  where decision.id = selected_decision_id;

  -- Selection is still only a short-lived candidate. Preserve the existing
  -- rule that budget and an impression are acquired only after viewability.
  delete from private.ad_events event
  where event.decision_id = selected_decision_id
    and event.event_type = 'impression';
  get diagnostics removed_event_count = row_count;

  delete from private.ad_budget_reservations reservation
  where reservation.decision_id = selected_decision_id
    and reservation.state = 'held';
  get diagnostics removed_reservation_count = row_count;

  if removed_event_count <> 1 or removed_reservation_count <> 1 then
    raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end if;

  return (payload - 'location_id') || pg_catalog.jsonb_build_object(
    'location_id', selected_location_id
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

create or replace function public.record_sponsored_interaction(
  placement_token text,
  interaction_type text,
  idempotency_key text,
  interaction_subject_hmac text
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
  campaign public.ad_campaigns%rowtype;
  event_id uuid;
  reservation_id uuid;
  existing_event boolean := false;
  event_valid boolean := true;
  invalid_reason_value text;
  billed boolean := false;
  spent_lifetime bigint := 0;
  spent_today bigint := 0;
  held_total bigint := 0;
  bucket_start timestamptz;
  accepted_count integer;
begin
  if placement_token is null
    or char_length(placement_token) not between 110 and 180
    or placement_token !~ '^[0-9a-f-]{36}\.[0-9]{10}\.[0-9a-f]{64}$'
    or interaction_type not in ('impression', 'open', 'menu_view', 'directions', 'hide', 'report')
    or idempotency_key is null
    or idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or interaction_subject_hmac is null
    or interaction_subject_hmac !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_SPONSORED_INTERACTION';
  end if;

  bucket_start := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', now_value) / 60) * 60
  );
  insert into private.ad_request_buckets (
    subject_hmac, bucket_started_at, request_count
  ) values (
    interaction_subject_hmac, bucket_start, 1
  )
  on conflict on constraint ad_request_buckets_pkey
  do update set request_count = private.ad_request_buckets.request_count + 1
    where private.ad_request_buckets.request_count < 120
  returning request_count into accepted_count;
  if accepted_count is null then
    raise exception using errcode = 'P0001', message = 'SPONSORED_RATE_LIMITED';
  end if;

  select * into decision
  from private.ad_serving_decisions
  where token_hash = private.ad_sha256_hex(placement_token)
    and subject_hmac = interaction_subject_hmac
  for update;

  if decision.id is null or decision.expires_at <= now_value then
    raise exception using errcode = '22023', message = 'SPONSORED_TOKEN_EXPIRED';
  end if;

  select * into config from private.ad_runtime_config where singleton;

  select event.id, event.valid
  into event_id, event_valid
  from private.ad_events event
  where event.decision_id = decision.id
    and event.event_type = interaction_type;
  if found then
    existing_event := true;
    billed := exists (
      select 1
      from private.billing_ledger ledger
      where ledger.source_type = 'sponsored_open'
        and ledger.source_id = event_id
    );
    return pg_catalog.jsonb_build_object(
      'receipt_id', event_id,
      'accepted', coalesce(event_valid, false) and coalesce(config.enabled, false),
      'duplicate', true,
      'billed', billed
    );
  end if;
  event_id := null;
  event_valid := true;

  if config.enabled is distinct from true then
    event_valid := false;
    invalid_reason_value := 'runtime_disabled';
  end if;

  if interaction_type = 'impression' and event_valid then
    if exists (
      select 1
      from private.ad_events dismissal
      where dismissal.decision_id = decision.id
        and dismissal.event_type in ('hide', 'report')
        and dismissal.valid
    ) then
      event_valid := false;
      invalid_reason_value := 'placement_dismissed';
    end if;

    select * into campaign
    from public.ad_campaigns current_campaign
    where current_campaign.id = decision.campaign_id
    for update;

    perform 1
    from public.businesses target_business
    where target_business.id = decision.business_id
    for update;

    if event_valid and not private.is_sponsored_public_location_snapshot_current(
      decision.business_id,
      decision.selected_public_location_id,
      decision.selected_public_latitude,
      decision.selected_public_longitude
    ) then
      event_valid := false;
      invalid_reason_value := 'location_ineligible';
    elsif event_valid and (
      campaign.id is null
      or campaign.state <> 'active'
      or campaign.starts_at > now_value
      or campaign.ends_at <= now_value
      or campaign.business_id <> decision.business_id
      or campaign.currency <> decision.currency
      or not private.is_business_publicly_eligible(decision.business_id)
    ) then
      event_valid := false;
      invalid_reason_value := 'campaign_ineligible';
    elsif event_valid then
      select
        coalesce(sum(case entry_kind when 'debit' then amount_minor else -amount_minor end), 0),
        coalesce(sum(case when effective_at >= pg_catalog.date_trunc('day', now_value)
          then case entry_kind when 'debit' then amount_minor else -amount_minor end else 0 end), 0)
      into spent_lifetime, spent_today
      from private.billing_ledger
      where campaign_id = campaign.id;

      select coalesce(sum(amount_minor), 0)
      into held_total
      from private.ad_budget_reservations reservation
      where reservation.campaign_id = campaign.id
        and reservation.state = 'held'
        and reservation.expires_at > now_value;

      if decision.reserved_minor > campaign.lifetime_budget_minor - spent_lifetime - held_total
        or decision.reserved_minor > campaign.daily_budget_minor - spent_today - held_total
      then
        event_valid := false;
        invalid_reason_value := 'budget_unavailable';
      else
        insert into private.ad_budget_reservations (
          decision_id, campaign_id, amount_minor, currency, state,
          expires_at, created_at, updated_at
        ) values (
          decision.id, campaign.id, decision.reserved_minor, decision.currency,
          'held', decision.expires_at, now_value, now_value
        )
        returning id into reservation_id;
      end if;
    end if;
  elsif interaction_type in ('open', 'menu_view', 'directions') and event_valid then
    if not exists (
      select 1
      from private.ad_events impression
      join private.ad_budget_reservations reservation
        on reservation.decision_id = impression.decision_id
       and reservation.state = 'held'
       and reservation.expires_at > now_value
      where impression.decision_id = decision.id
        and impression.event_type = 'impression'
        and impression.valid
    ) then
      event_valid := false;
      invalid_reason_value := 'impression_required';
    end if;
    if interaction_type = 'open' and event_valid then
      select * into campaign
      from public.ad_campaigns current_campaign
      where current_campaign.id = decision.campaign_id
      for update;

      perform 1
      from public.businesses target_business
      where target_business.id = decision.business_id
      for update;

      if campaign.id is null
        or campaign.state <> 'active'
        or campaign.starts_at > now_value
        or campaign.ends_at <= now_value
        or campaign.business_id <> decision.business_id
        or campaign.currency <> decision.currency
        or not private.is_business_publicly_eligible(decision.business_id)
      then
        event_valid := false;
        invalid_reason_value := 'campaign_ineligible';
      end if;
    end if;
  end if;

  insert into private.ad_events (
    decision_id, campaign_id, event_type, idempotency_key,
    valid, invalid_reason, server_time
  ) values (
    decision.id, decision.campaign_id, interaction_type, idempotency_key,
    event_valid, invalid_reason_value, now_value
  )
  returning id into event_id;

  if interaction_type = 'open' then
    -- Impression and open are separate requests. Re-read the exact public
    -- branch snapshot at the final billing boundary so a moved, unpublished,
    -- archived, or re-redacted location cannot consume budget.
    if event_valid and not private.is_sponsored_public_location_snapshot_current(
      decision.business_id,
      decision.selected_public_location_id,
      decision.selected_public_latitude,
      decision.selected_public_longitude
    ) then
      event_valid := false;
      invalid_reason_value := 'location_ineligible';
      update private.ad_events
      set valid = false, invalid_reason = invalid_reason_value
      where id = event_id;
    end if;

    if event_valid and not decision.shadow and not config.shadow_only then
      update private.ad_budget_reservations
      set state = 'consumed', updated_at = now_value
      where decision_id = decision.id and state = 'held'
      returning id into reservation_id;
      if reservation_id is null then
        event_valid := false;
        invalid_reason_value := 'reservation_unavailable';
        update private.ad_events
        set valid = false, invalid_reason = invalid_reason_value
        where id = event_id;
      else
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
      end if;
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

  return pg_catalog.jsonb_build_object(
    'receipt_id', event_id,
    'accepted', event_valid,
    'duplicate', existing_event,
    'billed', billed
  );
end;
$$;

revoke all on function public.record_sponsored_interaction(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_sponsored_interaction(text, text, text, text)
  to service_role;

do $$
declare
  definition text;
  nearby_definition text;
  interaction_definition text;
begin
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.select_sponsored_placement(text,double precision,double precision,integer,public.business_kind[],text,text,uuid)'::regprocedure
  )) into definition;
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.nearby_businesses(double precision,double precision,integer,integer,integer)'::regprocedure
  )) into nearby_definition;
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.record_sponsored_interaction(text,text,text,text)'::regprocedure
  )) into interaction_definition;

  if position('from public.public_business_locations location' in definition) = 0
    or position('order by public.st_distance' in definition) = 0
    or position('), location.location_id' in definition) = 0
    or position('selected_public_location_id = selected_location_id' in definition) = 0
    or position('''location_id'', selected_location_id' in definition) = 0
    or position('delete from private.ad_events' in definition) = 0
    or position('delete from private.ad_budget_reservations' in definition) = 0
    or position('private.effective_mobile_public_location_id(business.id)' in definition) = 0
    or position('private.effective_mobile_public_location_id(business.id)' in nearby_definition) = 0
    or position('interaction_type = ''open''' in interaction_definition) = 0
    or (
      char_length(interaction_definition) - char_length(replace(
        interaction_definition,
        'from public.businesses target_business',
        ''
      ))
    ) / char_length('from public.businesses target_business') < 2
    or (
      char_length(interaction_definition) - char_length(replace(
        interaction_definition,
        'private.is_sponsored_public_location_snapshot_current',
        ''
      ))
    ) / char_length('private.is_sponsored_public_location_snapshot_current') < 2
    or position('invalid_reason_value := ''location_ineligible''' in interaction_definition) = 0
    or position('set state = ''released''' in interaction_definition) = 0
  then
    raise exception 'Sponsored exact-location projection boundary is incomplete';
  end if;
end;
$$;
