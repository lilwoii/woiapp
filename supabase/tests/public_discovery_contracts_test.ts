import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";

import {
  DiscoveryContractError,
  PUBLIC_DISCOVERY_MAX_BYTES,
  PUBLIC_DISCOVERY_MAX_MAP_FEATURES,
  validatePublicDiscoveryRequest,
} from "../functions/public-discovery/contract.ts";

const index = await Deno.readTextFile(
  new URL("../functions/public-discovery/index.ts", import.meta.url),
);
const config = await Deno.readTextFile(new URL("../config.toml", import.meta.url));
const functionEnvironment = await Deno.readTextFile(
  new URL("../functions/.env.example", import.meta.url),
);
const discoveryScreen = await Deno.readTextFile(
  new URL("../../app/(tabs)/index.tsx", import.meta.url),
);
const sharedHttp = await Deno.readTextFile(
  new URL("../functions/_shared/http.ts", import.meta.url),
);

const validMap = {
  operation: "map",
  west_longitude: -118.3,
  south_latitude: 34.0,
  east_longitude: -118.2,
  north_latitude: 34.1,
  map_zoom: 12,
  requested_kinds: ["food_truck", "restaurant"],
  max_features: PUBLIC_DISCOVERY_MAX_MAP_FEATURES,
} as const;

Deno.test("public discovery accepts bounded map, nearby, and search operations", () => {
  assertEquals(validatePublicDiscoveryRequest(validMap).operation, "map");
  assertEquals(
    validatePublicDiscoveryRequest({
      operation: "nearby",
      search_lat: 34.05,
      search_lng: -118.24,
      radius_meters: 16_093,
      result_limit: 50,
      result_offset: 0,
    }).operation,
    "nearby",
  );
  assertEquals(
    validatePublicDiscoveryRequest({
      operation: "search",
      search_text: "  Los   Angeles, CA ",
      result_limit: 25,
      result_offset: 0,
    }),
    {
      operation: "search",
      search_text: "Los Angeles, CA",
      result_limit: 25,
      result_offset: 0,
    },
  );
});

Deno.test("public discovery rejects unknown fields and unbounded requests", () => {
  assertThrows(
    () => validatePublicDiscoveryRequest({ ...validMap, unexpected: true }),
    DiscoveryContractError,
    "INVALID_REQUEST",
  );
  assertThrows(
    () => validatePublicDiscoveryRequest({ ...validMap, max_features: PUBLIC_DISCOVERY_MAX_MAP_FEATURES + 1 }),
    DiscoveryContractError,
    "INVALID_REQUEST",
  );
  assertThrows(
    () => validatePublicDiscoveryRequest({ ...validMap, north_latitude: 50 }),
    DiscoveryContractError,
    "INVALID_REQUEST",
  );
  assertThrows(
    () => validatePublicDiscoveryRequest({
      operation: "nearby",
      search_lat: 34,
      search_lng: -118,
      radius_meters: 80_468,
    }),
    DiscoveryContractError,
    "INVALID_REQUEST",
  );
});

Deno.test("gateway is anonymous-JWT optional but fail-closed for identity and source safety", () => {
  assertEquals(PUBLIC_DISCOVERY_MAX_BYTES, 4_096);
  assertMatch(index, /timingSafeEqual\(token, requiredEnvironment\("SUPABASE_ANON_KEY"\)\)/);
  assertMatch(index, /fetch\(authUrl,[\s\S]+signal: controller\.signal/);
  assertMatch(index, /cf-connecting-ip/);
  assert(!index.includes("x-forwarded-for"));
  assert(!index.includes("x-real-ip"));
  assertMatch(index, /SPOTTR_DISCOVERY_RATE_SECRET/);
  assertMatch(index, /HMAC/);
  assertMatch(index, /acquire_public_discovery_lease/);
  assertMatch(index, /release_public_discovery_lease/);
  assertMatch(index, /attach_public_discovery_account/);
  assertMatch(index, /finally/);
  assertMatch(index, /map_food_places/);
  assertMatch(index, /nearby_businesses/);
  assertMatch(index, /search_businesses/);
  assert(!index.includes("console.log"));
  assert(!index.includes("console.error(error"));
  assertMatch(config, /\[functions\.public-discovery\][\s\S]*verify_jwt\s*=\s*false/);
  assertMatch(functionEnvironment, /SPOTTR_DISCOVERY_RATE_SECRET/);
  assertMatch(
    sharedHttp,
    /authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage/,
  );
  assertMatch(sharedHttp, /request\.body\.getReader\(\)/);
  assert(!sharedHttp.includes("await request.text()"));
  assertMatch(
    discoveryScreen,
    /if \(!result\.ok\) \{\s+\/\/ Keep the last verified inventory[\s\S]+?return result;\s+\}/,
  );
});
