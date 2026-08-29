-- Viewport predicates must operate on the same privacy-safe coordinate that is
-- returned to callers. Otherwise a tiny series of public bounding boxes can
-- reveal a private location even when its response coordinate is snapped.

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
        when bucketed.verification = 'verified' then 'Owner verified'
        when bucketed.provenance = 'licensed_provider' then 'Licensed provider'
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

do $map_redacted_viewport_contract$
declare
  function_definition text;
  normalized_definition text;
  final_membership_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.map_food_places(double precision, double precision, double precision, double precision, integer, text[], integer)'::regprocedure
  ) into function_definition;
  normalized_definition := pg_catalog.regexp_replace(
    function_definition, '[[:space:]]+', '', 'g'
  );
  final_membership_definition := substring(
    function_definition from position('visible as materialized' in function_definition)
  );

  if position('candidatesasmaterialized' in normalized_definition) = 0
    or position('st_intersects(bl.point' in normalized_definition) = 0
    or position('redactedasmaterialized' in normalized_definition) = 0
    or position('st_intersects(redacted.safe_point::public.geography' in normalized_definition) = 0
    or position('st_y(redacted.safe_point)' in normalized_definition) = 0
    or position('st_x(redacted.safe_point)' in normalized_definition) = 0
    or position('bl.point' in final_membership_definition) > 0
  then
    raise exception 'map_food_places must prefilter with the spatial index and decide membership using only privacy-safe coordinates';
  end if;
end;
$map_redacted_viewport_contract$;
