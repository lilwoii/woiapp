-- Spottr global viewport projection.
-- Returns bounded, server-clustered, privacy-safe map features.

drop function if exists public.map_food_places(double precision, double precision, double precision, double precision, integer, text[], integer);

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

  if requested_kinds is not null and not (
    requested_kinds <@ array['food_truck', 'restaurant', 'pop_up', 'cafe_bakery', 'home_kitchen']::text[]
  ) then
    raise exception using errcode = '22023', message = 'INVALID_MAP_KINDS';
  end if;

  grid_degrees := greatest(0.00025, 360.0 / power(2.0, safe_zoom + 4));

  return query
  with visible as materialized (
    select
      b.id as business_id,
      bl.id as location_id,
      b.kind::text as kind,
      b.name,
      b.verification::text as verification,
      b.provenance::text as provenance,
      logo.processed_storage_path as logo_path,
      case
        when b.kind = 'home_kitchen' or not bl.public_address or bl.is_approximate
          then public.st_snaptogrid(bl.point::public.geometry, 0.05)
        else bl.point::public.geometry
      end as safe_point
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
          west_longitude <= east_longitude
          and bl.point && public.st_makeenvelope(west_longitude, south_latitude, east_longitude, north_latitude, 4326)::public.geography
        )
        or (
          west_longitude > east_longitude
          and (
            bl.point && public.st_makeenvelope(west_longitude, south_latitude, 180, north_latitude, 4326)::public.geography
            or bl.point && public.st_makeenvelope(-180, south_latitude, east_longitude, north_latitude, 4326)::public.geography
          )
        )
      )
      and public.st_y(bl.point::public.geometry) between south_latitude and north_latitude
      and (
        (west_longitude <= east_longitude and public.st_x(bl.point::public.geometry) between west_longitude and east_longitude)
        or (west_longitude > east_longitude and (public.st_x(bl.point::public.geometry) >= west_longitude or public.st_x(bl.point::public.geometry) <= east_longitude))
      )
  ),
  bucketed as (
    select v.*, public.st_snaptogrid(v.safe_point, grid_degrees) as grid_point
    from visible v
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
      'cluster:' || safe_zoom || ':' || md5(public.st_astext(b.grid_point)) as feature_id,
      count(*)::bigint as place_count,
      avg(public.st_y(b.safe_point))::double precision as latitude,
      avg(public.st_x(b.safe_point))::double precision as longitude,
      (select jsonb_object_agg(ct.kind, ct.category_count order by ct.kind) from category_totals ct where ct.grid_point = b.grid_point) as category_counts,
      (array_agg(b.kind order by case when b.kind = 'food_truck' then 0 else 1 end, b.kind))[1] as dominant_kind,
      null::uuid as business_id,
      null::uuid as location_id,
      null::text as business_name,
      null::text as logo_path,
      null::text as source_label
    from bucketed b
    where safe_zoom < 14
    group by b.grid_point
  ),
  individuals as (
    select
      'place'::text as feature_type,
      'place:' || b.location_id::text as feature_id,
      1::bigint as place_count,
      public.st_y(b.safe_point)::double precision as latitude,
      public.st_x(b.safe_point)::double precision as longitude,
      jsonb_build_object(b.kind, 1) as category_counts,
      b.kind as dominant_kind,
      b.business_id,
      b.location_id,
      b.name as business_name,
      b.logo_path,
      case
        when b.verification = 'verified' then 'Owner verified'
        when b.provenance = 'provider' then 'Licensed provider'
        when b.provenance = 'community' then 'Community added'
        else 'Owner provided'
      end as source_label
    from bucketed b
    where safe_zoom >= 14
  )
  select features.*
  from (
    select * from clusters
    union all
    select * from individuals
  ) features
  order by case when features.dominant_kind = 'food_truck' then 0 else 1 end, features.place_count desc, features.feature_id
  limit safe_limit;
end;
$$;

revoke all on function public.map_food_places(double precision, double precision, double precision, double precision, integer, text[], integer) from public;
grant execute on function public.map_food_places(double precision, double precision, double precision, double precision, integer, text[], integer) to anon, authenticated;
