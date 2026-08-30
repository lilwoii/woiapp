-- Paid placement selection and viewability are separate phases. Selection
-- returns a short-lived signed candidate without reserving budget or recording
-- an impression. The client acknowledges an actually rendered, filter-eligible
-- placement; that acknowledgement atomically revalidates campaign eligibility,
-- acquires budget, and records the one allowed impression.

alter table private.ad_serving_decisions
  add column selected_public_location_id uuid,
  add column selected_public_latitude double precision,
  add column selected_public_longitude double precision,
  add constraint ad_serving_decisions_public_location_snapshot check (
    (
      selected_public_location_id is null
      and selected_public_latitude is null
      and selected_public_longitude is null
    )
    or (
      selected_public_location_id is not null
      and selected_public_latitude between -90 and 90
      and selected_public_longitude between -180 and 180
    )
  );

alter function public.select_sponsored_placement(
  text, double precision, double precision, integer,
  public.business_kind[], text, text, uuid
) set schema private;

alter function private.select_sponsored_placement(
  text, double precision, double precision, integer,
  public.business_kind[], text, text, uuid
) rename to select_sponsored_placement_pre_render;

revoke all on function private.select_sponsored_placement_pre_render(
  text, double precision, double precision, integer,
  public.business_kind[], text, text, uuid
) from public, anon, authenticated, service_role;

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
  decision_id uuid;
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
    decision_id := (payload->>'placement_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end;
  if decision_id is null then
    raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end if;

  perform 1
  from private.ad_serving_decisions decision
  where decision.id = decision_id
    and decision.token_hash = private.ad_sha256_hex(payload->>'placement_token')
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end if;

  select location.location_id, location.latitude, location.longitude
  into selected_location_id, selected_latitude, selected_longitude
  from public.public_business_locations location
  join private.ad_serving_decisions decision
    on decision.id = decision_id
   and decision.business_id = location.business_id
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
  where decision.id = decision_id;

  delete from private.ad_events event
  where event.decision_id = decision_id
    and event.event_type = 'impression';
  get diagnostics removed_event_count = row_count;

  delete from private.ad_budget_reservations reservation
  where reservation.decision_id = decision_id
    and reservation.state = 'held';
  get diagnostics removed_reservation_count = row_count;

  if removed_event_count <> 1 or removed_reservation_count <> 1 then
    raise exception using errcode = '55000', message = 'SPONSORED_SELECTION_INVALID';
  end if;

  return payload;
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

drop function public.record_sponsored_interaction(text, text, text);

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
    elsif decision.selected_public_location_id is null
      or not exists (
        select 1
        from public.public_business_locations location
        where location.location_id = decision.selected_public_location_id
          and location.business_id = decision.business_id
          and location.latitude = decision.selected_public_latitude
          and location.longitude = decision.selected_public_longitude
      )
    then
      event_valid := false;
      invalid_reason_value := 'location_ineligible';
    end if;

    select * into campaign
    from public.ad_campaigns current_campaign
    where current_campaign.id = decision.campaign_id
    for update;

    if event_valid and (
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
  selector_definition text;
  interaction_definition text;
begin
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.select_sponsored_placement(text,double precision,double precision,integer,public.business_kind[],text,text,uuid)'::regprocedure
  )) into selector_definition;
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.record_sponsored_interaction(text,text,text,text)'::regprocedure
  )) into interaction_definition;

  if position('delete from private.ad_events' in selector_definition) = 0
    or position('delete from private.ad_budget_reservations' in selector_definition) = 0
    or position('interaction_type = ''impression''' in interaction_definition) = 0
    or position('impression_required' in interaction_definition) = 0
    or position('subject_hmac = interaction_subject_hmac' in interaction_definition) = 0
    or position('from public.public_business_locations location' in interaction_definition) = 0
    or position('placement_dismissed' in interaction_definition) = 0
  then
    raise exception 'Sponsored viewability accounting boundary is incomplete';
  end if;
end;
$$;
