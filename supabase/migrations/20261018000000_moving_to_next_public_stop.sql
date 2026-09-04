-- A truck may announce that it is between stops, but Spottr never tracks or
-- publishes the vehicle's live coordinates. The public state exists only while
-- an AAL2 owner/manager assertion is backed by the next approved exact public
-- stop. Home kitchens, approximate locations, and private pickup addresses are
-- structurally excluded.

create or replace function private.has_next_public_food_truck_stop(
  target_business_id uuid,
  target_after timestamptz,
  latest_start timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_business_id is not null
    and target_after is not null
    and latest_start is not null
    and latest_start > target_after
    and exists (
      select 1
      from public.businesses business
      where business.id = target_business_id
        and business.kind = 'food_truck'
        and business.state = 'published'
        and private.is_business_publicly_eligible(business.id)
    )
    and not exists (
      select 1
      from public.mobile_stops active_stop
      where active_stop.business_id = target_business_id
        and active_stop.state in ('scheduled', 'live')
        and active_stop.starts_at <= target_after
        and active_stop.ends_at > target_after
    )
    and exists (
      select 1
      from public.mobile_stops stop
      join public.business_locations location
        on location.id = stop.location_id
       and location.business_id = stop.business_id
      where stop.business_id = target_business_id
        and stop.state in ('scheduled', 'live')
        and stop.confirmed_at is not null
        and stop.starts_at > target_after
        and stop.starts_at <= latest_start
        and location.publication_state = 'published'
        and location.public_address
        and not location.is_approximate
        and location.address_line is not null
        and btrim(location.address_line) <> ''
        and private.is_business_location_publicly_eligible(location.id)
    );
$$;

revoke all on function private.has_next_public_food_truck_stop(
  uuid,
  timestamptz,
  timestamptz
) from public, anon, authenticated, service_role;

create or replace view public.public_business_mobile_service
with (security_barrier = true, security_invoker = false)
as
select
  business.id as business_id,
  'moving_to_next_location'::text as mobility_state,
  next_stop.location_id as next_stop_location_id,
  next_stop.starts_at as next_stop_starts_at,
  next_stop.ends_at as next_stop_ends_at,
  next_stop.label as next_stop_label,
  next_stop.address_line as next_stop_address_line,
  next_stop.city as next_stop_city,
  next_stop.region as next_stop_region,
  next_stop.postal_code as next_stop_postal_code,
  public.st_y(next_stop.point::public.geometry) as latitude,
  public.st_x(next_stop.point::public.geometry) as longitude,
  false as is_approximate
from public.businesses business
join public.business_live_status live_status
  on live_status.business_id = business.id
 and live_status.status = 'moving_soon'
 and live_status.expires_at > now()
join lateral (
  select
    stop.location_id,
    stop.starts_at,
    stop.ends_at,
    location.label,
    location.address_line,
    location.city,
    location.region,
    location.postal_code,
    location.point
  from public.mobile_stops stop
  join public.business_locations location
    on location.id = stop.location_id
   and location.business_id = stop.business_id
  where stop.business_id = business.id
    and stop.state in ('scheduled', 'live')
    and stop.confirmed_at is not null
    and stop.starts_at > now()
    and stop.starts_at <= least(live_status.expires_at, now() + interval '12 hours')
    and location.publication_state = 'published'
    and location.public_address
    and not location.is_approximate
    and location.address_line is not null
    and btrim(location.address_line) <> ''
    and private.is_business_location_publicly_eligible(location.id)
  order by stop.starts_at, stop.confirmed_at desc, stop.id
  limit 1
) next_stop on true
where business.kind = 'food_truck'
  and business.state = 'published'
  and private.is_business_publicly_eligible(business.id)
  and not exists (
    select 1
    from public.mobile_stops active_stop
    where active_stop.business_id = business.id
      and active_stop.state in ('scheduled', 'live')
      and active_stop.starts_at <= now()
      and active_stop.ends_at > now()
  );

revoke all privileges on public.public_business_mobile_service
  from public, anon, authenticated;
grant select on public.public_business_mobile_service to anon, authenticated;

create or replace view public.public_business_live_status
with (security_barrier = true, security_invoker = false)
as
select
  live_status.business_id,
  live_status.status,
  live_status.confirmed_at,
  live_status.expires_at,
  live_status.updated_at
from public.business_live_status live_status
where live_status.expires_at > now()
  and private.is_business_publicly_eligible(live_status.business_id)
  and (
    live_status.status <> 'moving_soon'
    or exists (
      select 1
      from public.public_business_mobile_service mobile_service
      where mobile_service.business_id = live_status.business_id
    )
  );

revoke all privileges on public.public_business_live_status
  from public, anon, authenticated;
grant select on public.public_business_live_status to anon, authenticated;

create or replace function private.business_effective_status(
  target_business_id uuid,
  target_timezone text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  manual_status public.live_business_status;
  target_kind public.business_kind;
  local_timestamp timestamp;
  local_date date;
  local_time time;
  local_weekday smallint;
  previous_date date;
  previous_weekday smallint;
  schedule_opens time;
  schedule_closes time;
  schedule_closed boolean;
  previous_opens time;
  previous_closes time;
  previous_closed boolean;
begin
  select business.kind
  into target_kind
  from public.businesses business
  where business.id = target_business_id;

  select live_status.status
  into manual_status
  from public.business_live_status live_status
  where live_status.business_id = target_business_id
    and live_status.expires_at > now();

  if manual_status = 'moving_soon'
    and not private.has_next_public_food_truck_stop(
      target_business_id,
      now(),
      now() + interval '12 hours'
    )
  then
    manual_status := null;
  end if;

  if manual_status is not null then
    return manual_status::text;
  end if;

  if target_kind in ('food_truck', 'pop_up') then
    if exists (
      select 1
      from public.mobile_stops stop
      where stop.business_id = target_business_id
        and stop.state in ('scheduled', 'live')
        and now() >= stop.starts_at
        and now() < stop.ends_at
        and private.is_business_location_publicly_eligible(stop.location_id)
    ) then
      return 'open';
    end if;
    if exists (
      select 1
      from public.mobile_stops stop
      where stop.business_id = target_business_id
        and stop.state = 'scheduled'
        and stop.starts_at > now()
        and stop.starts_at <= now() + interval '60 minutes'
        and private.is_business_location_publicly_eligible(stop.location_id)
    ) then
      return 'opening_soon';
    end if;
  end if;

  local_timestamp := now() at time zone target_timezone;
  local_date := local_timestamp::date;
  local_time := local_timestamp::time;
  local_weekday := extract(dow from local_timestamp)::smallint;
  previous_date := local_date - 1;
  previous_weekday := ((local_weekday + 6) % 7)::smallint;

  select special.opens_at, special.closes_at, special.is_closed
  into schedule_opens, schedule_closes, schedule_closed
  from public.special_hours special
  where special.business_id = target_business_id
    and special.service_date = local_date;

  if not found then
    select weekly.opens_at, weekly.closes_at, weekly.is_closed
    into schedule_opens, schedule_closes, schedule_closed
    from public.weekly_hours weekly
    where weekly.business_id = target_business_id
      and weekly.weekday = local_weekday;
  end if;

  if coalesce(schedule_closed, false) then
    return 'closed';
  end if;
  if schedule_opens is not null
    and schedule_closes is not null
    and (
      (schedule_opens < schedule_closes and local_time >= schedule_opens and local_time < schedule_closes)
      or (schedule_opens > schedule_closes and local_time >= schedule_opens)
      or schedule_opens = schedule_closes
    )
  then
    return 'open';
  end if;

  select special.opens_at, special.closes_at, special.is_closed
  into previous_opens, previous_closes, previous_closed
  from public.special_hours special
  where special.business_id = target_business_id
    and special.service_date = previous_date;

  if not found then
    select weekly.opens_at, weekly.closes_at, weekly.is_closed
    into previous_opens, previous_closes, previous_closed
    from public.weekly_hours weekly
    where weekly.business_id = target_business_id
      and weekly.weekday = previous_weekday;
  end if;

  if not coalesce(previous_closed, true)
    and previous_opens > previous_closes
    and local_time < previous_closes
  then
    return 'open';
  end if;

  if schedule_opens is not null
    and schedule_opens > local_time
    and schedule_opens <= local_time + interval '60 minutes'
  then
    return 'opening_soon';
  end if;

  return case when schedule_closed is null then 'unknown' else 'closed' end;
end;
$$;

create or replace function public.set_business_live_status(
  target_business_id uuid,
  next_status public.live_business_status
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_kind public.business_kind;
begin
  perform private.require_aal2();
  select business.kind
  into target_kind
  from public.businesses business
  where business.id = target_business_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Business not found';
  end if;

  if not private.is_business_member(target_business_id, actor) then
    raise exception using errcode = '42501', message = 'Business membership required';
  end if;

  if next_status = 'moving_soon' then
    if target_kind <> 'food_truck'
      or not private.is_business_member(
        target_business_id,
        actor,
        array['owner', 'manager']::public.member_role[]
      )
    then
      raise exception using errcode = '42501', message = 'Food truck owner or manager role required';
    end if;
    if not private.has_next_public_food_truck_stop(
      target_business_id,
      now(),
      now() + interval '12 hours'
    ) then
      raise exception using errcode = '22023', message = 'MOVING_PUBLIC_STOP_REQUIRED';
    end if;
  end if;

  perform private.set_business_live_status_core(target_business_id, next_status);
end;
$$;

revoke all on function public.set_business_live_status(
  uuid,
  public.live_business_status
) from public, anon, authenticated;
grant execute on function public.set_business_live_status(
  uuid,
  public.live_business_status
) to authenticated;

drop function if exists public.map_food_places(
  double precision,
  double precision,
  double precision,
  double precision,
  integer,
  text[],
  integer
);

create function public.map_food_places(
  west_longitude double precision,
  south_latitude double precision,
  east_longitude double precision,
  north_latitude double precision,
  map_zoom integer default 11,
  requested_kinds text[] default null,
  max_features integer default 1200
)
returns table (
  feature_type text,
  feature_id text,
  place_count bigint,
  latitude double precision,
  longitude double precision,
  category_counts jsonb,
  dominant_kind text,
  business_id uuid,
  location_id uuid,
  business_name text,
  logo_path text,
  source_label text,
  mobility_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  safe_zoom integer := least(greatest(coalesce(map_zoom, 11), 2), 18);
  safe_limit integer := least(greatest(coalesce(max_features, 1200), 1), 2500);
  grid_degrees double precision;
  longitude_span double precision;
  candidate_west double precision;
  candidate_south double precision;
  candidate_east double precision;
  candidate_north double precision;
  redaction_margin constant double precision := 0.026;
begin
  if west_longitude is null
    or east_longitude is null
    or south_latitude is null
    or north_latitude is null
    or west_longitude < -180
    or west_longitude > 180
    or east_longitude < -180
    or east_longitude > 180
    or south_latitude < -85.05112878
    or north_latitude > 85.05112878
    or south_latitude >= north_latitude
  then
    raise exception using errcode = '22023', message = 'INVALID_MAP_VIEWPORT';
  end if;

  longitude_span := case
    when west_longitude <= east_longitude then east_longitude - west_longitude
    else (180 - west_longitude) + (east_longitude + 180)
  end;
  if north_latitude - south_latitude > 12 or longitude_span > 12 then
    raise exception using errcode = '22023', message = 'MAP_VIEWPORT_TOO_LARGE';
  end if;

  candidate_west := west_longitude - redaction_margin;
  if candidate_west < -180 then candidate_west := candidate_west + 360; end if;
  candidate_east := east_longitude + redaction_margin;
  if candidate_east > 180 then candidate_east := candidate_east - 360; end if;
  candidate_south := greatest(-85.05112878, south_latitude - redaction_margin);
  candidate_north := least(85.05112878, north_latitude + redaction_margin);

  if requested_kinds is not null and not (
    requested_kinds <@ array['food_truck', 'restaurant', 'pop_up', 'cafe_bakery', 'home_kitchen']::text[]
  ) then
    raise exception using errcode = '22023', message = 'INVALID_MAP_KINDS';
  end if;

  grid_degrees := greatest(0.00025, 360.0 / power(2.0, safe_zoom + 4));

  return query
  with candidates as materialized (
    select
      business.id as business_id,
      location.id as location_id,
      business.kind::text as kind,
      business.name,
      business.verification::text as verification,
      business.provenance::text as provenance,
      logo.processed_storage_path as logo_path,
      location.public_address,
      location.is_approximate,
      location.point,
      mobile_service.mobility_state
    from public.business_locations location
    join public.businesses business on business.id = location.business_id
    left join public.public_business_mobile_service mobile_service
      on mobile_service.business_id = business.id
     and mobile_service.next_stop_location_id = location.id
    left join public.media_assets logo
      on logo.id = business.logo_asset_id
     and logo.business_id = business.id
     and logo.quarantine_state = 'clean'
     and logo.moderation = 'approved'
     and logo.processed_storage_path is not null
    where location.publication_state = 'published'
      and private.is_business_publicly_eligible(business.id)
      and private.is_business_location_publicly_eligible(location.id)
      and (
        business.kind not in ('food_truck', 'pop_up')
        or location.id = coalesce(
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
            order by
              primary_location.is_primary desc,
              primary_location.id
            limit 1
          )
        )
      )
      and (requested_kinds is null or business.kind::text = any(requested_kinds))
      and (
        (
          candidate_west <= candidate_east
          and public.st_intersects(
            location.point,
            public.st_makeenvelope(
              candidate_west,
              candidate_south,
              candidate_east,
              candidate_north,
              4326
            )::public.geography
          )
        )
        or (
          candidate_west > candidate_east
          and (
            public.st_intersects(
              location.point,
              public.st_makeenvelope(
                candidate_west,
                candidate_south,
                180,
                candidate_north,
                4326
              )::public.geography
            )
            or public.st_intersects(
              location.point,
              public.st_makeenvelope(
                -180,
                candidate_south,
                candidate_east,
                candidate_north,
                4326
              )::public.geography
            )
          )
        )
      )
      and public.st_y(location.point::public.geometry) between candidate_south and candidate_north
      and (
        (candidate_west <= candidate_east and public.st_x(location.point::public.geometry) between candidate_west and candidate_east)
        or (candidate_west > candidate_east and (
          public.st_x(location.point::public.geometry) >= candidate_west
          or public.st_x(location.point::public.geometry) <= candidate_east
        ))
      )
  ),
  redacted as materialized (
    select
      candidates.business_id,
      candidates.location_id,
      candidates.kind,
      candidates.name,
      candidates.verification,
      candidates.provenance,
      candidates.logo_path,
      candidates.mobility_state,
      case
        when candidates.kind = 'home_kitchen'
          or not candidates.public_address
          or candidates.is_approximate
          then public.st_snaptogrid(candidates.point::public.geometry, 0.05)
        else candidates.point::public.geometry
      end as safe_point
    from candidates
  ),
  visible as materialized (
    select redacted.*
    from redacted
    where (
        (
          west_longitude <= east_longitude
          and public.st_intersects(
            redacted.safe_point::public.geography,
            public.st_makeenvelope(
              west_longitude,
              south_latitude,
              east_longitude,
              north_latitude,
              4326
            )::public.geography
          )
        )
        or (
          west_longitude > east_longitude
          and (
            public.st_intersects(
              redacted.safe_point::public.geography,
              public.st_makeenvelope(
                west_longitude,
                south_latitude,
                180,
                north_latitude,
                4326
              )::public.geography
            )
            or public.st_intersects(
              redacted.safe_point::public.geography,
              public.st_makeenvelope(
                -180,
                south_latitude,
                east_longitude,
                north_latitude,
                4326
              )::public.geography
            )
          )
        )
      )
      and public.st_y(redacted.safe_point) between south_latitude and north_latitude
      and (
        (west_longitude <= east_longitude and public.st_x(redacted.safe_point) between west_longitude and east_longitude)
        or (west_longitude > east_longitude and (
          public.st_x(redacted.safe_point) >= west_longitude
          or public.st_x(redacted.safe_point) <= east_longitude
        ))
      )
  ),
  bucketed as (
    select visible.*, public.st_snaptogrid(visible.safe_point, grid_degrees) as grid_point
    from visible
  ),
  category_totals as (
    select grid_point, kind, count(*)::bigint as category_count
    from bucketed
    where safe_zoom < 14
    group by grid_point, kind
  ),
  clusters as (
    select
      'cluster'::text as feature_type,
      'cluster:' || safe_zoom || ':' || md5(public.st_astext(bucketed.grid_point)) as feature_id,
      count(*)::bigint as place_count,
      avg(public.st_y(bucketed.safe_point))::double precision as latitude,
      avg(public.st_x(bucketed.safe_point))::double precision as longitude,
      (
        select jsonb_object_agg(category_totals.kind, category_totals.category_count order by category_totals.kind)
        from category_totals
        where public.st_equals(category_totals.grid_point, bucketed.grid_point)
      ) as category_counts,
      (array_agg(bucketed.kind order by case when bucketed.kind = 'food_truck' then 0 else 1 end, bucketed.kind))[1] as dominant_kind,
      null::uuid as business_id,
      null::uuid as location_id,
      null::text as business_name,
      null::text as logo_path,
      null::text as source_label,
      null::text as mobility_state
    from bucketed
    where safe_zoom < 14
    group by bucketed.grid_point
  ),
  individuals as (
    select
      'place'::text as feature_type,
      'place:' || bucketed.location_id::text as feature_id,
      1::bigint as place_count,
      public.st_y(bucketed.safe_point)::double precision as latitude,
      public.st_x(bucketed.safe_point)::double precision as longitude,
      jsonb_build_object(bucketed.kind, 1) as category_counts,
      bucketed.kind as dominant_kind,
      bucketed.business_id,
      bucketed.location_id,
      bucketed.name as business_name,
      bucketed.logo_path,
      case
        when bucketed.provenance = 'licensed_provider' then 'Licensed provider'
        when bucketed.verification = 'verified' then 'Owner verified'
        when bucketed.provenance = 'community' then 'Community added'
        else 'Owner provided'
      end as source_label,
      bucketed.mobility_state
    from bucketed
    where safe_zoom >= 14
  )
  select features.*
  from (
    select * from clusters
    union all
    select * from individuals
  ) features
  order by case when features.dominant_kind = 'food_truck' then 0 else 1 end,
    features.place_count desc,
    features.feature_id
  limit safe_limit;
end;
$$;

revoke all on function public.map_food_places(
  double precision,
  double precision,
  double precision,
  double precision,
  integer,
  text[],
  integer
) from public, anon, authenticated;
grant execute on function public.map_food_places(
  double precision,
  double precision,
  double precision,
  double precision,
  integer,
  text[],
  integer
) to service_role;

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
        or location.id = coalesce(
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
            order by
              primary_location.is_primary desc,
              primary_location.id
            limit 1
          )
        )
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
      select count(*) >
        least(greatest(coalesce(result_limit, 50), 1), 100)
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
  double precision,
  double precision,
  integer,
  integer,
  integer
) from public, anon, authenticated;
grant execute on function public.nearby_businesses(
  double precision,
  double precision,
  integer,
  integer,
  integer
) to service_role;
