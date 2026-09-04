import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261018000000_moving_to_next_public_stop.sql",
    import.meta.url,
  ),
);
const edgeContract = await Deno.readTextFile(
  new URL("../functions/public-discovery/contract.ts", import.meta.url),
);
const api = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const mobileService = await Deno.readTextFile(
  new URL("../../lib/mobile-service.ts", import.meta.url),
);
const marketplaceTypes = await Deno.readTextFile(
  new URL("../../types/marketplace.ts", import.meta.url),
);
const mapTypes = await Deno.readTextFile(
  new URL("../../types/map.ts", import.meta.url),
);
const statusPill = await Deno.readTextFile(
  new URL("../../components/status-pill.tsx", import.meta.url),
);
const placeCard = await Deno.readTextFile(
  new URL("../../components/place-card.tsx", import.meta.url),
);
const placeDetail = await Deno.readTextFile(
  new URL("../../app/place/[id].tsx", import.meta.url),
);
const nativeMap = await Deno.readTextFile(
  new URL("../../components/live-map.native.tsx", import.meta.url),
);
const webMap = await Deno.readTextFile(
  new URL("../../components/maplibre-map.web.tsx", import.meta.url),
);
const studio = await Deno.readTextFile(
  new URL("../../app/(tabs)/studio.tsx", import.meta.url),
);
const store = await Deno.readTextFile(
  new URL("../../context/marketplace-store.tsx", import.meta.url),
);

Deno.test("moving state requires explicit AAL2 food-truck owner authority", () => {
  const setter = migration.slice(
    migration.indexOf(
      "create or replace function public.set_business_live_status",
    ),
  );
  assertMatch(setter, /perform private\.require_aal2\(\)/);
  assertMatch(setter, /from public\.businesses business[\s\S]+for update/);
  assertMatch(
    setter,
    /private\.is_business_member\(target_business_id, actor\)/,
  );
  assertMatch(
    setter,
    /array\['owner', 'manager'\]::public\.member_role\[\]/,
  );
  assertMatch(setter, /target_kind <> 'food_truck'/);
  assertMatch(setter, /private\.has_next_public_food_truck_stop/);
  assertMatch(setter, /MOVING_PUBLIC_STOP_REQUIRED/);
  assertMatch(setter, /private\.set_business_live_status_core/);
  assert(
    setter.indexOf("private.is_business_member(target_business_id, actor)") <
      setter.indexOf("private.has_next_public_food_truck_stop"),
  );
});

Deno.test("only a future approved exact public stop can back moving", () => {
  const helper = migration.slice(
    migration.indexOf(
      "create or replace function private.has_next_public_food_truck_stop",
    ),
    migration.indexOf(
      "create or replace view public.public_business_mobile_service",
    ),
  );
  for (
    const predicate of [
      /business\.kind = 'food_truck'/,
      /business\.state = 'published'/,
      /private\.is_business_publicly_eligible/,
      /stop\.state in \('scheduled', 'live'\)/,
      /stop\.confirmed_at is not null/,
      /stop\.starts_at > target_after/,
      /stop\.starts_at <= latest_start/,
      /location\.publication_state = 'published'/,
      /location\.public_address/,
      /not location\.is_approximate/,
      /private\.is_business_location_publicly_eligible/,
    ]
  ) assertMatch(helper, predicate);
  assertMatch(
    helper,
    /not exists \([\s\S]+active_stop\.starts_at <= target_after/,
  );
});

Deno.test("public moving projection exposes destination schedule, never private or live coordinates", () => {
  const view = migration.slice(
    migration.indexOf(
      "create or replace view public.public_business_mobile_service",
    ),
    migration.indexOf(
      "create or replace view public.public_business_live_status",
    ),
  );
  assertMatch(view, /'moving_to_next_location'::text as mobility_state/);
  for (
    const field of [
      "next_stop_location_id",
      "next_stop_starts_at",
      "next_stop_ends_at",
      "next_stop_address_line",
      "next_stop_city",
      "next_stop_region",
      "next_stop_postal_code",
    ]
  ) assert(view.includes(field));
  assertMatch(view, /business\.kind = 'food_truck'/);
  assertMatch(view, /location\.public_address/);
  assertMatch(view, /not location\.is_approximate/);
  assertMatch(view, /not exists \([\s\S]+active_stop/);
  assert(!/vehicle_|current_|gps|heading|speed/i.test(view));
  assertMatch(
    view,
    /revoke all privileges on public\.public_business_mobile_service[\s\S]+grant select on public\.public_business_mobile_service to anon, authenticated/,
  );
});

Deno.test("map and nearby discovery use the next stop before primary fallback", () => {
  for (const functionName of ["map_food_places", "nearby_businesses"]) {
    const start = migration.indexOf(`${functionName}(`);
    const next = migration.indexOf("$$;", start);
    const definition = migration.slice(start, next);
    assertMatch(
      definition,
      /coalesce\([\s\S]+from public\.mobile_stops stop[\s\S]+from public\.public_business_mobile_service moving[\s\S]+from public\.business_locations primary_location/,
    );
    assertMatch(definition, /private\.is_business_location_publicly_eligible/);
  }
  assertMatch(migration, /mobility_state text/);
  assertMatch(migration, /bucketed\.mobility_state/);
  assertMatch(
    migration,
    /revoke all on function public\.map_food_places\([\s\S]+from public, anon, authenticated;[\s\S]+grant execute on function public\.map_food_places\([\s\S]+to service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.nearby_businesses\([\s\S]+from public, anon, authenticated;[\s\S]+grant execute on function public\.nearby_businesses\([\s\S]+to service_role/,
  );
});

Deno.test("marketplace accepts only the narrow public moving projection", () => {
  assertMatch(api, /from\('public_business_mobile_service'\)/);
  assertMatch(api, /movingServiceFromPublicRow/);
  assertMatch(api, /mobility\?\.nextStop\.locationId/);
  assertMatch(api, /rawMobilityState === 'moving_to_next_location'/);
  assertMatch(mobileService, /row\.is_approximate !== false/);
  assertMatch(mobileService, /startsAt\.getTime\(\) <= nowMs/);
  assertMatch(mobileService, /endsAt\.getTime\(\) <= startsAt\.getTime\(\)/);
  assertMatch(
    edgeContract,
    /row\.mobility_state === "moving_to_next_location"/,
  );
  assertMatch(edgeContract, /mobility_state: mobilityState/);
  assertMatch(
    marketplaceTypes,
    /MOVING_TO_NEXT_LOCATION_LABEL = 'Moving to next location'/,
  );
  assertMatch(mapTypes, /mobilityState\?: MovingServiceState\['state'\]/);
});

Deno.test("map, list, detail, and owner controls share the exact moving treatment", () => {
  assertMatch(statusPill, /moving_soon: MOVING_TO_NEXT_LOCATION_LABEL/);
  assertMatch(placeCard, /place\.mobility\.nextStop\.address/);
  assertMatch(placeCard, /place\.mobility\.nextStop\.timeWindow/);
  assertMatch(placeDetail, /place\.mobility\.label/);
  assertMatch(
    placeDetail,
    /Destination schedule only — no live vehicle location is shared\./,
  );
  assertMatch(nativeMap, /MOVING_TO_NEXT_LOCATION_LABEL/);
  assertMatch(nativeMap, /mobilityState === 'moving_to_next_location'/);
  assertMatch(
    nativeMap,
    /Scheduled next-stop destination; no live vehicle location\./,
  );
  assertMatch(webMap, /MOVING_TO_NEXT_LOCATION_LABEL/);
  assertMatch(webMap, /dataset\.mobilityState/);
  assertMatch(
    webMap,
    /Scheduled next-stop destination; not a live vehicle position/,
  );
  assertMatch(studio, /label: 'Moving to next location'/);
  assertMatch(
    studio,
    /action\.id !== 'moving_soon' \|\| place\.category === 'food_truck'/,
  );
  assertMatch(
    store,
    /publicEvent\.event_type === 'live_status'[\s\S]+setMobileMapRevision\(\(current\) => current \+ 1\)/,
  );
});

Deno.test("authoritative inventory cannot inherit stale moving state from cached place details", () => {
  assertMatch(
    nativeMap,
    /const moving = feature\.mobilityState === 'moving_to_next_location';/,
  );
  assert(
    !/feature\.mobilityState === 'moving_to_next_location'\s*\|\|\s*Boolean\(place\?\.mobility\)/.test(
      nativeMap,
    ),
  );
  assertMatch(nativeMap, /moving=\{Boolean\(place\.mobility\)\}/);

  assertMatch(
    webMap,
    /inventoryFeature\.mobilityState === 'moving_to_next_location',/,
  );
  assert(
    !/inventoryFeature\.mobilityState === 'moving_to_next_location'\s*\|\|\s*Boolean\(loadedPlace\?\.mobility\)/.test(
      webMap,
    ),
  );
  assertMatch(
    webMap,
    /markerElement\(feature\.place, false, Boolean\(feature\.place\.mobility\)\)/,
  );
});

Deno.test("clients re-fetch authoritative place and map projections at the earliest moving boundary", () => {
  assertMatch(store, /earliestMovingServiceBoundary\(places\)/);
  assertMatch(
    store,
    /movingServiceBoundary\.startsAtMs - Date\.now\(\)/,
  );
  assertMatch(store, /attempt\.attempts >= 3/);
  assertMatch(
    store,
    /setTimeout\([\s\S]+Math\.min\(delay, 2_147_483_647\)/,
  );
  assertMatch(
    store,
    /requestGuard\.begin\(scopeKey, 'moving-service-boundary'\)/,
  );
  assertMatch(
    store,
    /fetchMarketplacePlaces\(\{[\s\S]+includeBusinessIds: placeIds,[\s\S]+includeDetails: true,[\s\S]+onlyIncludedBusinesses: true/,
  );
  assertMatch(store, /if \(!requestGuard\.isCurrent\(token\)\) return/);
  assertMatch(store, /setMobileMapRevision\(\(current\) => current \+ 1\)/);
  assertMatch(
    store,
    /places: current\.places\.flatMap\([\s\S]+return refreshed \? \[refreshed\] : \[\]/,
  );
  assertMatch(store, /detailOnlyPlaceIds: current\.detailOnlyPlaceIds\.filter/);
});
