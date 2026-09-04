import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260830000000_sponsored_placement_foundation.sql",
    import.meta.url,
  ),
);
const viewabilityMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20261015000000_sponsored_viewability_accounting.sql",
    import.meta.url,
  ),
);
const edge = await Deno.readTextFile(
  new URL("../functions/public-discovery/index.ts", import.meta.url),
);
const marketplace = await Deno.readTextFile(
  new URL("../../lib/marketplace-api.ts", import.meta.url),
);
const marketplaceStore = await Deno.readTextFile(
  new URL("../../context/marketplace-store.tsx", import.meta.url),
);
const discoverScreen = await Deno.readTextFile(
  new URL("../../app/(tabs)/index.tsx", import.meta.url),
);
const placeDetailScreen = await Deno.readTextFile(
  new URL("../../app/place/[id].tsx", import.meta.url),
);
const navigationScreen = await Deno.readTextFile(
  new URL("../../app/navigation/[id].tsx", import.meta.url),
);
const orderScreen = await Deno.readTextFile(
  new URL("../../app/order/[id].tsx", import.meta.url),
);
const discoveryRanking = await Deno.readTextFile(
  new URL("../../lib/discovery-filters.ts", import.meta.url),
);
const releaseWorkflow = await Deno.readTextFile(
  new URL("../../.github/workflows/production-web-release.yml", import.meta.url),
);
const maintenance = await Deno.readTextFile(
  new URL("../../scripts/production-maintenance.mjs", import.meta.url),
);

Deno.test("sponsored foundation is contextual, private, and disabled by default", () => {
  assertMatch(migration, /create table if not exists private\.ad_runtime_config/);
  assertMatch(migration, /enabled boolean not null default false/);
  assertMatch(migration, /shadow_only boolean not null default true/);
  assertMatch(migration, /create table if not exists private\.ad_serving_decisions/);
  assertMatch(migration, /create table if not exists private\.ad_events/);
  assertMatch(migration, /create table if not exists private\.ad_budget_reservations/);
  assertMatch(migration, /create table if not exists private\.billing_ledger/);
  assertMatch(migration, /BILLING_LEDGER_APPEND_ONLY/);
  assertMatch(
    migration,
    /revoke all on table[\s\S]*private\.billing_ledger[\s\S]*from public, anon, authenticated, service_role/,
  );
});
Deno.test("selection is service-only, budget locked, privacy-safe, and organically separate", () => {
  assertMatch(migration, /create or replace function public\.select_sponsored_placement/);
  assertMatch(migration, /for update of campaign skip locked/);
  assertMatch(migration, /private\.is_business_publicly_eligible\(business\.id\)/);
  assertMatch(migration, /business\.verification = 'verified'/);
  assertMatch(migration, /target_account_id is null[\s\S]*not private\.is_business_member/);
  assertMatch(migration, /organic_filter_hash char\(64\)/);
  assert(!migration.includes("raw_ip"));
  assertMatch(
    migration,
    /revoke all on function public\.select_sponsored_placement[\s\S]*from public, anon, authenticated[\s\S]*grant execute on function public\.select_sponsored_placement[\s\S]*to service_role/,
  );
  assert(!discoveryRanking.includes("sponsoredPlacement"));
  assertMatch(edge, /select_sponsored_placement/);
  assertMatch(edge, /Ads must fail closed without taking organic discovery down/);
});

Deno.test("sponsored projection stays out of organic list, ranking, and pagination", () => {
  assertMatch(marketplace, /sponsoredPlace\?: SponsoredPlace/);
  assertMatch(marketplace, /const sponsoredPlace: SponsoredPlace \| undefined/);
  assertMatch(marketplace, /sponsoredInteractionTokenPattern/);
  assertMatch(marketplace, /parseSponsoredPlacementToken/);
  assertMatch(marketplace, /isValidSponsoredPlacementProjection/);
  assertMatch(
    marketplace,
    /sponsoredRow = featureFlags\.sponsoredPlacements && resultOffset === 0/,
  );
  assertMatch(marketplace, /const organicBusinessIds = new Set\(/);
  assertMatch(
    marketplace,
    /const directoryIds = \[[\s\S]*organicBusinessIds[\s\S]*sponsoredBusinessId/,
  );
  assertMatch(
    marketplace,
    /!options\.origin && !options\.onlyIncludedBusinesses[\s\S]*organicBusinessIds\.add/,
  );
  assertMatch(marketplace, /splitSponsoredPlaces\([\s\S]*organicBusinessIds/);
  assertMatch(edge, /operation === "nearby"[\s\S]*result_offset === 0/);

  const placesStart = marketplace.indexOf("const mappedPlaces = displayableBusinesses.map");
  const exactSponsoredStart = marketplace.indexOf(
    "const sponsoredBasePlace",
    placesStart,
  );
  const sponsorStart = marketplace.indexOf(
    "const { places, sponsoredPlace } = splitSponsoredPlaces",
    placesStart,
  );
  assert(
    placesStart >= 0 && exactSponsoredStart > placesStart &&
      sponsorStart > exactSponsoredStart,
  );
  assert(
    !marketplace.slice(placesStart, exactSponsoredStart).includes("sponsoredPlacement"),
    "Organic place mapping must not carry sponsored metadata",
  );

  assertMatch(marketplaceStore, /sponsoredPlace: result\.data\?\.sponsoredPlace/);
  assertMatch(marketplaceStore, /detailOnlyPlaceIds: \[\]/);
  assertMatch(marketplaceStore, /!detailOnlyPlaceIdSet\.has\(place\.id\)/);
  assertMatch(marketplaceStore, /detailOnlyPlaceIds: current\.detailOnlyPlaceIds\.filter/);
  assertMatch(
    marketplaceStore,
    /existingPlaceReady[\s\S]*source === 'discovery'[\s\S]*publicationState === 'published'[\s\S]*detailOnlyPlaceIds: current\.detailOnlyPlaceIds\.filter/,
  );
  assertMatch(marketplaceStore, /candidateSponsoredPlace\?\.sponsoredPlacement\.expiresAt/);
  assertMatch(marketplaceStore, /setSponsoredExpiryTick/);
  assertMatch(placeDetailScreen, /const loadedPlace = places\.find/);
  assertMatch(navigationScreen, /const loadedPlace = places\.find/);
  assertMatch(orderScreen, /const loadedPlace = places\.find/);
  assertMatch(placeDetailScreen, /publicListingRouteUnavailableReason\(loadedPlace\)/);
  assertMatch(navigationScreen, /publicListingRouteUnavailableReason\(loadedPlace\)/);
  assertMatch(orderScreen, /publicListingRouteUnavailableReason\(loadedPlace\)/);
  const refreshTokenStart = marketplaceStore.indexOf(
    "const token = requestGuard.begin(scopeKey, 'directory')",
  );
  const sponsorClear = marketplaceStore.indexOf(
    "sponsoredPlace: undefined",
    refreshTokenStart,
  );
  const priorRefreshWait = marketplaceStore.indexOf(
    "await priorRefresh.request",
    refreshTokenStart,
  );
  assert(
    refreshTokenStart >= 0 && sponsorClear > refreshTokenStart &&
      sponsorClear < priorRefreshWait,
    "A new directory refresh must clear stale sponsorship before waiting on a prior refresh",
  );
  assertMatch(discoverScreen, /sponsoredPlace: sponsoredProjection/);
  assertMatch(discoverScreen, /ensurePlace\(businessId, locationId, 'discovery'\)/);
  assertMatch(discoverScreen, /rankDiscoveryPlaces\(\[sponsoredProjection\]/);
  assertMatch(discoverScreen, /const mappedPlaces = ranked/);
});

Deno.test("interaction receipts are token-bound, idempotent, and never trust client price", () => {
  assertMatch(
    viewabilityMigration,
    /create or replace function public\.record_sponsored_interaction/,
  );
  assertMatch(viewabilityMigration, /token_hash = private\.ad_sha256_hex\(placement_token\)/);
  assertMatch(viewabilityMigration, /subject_hmac = interaction_subject_hmac/);
  assertMatch(viewabilityMigration, /decision\.reserved_minor/);
  assert(!/record_sponsored_interaction[\s\S]*client_price/i.test(viewabilityMigration));
  assertMatch(
    viewabilityMigration,
    /revoke all on function public\.record_sponsored_interaction\(text, text, text, text\)[\s\S]*from public, anon, authenticated, service_role[\s\S]*grant execute on function public\.record_sponsored_interaction\(text, text, text, text\)[\s\S]*to service_role/,
  );
  assertMatch(
    viewabilityMigration,
    /where decision_id = decision\.id and state = 'held'[\s\S]*returning id into reservation_id/,
  );
  assertMatch(viewabilityMigration, /reservation_unavailable/);
  assert(
    viewabilityMigration.lastIndexOf("returning id into reservation_id") <
      viewabilityMigration.indexOf("'sponsored_open', event_id"),
    "A real-money debit must only be inserted after consuming a held reservation",
  );
  assertMatch(marketplace, /recordSponsoredInteraction/);
  assertMatch(marketplace, /client\.functions\.invoke\('public-discovery'/);
});

Deno.test("production keeps sponsorship fail-closed and maintenance drains reservations", () => {
  assertMatch(
    releaseWorkflow,
    /EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED: "false"/,
  );
  assertMatch(migration, /create or replace function public\.reconcile_sponsored_reservations/);
  assertMatch(migration, /pg_try_advisory_xact_lock/);
  assertMatch(migration, /for update of reservation skip locked/);
  assertMatch(maintenance, /reconcile_sponsored_reservations/);
  assert(
    maintenance.indexOf("reconcile_sponsored_reservations") <
      maintenance.indexOf("const heartbeat = await fetchImpl"),
  );
});
