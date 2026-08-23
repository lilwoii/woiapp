import {
  assert,
  assertEquals,
  assertMatch,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  normalizePublicDiscoveryRows,
  normalizeSponsoredPlacement,
  validatePublicDiscoveryRequest,
} from "../functions/public-discovery/contract.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260823000000_public_discovery_guard.sql",
    import.meta.url,
  ),
);
const mapGeographyRepair = await Deno.readTextFile(
  new URL(
    "../migrations/20260824000000_global_map_geography_bbox_repair.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);
const edge = await Deno.readTextFile(
  new URL("../functions/public-discovery/index.ts", import.meta.url),
);
const config = await Deno.readTextFile(
  new URL("../config.toml", import.meta.url),
);
const environmentExample = await Deno.readTextFile(
  new URL("../../.env.example", import.meta.url),
);

Deno.test("public discovery identity state is digest-only and operation-bounded", () => {
  assertMatch(migration, /create table if not exists private\.public_discovery_rate_buckets/);
  assertMatch(migration, /create table if not exists private\.public_discovery_leases/);
  assertMatch(
    migration,
    /check \(operation in \('map', 'nearby', 'search'\)\)/,
  );
  assertMatch(migration, /varchar\(64\)/);
  assertMatch(migration, /\^\[0-9a-f\]\{64\}\$/);
  assert(!/\b(inet|cidr)\b/i.test(migration));
  assert(!migration.includes("raw_ip"));
  assertMatch(migration, /extension\.extname = 'pgcrypto'/);
  assertMatch(migration, /%I\.hmac\(\$1, \$2, ''sha256''\)/);
  assertMatch(
    migration,
    /revoke all on table[\s\S]+public_discovery_rate_buckets[\s\S]+public_discovery_leases[\s\S]+from public, anon, authenticated, service_role/,
  );
});

Deno.test("quotas and leases are atomic, bounded, and nonblocking", () => {
  assertMatch(migration, /target_operation[\s\S]+target_limit[\s\S]+target_now/);
  assertMatch(migration, /target_ip_hmac[\s\S]+60/);
  assertMatch(migration, /target_account_hmac[\s\S]+240/);
  assertMatch(migration, /target_operation = 'map' then 32 else 64/);
  assertMatch(migration, /interval '2 minutes'/);
  assertMatch(migration, /pg_try_advisory_xact_lock/);
  assertMatch(migration, /on conflict \(operation, subject_kind, subject_hmac, bucket_started_at\)/);
  assertMatch(migration, /request_count < target_limit/);
  assertMatch(migration, /limit 10000/);
  assertMatch(
    migration,
    /'more_work', bucket_backlog or pg_catalog\.cardinality\(skipped_operations\) > 0/,
  );
});

Deno.test("all discovery query and lifecycle RPC grants are fail-closed", () => {
  for (const name of [
    "public.acquire_public_discovery_lease",
    "public.attach_public_discovery_account",
    "public.release_public_discovery_lease",
    "public.cleanup_public_discovery_leases",
    "public.map_food_places",
    "public.nearby_businesses",
    "public.search_businesses",
  ]) {
    assertMatch(
      migration,
      new RegExp(`revoke all on function ${name.replaceAll(".", "\\.")}`),
    );
    assertMatch(
      migration,
      new RegExp(`grant execute on function ${name.replaceAll(".", "\\.")}.*to service_role`, "s"),
    );
  }
  assertMatch(migration, /set search_path = ''/);
});

Deno.test("global map viewport uses geography-compatible index-aware filtering", () => {
  assertMatch(mapGeographyRepair, /public\.st_intersects\(/);
  assertMatch(mapGeographyRepair, /public\.st_equals\(ct\.grid_point, b\.grid_point\)/);
  assert(!/bl\.point\s+&&\s+public\.st_makeenvelope/.test(mapGeographyRepair));
  assert(!/ct\.grid_point\s+=\s+b\.grid_point\) as category_counts/.test(mapGeographyRepair));
  assertMatch(
    mapGeographyRepair,
    /revoke all on function public\.map_food_places[\s\S]+from public, anon, authenticated/,
  );
  assertMatch(
    mapGeographyRepair,
    /grant execute on function public\.map_food_places[\s\S]+to service_role/,
  );
});

Deno.test("full-schema runtime assertions exercise denial, admission, recovery, and release", () => {
  assertMatch(runtime, /set local role anon/);
  assertMatch(runtime, /acquire_public_discovery_lease/);
  assertMatch(runtime, /when insufficient_privilege then null/);
  assertMatch(runtime, /public_discovery_rate_buckets/);
  assertMatch(runtime, /when sqlstate 'P0001' then null/);
  assertMatch(runtime, /Map concurrency cap unexpectedly admitted/);
  assertMatch(runtime, /cleanup_public_discovery_leases/);
  assertMatch(runtime, /release_public_discovery_lease/);
  assertMatch(runtime, /2 minutes/);
});

Deno.test("public discovery Edge boundary is anonymous-capable but fail-closed", () => {
  assertMatch(
    config,
    /\[functions\.public-discovery\]\s+verify_jwt = false/,
  );
  assertMatch(environmentExample, /SPOTTR_DISCOVERY_RATE_SECRET=/);
  assertMatch(edge, /request\.headers\.get\("cf-connecting-ip"\)/);
  assert(!edge.includes("x-forwarded-for"));
  assert(!edge.includes("x-real-ip"));
  assertMatch(edge, /identityHmac\("ip", trustedIp\)/);
  assertMatch(edge, /identityHmac\("account", accountId\)/);
  assertMatch(edge, /SPOTTR_DISCOVERY_RATE_SECRET/);
  assertMatch(edge, /timingSafeEqual\(token, requiredEnvironment\("SUPABASE_ANON_KEY"\)\)/);
  assertMatch(edge, /fetch\(authUrl,[\s\S]+signal: controller\.signal/);
  assertMatch(edge, /readJson\(request, PUBLIC_DISCOVERY_MAX_BYTES\)/);
  assertMatch(
    edge,
    /finally \{\s+if \(leaseHmac && !retainLeaseUntilExpiry\) await releaseLease\(leaseHmac\)/,
  );
  assertMatch(edge, /"Retry-After": String\(error\.retryAfterSeconds\)/);
  assertMatch(edge, /DISCOVERY_RATE_LIMITED/);
  assertMatch(edge, /DISCOVERY_GUARD_UNAVAILABLE/);
  assertMatch(edge, /DISCOVERY_RESPONSE_INVALID/);
  assertMatch(edge, /const DATABASE_TIMEOUT_MS = 2_500/);
  assertMatch(edge, /\.abortSignal\(controller\.signal\)/);
  assertMatch(edge, /attach_public_discovery_account/);
  assertMatch(edge, /class DatabaseRpcUncertainError/);
  assertMatch(edge, /catch \{[\s\S]+throw new DatabaseRpcUncertainError\(\)/);
  assertMatch(edge, /retainLeaseUntilExpiry = true/);
  assert(
    edge.indexOf('const acquisition = await databaseRpc("acquire_public_discovery_lease"') <
      edge.indexOf("accountId = await authenticatedAccountId(request)"),
  );
});

Deno.test("public discovery request contract rejects unknown and oversized input", () => {
  const request = validatePublicDiscoveryRequest({
    operation: "map",
    west_longitude: -118.5,
    south_latitude: 33.9,
    east_longitude: -118.2,
    north_latitude: 34.1,
    map_zoom: 11,
    requested_kinds: ["food_truck", "restaurant"],
    max_features: 1200,
  });
  assertEquals(request.operation, "map");
  assertThrows(() =>
    validatePublicDiscoveryRequest({
      operation: "search",
      search_text: "Los Angeles",
      result_limit: 100,
      result_offset: 0,
      unexpected: true,
    })
  );
  assertThrows(() =>
    validatePublicDiscoveryRequest({
      operation: "map",
      west_longitude: -180,
      south_latitude: -20,
      east_longitude: 180,
      north_latitude: 20,
    })
  );
});

Deno.test("public discovery response is whitelisted and rejects malformed rows", () => {
  const request = validatePublicDiscoveryRequest({
    operation: "map",
    west_longitude: -118.5,
    south_latitude: 33.9,
    east_longitude: -118.2,
    north_latitude: 34.1,
    map_zoom: 14,
    requested_kinds: ["food_truck"],
    max_features: 1200,
  });
  const rows = normalizePublicDiscoveryRows(request, [{
    feature_type: "place",
    feature_id: "place:11111111-1111-4111-8111-111111111111",
    place_count: 1,
    latitude: 34.05,
    longitude: -118.24,
    category_counts: { food_truck: 1 },
    dominant_kind: "food_truck",
    business_id: "11111111-1111-4111-8111-111111111111",
    location_id: "22222222-2222-4222-8222-222222222222",
    business_name: "Maya Taco Truck",
    logo_path: null,
    source_label: "Owner verified",
    private_field: "must not cross the gateway",
  }]);
  assertEquals(Object.hasOwn(rows[0], "private_field"), false);
  assertThrows(() => normalizePublicDiscoveryRows(request, [{
    ...rows[0],
    category_counts: { food_truck: 2 },
  }]));

  const tinyViewportRequest = validatePublicDiscoveryRequest({
    operation: "map",
    west_longitude: -118.5,
    south_latitude: 33.9,
    east_longitude: -118.2,
    north_latitude: 34.1,
    max_features: 1,
  });
  assertEquals(
    normalizePublicDiscoveryRows(tinyViewportRequest, [{
      feature_type: "cluster",
      feature_id: "cluster:11:0123456789abcdef0123456789abcdef",
      place_count: 5_000,
      latitude: 34.05,
      longitude: -118.24,
      category_counts: { restaurant: 5_000 },
      dominant_kind: "restaurant",
      business_id: null,
      location_id: null,
      business_name: null,
      logo_path: null,
      source_label: null,
    }])[0].place_count,
    5_000,
  );

  const nearbyRequest = validatePublicDiscoveryRequest({
    operation: "nearby",
    search_lat: 34.05,
    search_lng: -118.24,
  });
  assertEquals(normalizePublicDiscoveryRows(nearbyRequest, [{
    business_id: "11111111-1111-4111-8111-111111111111",
    location_id: "22222222-2222-4222-8222-222222222222",
    distance_meters: 1_250,
    is_approximate: false,
    has_more: false,
    name: "must be stripped",
  }]), [{
    business_id: "11111111-1111-4111-8111-111111111111",
    location_id: "22222222-2222-4222-8222-222222222222",
    distance_meters: 1_250,
    is_approximate: false,
    has_more: false,
  }]);
});

Deno.test("sponsored response exposes only a signed short-lived safe projection", () => {
  const token = `11111111-1111-4111-8111-111111111111.1790000000.${"a".repeat(64)}`;
  assertEquals(normalizeSponsoredPlacement({
    business_id: "11111111-1111-4111-8111-111111111111",
    placement_id: "22222222-2222-4222-8222-222222222222",
    disclosure: "Sponsored ad",
    reason: "Near your selected area",
    placement_token: token,
    expires_at: "2026-09-22T00:00:00.000Z",
  }), {
    business_id: "11111111-1111-4111-8111-111111111111",
    placement_id: "22222222-2222-4222-8222-222222222222",
    disclosure: "Sponsored ad",
    reason: "Near your selected area",
    placement_token: token,
    expires_at: "2026-09-22T00:00:00.000Z",
  });
  assertThrows(() => normalizeSponsoredPlacement({
    business_id: "11111111-1111-4111-8111-111111111111",
    placement_id: "22222222-2222-4222-8222-222222222222",
    disclosure: "Sponsored ad",
    reason: "Near your selected area",
    placement_token: token,
    expires_at: "2026-09-22T00:00:00.000Z",
    bid_cap_minor: 500,
  }), DiscoveryContractError);
});
