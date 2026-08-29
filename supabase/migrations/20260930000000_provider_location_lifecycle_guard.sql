-- Public location projections must apply provider child-source lifecycle at the
-- location boundary. A provider business may remain published while one of its
-- imported locations is missing, stale, or withdrawn; those child rows must not
-- remain discoverable. Rows without a matching provider child source remain
-- eligible so owner-managed/manual locations are preserved.

create index if not exists provider_location_sources_materialized_location_idx
  on private.provider_location_sources (materialized_location_id, source_status);

create or replace function private.is_business_location_publicly_eligible(
  target_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_locations bl
    join public.businesses b on b.id = bl.business_id
    where bl.id = target_location_id
      and bl.publication_state = 'published'
      and private.is_business_publicly_eligible(b.id)
      and (
        b.provenance <> 'licensed_provider'
        or not exists (
          select 1
          from private.provider_location_sources child
          where child.materialized_location_id = bl.id
        )
        or exists (
          select 1
          from private.provider_location_sources active_child
          join private.provider_business_sources active_parent_source
            on active_parent_source.provider_slug = active_child.provider_slug
           and active_parent_source.provider_external_id = active_child.business_external_id
           and active_parent_source.business_id = b.id
          join private.provider_accounts active_account
            on active_account.provider_slug = active_parent_source.provider_slug
          where active_child.materialized_location_id = bl.id
            and active_child.source_status = 'active'
            and active_parent_source.source_status = 'active'
            and active_account.enabled
            and current_date between active_account.license_effective_on
              and active_account.license_expires_on
        )
      )
  );
$$;

revoke all on function private.is_business_location_publicly_eligible(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.is_business_location_publicly_eligible(uuid)
  to anon, authenticated;

create or replace view public.public_business_locations
with (security_barrier = true, security_invoker = false)
as
with redacted as (
  select
    bl.id as location_id,
    bl.business_id,
    case
      when b.kind = 'home_kitchen' or not bl.public_address then 'Approximate area'
      else bl.label
    end as label,
    case
      when b.kind = 'home_kitchen' or not bl.public_address then null
      else bl.address_line
    end as address_line,
    bl.city,
    bl.region,
    case
      when b.kind = 'home_kitchen' or not bl.public_address then null
      else bl.postal_code
    end as postal_code,
    case
      when b.kind = 'home_kitchen' or not bl.public_address or bl.is_approximate then
        public.st_snaptogrid(bl.point::public.geometry, 0.05)
      else bl.point::public.geometry
    end as safe_point,
    (bl.is_approximate or not bl.public_address or b.kind = 'home_kitchen') as is_approximate,
    bl.is_primary
  from public.business_locations bl
  join public.businesses b on b.id = bl.business_id
  where bl.publication_state = 'published'
    and private.is_business_publicly_eligible(bl.business_id)
    and private.is_business_location_publicly_eligible(bl.id)
)
select
  r.location_id,
  r.business_id,
  r.label,
  r.address_line,
  r.city,
  r.region,
  r.postal_code,
  public.st_y(r.safe_point) as latitude,
  public.st_x(r.safe_point) as longitude,
  r.is_approximate,
  r.is_primary
from redacted r;

revoke all privileges on public.public_business_locations
  from public, anon, authenticated;
grant select on public.public_business_locations to anon, authenticated;

create or replace function public.map_food_places(
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
  source_label text
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

  -- ST_SnapToGrid can move each coordinate by at most 0.025 degrees. An
  -- index-backed raw-point prefilter expanded beyond that distance is therefore
  -- complete, while the later safe-point predicate remains the sole membership
  -- decision visible to callers.
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
      b.id as business_id,
      bl.id as location_id,
      b.kind::text as kind,
      b.name,
      b.verification::text as verification,
      b.provenance::text as provenance,
      logo.processed_storage_path as logo_path,
      bl.public_address,
      bl.is_approximate,
      bl.point
    from public.business_locations bl
    join public.businesses b on b.id = bl.business_id
    left join public.media_assets logo
      on logo.id = b.logo_asset_id
     and logo.business_id = b.id
     and logo.quarantine_state = 'clean'
     and logo.moderation = 'approved'
     and logo.processed_storage_path is not null
    where bl.publication_state = 'published'
      and private.is_business_publicly_eligible(b.id)
      and private.is_business_location_publicly_eligible(bl.id)
      and (requested_kinds is null or b.kind::text = any(requested_kinds))
      and (
        (
          candidate_west <= candidate_east
          and public.st_intersects(
            bl.point,
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
              bl.point,
              public.st_makeenvelope(
                candidate_west,
                candidate_south,
                180,
                candidate_north,
                4326
              )::public.geography
            )
            or public.st_intersects(
              bl.point,
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
      and public.st_y(bl.point::public.geometry) between candidate_south and candidate_north
      and (
        (candidate_west <= candidate_east and public.st_x(bl.point::public.geometry) between candidate_west and candidate_east)
        or (candidate_west > candidate_east and (
          public.st_x(bl.point::public.geometry) >= candidate_west
          or public.st_x(bl.point::public.geometry) <= candidate_east
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
      null::text as source_label
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
      end as source_label
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
  -- This materialized pass deliberately references the indexed base geography.
  -- The extra 10 km covers worst-case 0.05-degree privacy snapping before the
  -- exact distance is evaluated against the redacted point.
  coarse_candidates as materialized (
    select
      b.id as business_id,
      b.name,
      b.kind,
      bl.id as location_id,
      case
        when b.kind = 'home_kitchen' or not bl.public_address
          then 'Approximate area'
        else bl.label
      end as location_label,
      bl.city,
      bl.region,
      case
        when b.kind = 'home_kitchen' or not bl.public_address or bl.is_approximate
          then public.st_snaptogrid(bl.point::public.geometry, 0.05)::public.geography
        else bl.point
      end as safe_point,
      (bl.is_approximate or not bl.public_address or b.kind = 'home_kitchen')
        as is_approximate,
      bl.is_primary
    from params p
    join public.business_locations bl
      on public.st_dwithin(bl.point, p.search_point, p.exact_radius + 10000)
    join public.businesses b on b.id = bl.business_id
    where bl.publication_state = 'published'
      and private.is_business_publicly_eligible(b.id)
      and private.is_business_location_publicly_eligible(bl.id)
      and (
        b.kind not in ('food_truck', 'pop_up')
        or bl.id = coalesce(
          (
            select ms.location_id
            from public.mobile_stops ms
            where ms.business_id = b.id
              and ms.state in ('scheduled', 'live')
              and private.is_business_location_publicly_eligible(ms.location_id)
              and now() >= ms.starts_at
              and now() < ms.ends_at
            order by
              case when ms.state = 'live' then 0 else 1 end,
              ms.confirmed_at desc nulls last,
              ms.starts_at desc,
              ms.id
            limit 1
          ),
          (
            select primary_location.id
            from public.business_locations primary_location
            where primary_location.business_id = b.id
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
      public.st_distance(coarse.safe_point, p.search_point) as distance_meters,
      coarse.is_approximate,
      row_number() over (
        partition by coarse.business_id
        order by
          public.st_distance(coarse.safe_point, p.search_point),
          coarse.is_primary desc,
          coarse.location_id
      ) as location_rank
    from coarse_candidates coarse
    cross join params p
    where public.st_dwithin(coarse.safe_point, p.search_point, p.exact_radius)
  ),
  page_candidates as materialized (
    select c.*
    from exact_candidates c
    where c.location_rank = 1
    order by
      case when c.kind = 'food_truck' then 0 else 1 end,
      c.distance_meters,
      c.business_id
    offset least(greatest(coalesce(result_offset, 0), 0), 10000)
    limit least(greatest(coalesce(result_limit, 50), 1), 100) + 1
  )
  select
    c.business_id,
    c.name,
    c.kind,
    c.location_id,
    c.location_label,
    c.city,
    c.region,
    c.latitude,
    c.longitude,
    c.distance_meters,
    c.is_approximate,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 50), 1), 100)
      from page_candidates page_count
    ) as has_more
  from page_candidates c
  order by
    case when c.kind = 'food_truck' then 0 else 1 end,
    c.distance_meters,
    c.business_id
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

create or replace function public.search_businesses(
  search_text text,
  result_limit integer default 25,
  result_offset integer default 0
)
returns table (
  business_id uuid,
  name text,
  kind public.business_kind,
  cuisine_labels text[],
  price_level smallint,
  logo_path text,
  location_id uuid,
  city text,
  region text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  is_approximate boolean,
  review_count integer,
  average_rating numeric,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(
    regexp_replace(btrim(coalesce(search_text, '')), '[[:space:]]+', ' ', 'g')
  );
  escaped_search text;
  substring_pattern text;
  prefix_pattern text;
begin
  if char_length(normalized_search) not between 1 and 120
    or normalized_search ~ '[[:cntrl:]]'
  then
    raise exception using errcode = '22023', message = 'Invalid search text';
  end if;
  escaped_search := replace(
    replace(replace(normalized_search, E'\\', E'\\\\'), '%', E'\\%'),
    '_',
    E'\\_'
  );
  substring_pattern := '%' || escaped_search || '%';
  prefix_pattern := escaped_search || '%';

  return query
  with matched_business_ids as materialized (
    select b.id as business_id
    from public.businesses b
    where char_length(normalized_search) >= 3
      and (
        lower(b.name) like substring_pattern escape E'\\'
        or lower(b.description) like substring_pattern escape E'\\'
        or private.searchable_text_array(b.cuisine_labels)
          like substring_pattern escape E'\\'
      )
    union
    select b.id
    from public.businesses b
    where char_length(normalized_search) < 3
      and lower(b.name) like prefix_pattern escape E'\\'
    union
    select bl.business_id
    from public.business_locations bl
    where bl.publication_state = 'published'
      and private.is_business_location_publicly_eligible(bl.id)
      and (
        (
          char_length(normalized_search) >= 3
          and (
            lower(bl.city) like substring_pattern escape E'\\'
            or lower(bl.region) like substring_pattern escape E'\\'
            or (
              bl.postal_code is not null
              and lower(bl.postal_code) like substring_pattern escape E'\\'
            )
          )
        )
        or (
          char_length(normalized_search) < 3
          and (
            lower(bl.city) like prefix_pattern escape E'\\'
            or lower(bl.region) like prefix_pattern escape E'\\'
            or (
              bl.postal_code is not null
              and lower(bl.postal_code) like prefix_pattern escape E'\\'
            )
          )
        )
      )
  ),
  page_candidates as materialized (
  select
    d.business_id,
    d.name,
    d.kind,
    d.cuisine_labels,
    d.price_level,
    d.logo_path,
    loc.location_id,
    loc.city,
    loc.region,
    loc.postal_code,
    loc.latitude,
    loc.longitude,
    loc.is_approximate,
    agg.review_count,
    agg.average_rating
  from public.public_business_directory d
  join matched_business_ids matched on matched.business_id = d.business_id
  join lateral (
    select pbl.*
    from public.public_business_locations pbl
    where pbl.business_id = d.business_id
    order by
      case
        when lower(coalesce(pbl.postal_code, '')) = normalized_search then 0
        when lower(pbl.city) like substring_pattern escape E'\\' then 1
        when lower(pbl.region) like substring_pattern escape E'\\' then 2
        else 3
      end,
      pbl.is_primary desc,
      pbl.location_id
    limit 1
  ) loc on true
  join public.public_business_review_aggregates agg on agg.business_id = d.business_id
  order by
    case
      when lower(d.name) = normalized_search then 0
      when lower(d.name) like prefix_pattern escape E'\\' then 1
      when lower(coalesce(loc.postal_code, '')) = normalized_search then 2
      when lower(loc.city) like prefix_pattern escape E'\\' then 3
      else 4
    end,
    case when d.kind = 'food_truck' then 0 else 1 end,
    agg.review_count desc,
    d.name,
    d.business_id
  offset least(greatest(coalesce(result_offset, 0), 0), 10000)
  limit least(greatest(coalesce(result_limit, 25), 1), 100) + 1
  )
  select
    page.business_id,
    page.name,
    page.kind,
    page.cuisine_labels,
    page.price_level,
    page.logo_path,
    page.location_id,
    page.city,
    page.region,
    page.postal_code,
    page.latitude,
    page.longitude,
    page.is_approximate,
    page.review_count,
    page.average_rating,
    (
      select count(*) >
        least(greatest(coalesce(result_limit, 25), 1), 100)
      from page_candidates page_count
    ) as has_more
  from page_candidates page
  order by
    case
      when lower(page.name) = normalized_search then 0
      when lower(page.name) like prefix_pattern escape E'\\' then 1
      when lower(coalesce(page.postal_code, '')) = normalized_search then 2
      when lower(page.city) like prefix_pattern escape E'\\' then 3
      else 4
    end,
    case when page.kind = 'food_truck' then 0 else 1 end,
    page.review_count desc,
    page.name,
    page.business_id
  limit least(greatest(coalesce(result_limit, 25), 1), 100);
end;
$$;

revoke all on function public.search_businesses(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.search_businesses(text, integer, integer)
  to service_role;

drop policy if exists "eligible published stops are readable"
  on public.mobile_stops;
create policy "eligible published stops are readable" on public.mobile_stops
  for select to anon, authenticated
  using (
    state in ('scheduled', 'live', 'completed')
    and private.is_business_publicly_eligible(business_id)
    and private.is_published_business_location(location_id, business_id)
    and private.is_business_location_publicly_eligible(location_id)
  );

drop policy if exists "active public business events are readable"
  on public.business_public_events;
create policy "active public business events are readable"
  on public.business_public_events
  for select to anon, authenticated
  using (
    expires_at > now()
    and private.is_business_publicly_eligible(business_id)
    and (
      event_type <> 'mobile_stop'
      or case
        when coalesce(payload->>'location_id', '') ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then private.is_business_location_publicly_eligible(
          (payload->>'location_id')::uuid
        )
        else false
      end
    )
  );

-- Keep this forward migration self-checking: every public location-backed
-- discovery entry point must carry the child-source predicate.
do $$
declare
  view_definition text;
  map_definition text;
  nearby_definition text;
  search_definition text;
  stop_policy_definition text;
  event_policy_definition text;
  normalized_map_definition text;
  final_map_membership_definition text;
begin
  select pg_catalog.pg_get_viewdef('public.public_business_locations'::regclass, true)
    into view_definition;
  select pg_catalog.pg_get_functiondef(
    'public.map_food_places(double precision, double precision, double precision, double precision, integer, text[], integer)'::regprocedure
  ) into map_definition;
  select pg_catalog.pg_get_functiondef(
    'public.nearby_businesses(double precision, double precision, integer, integer, integer)'::regprocedure
  ) into nearby_definition;
  select pg_catalog.pg_get_functiondef(
    'public.search_businesses(text, integer, integer)'::regprocedure
  ) into search_definition;
  select pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
  into stop_policy_definition
  from pg_catalog.pg_policy policy
  where policy.polrelid = 'public.mobile_stops'::regclass
    and policy.polname = 'eligible published stops are readable';
  select pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
  into event_policy_definition
  from pg_catalog.pg_policy policy
  where policy.polrelid = 'public.business_public_events'::regclass
    and policy.polname = 'active public business events are readable';

  normalized_map_definition := pg_catalog.regexp_replace(
    map_definition, '[[:space:]]+', '', 'g'
  );
  final_map_membership_definition := substring(
    map_definition from position('visible as materialized' in map_definition)
  );

  if coalesce(position('is_business_location_publicly_eligible' in view_definition), 0) = 0
    or coalesce(position('is_business_location_publicly_eligible' in map_definition), 0) = 0
    or coalesce(position('is_business_location_publicly_eligible' in nearby_definition), 0) = 0
    or coalesce(position('is_business_location_publicly_eligible' in search_definition), 0) = 0
    or coalesce(position('is_business_location_publicly_eligible' in stop_policy_definition), 0) = 0
    or coalesce(position('is_business_location_publicly_eligible' in event_policy_definition), 0) = 0
    or not pg_catalog.has_function_privilege(
      'anon',
      'private.is_business_location_publicly_eligible(uuid)',
      'execute'
    )
    or not pg_catalog.has_function_privilege(
      'authenticated',
      'private.is_business_location_publicly_eligible(uuid)',
      'execute'
    )
    or position('candidatesasmaterialized' in normalized_map_definition) = 0
    or position('st_intersects(bl.point' in normalized_map_definition) = 0
    or position('redactedasmaterialized' in normalized_map_definition) = 0
    or position(
      'st_intersects(redacted.safe_point::public.geography',
      normalized_map_definition
    ) = 0
    or position('st_y(redacted.safe_point)' in normalized_map_definition) = 0
    or position('st_x(redacted.safe_point)' in normalized_map_definition) = 0
    or position('bl.point' in final_map_membership_definition) > 0
    or pg_catalog.to_regclass('public.business_locations_point_gix') is null
    or position('provenance = ''licensed_provider''' in map_definition) = 0
    or position('verification = ''verified''' in map_definition) = 0
    or position('provenance = ''licensed_provider''' in map_definition)
      > position('verification = ''verified''' in map_definition)
  then
    raise exception 'provider location lifecycle guard is missing from a public discovery projection or provider attribution does not take precedence';
  end if;
end;
$$;
