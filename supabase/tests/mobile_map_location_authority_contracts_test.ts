import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261017000000_mobile_map_location_authority.sql",
    import.meta.url,
  ),
);
const nearbyMigration = await Deno.readTextFile(
  new URL(
    "../migrations/20260930000000_provider_location_lifecycle_guard.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

function mobileLocationRule(source: string, functionName: string): string {
  const functionStart = source.indexOf(
    `create or replace function public.${functionName}`,
  );
  const mobileStart = source.indexOf(
    "b.kind not in ('food_truck', 'pop_up')",
    functionStart,
  );
  const requestedKinds = source.indexOf(
    "requested_kinds is null",
    mobileStart,
  );
  const functionEnd = source.indexOf("\n$$;", mobileStart);
  const end = requestedKinds > mobileStart ? requestedKinds : functionEnd;
  assert(
    functionStart >= 0 && mobileStart > functionStart && end > mobileStart,
  );
  return source.slice(mobileStart, end);
}

Deno.test("map mobile-location authority matches nearby discovery", () => {
  const mapRule = mobileLocationRule(migration, "map_food_places");
  const nearbyRule = mobileLocationRule(nearbyMigration, "nearby_businesses");

  for (const rule of [mapRule, nearbyRule]) {
    assertMatch(rule, /ms\.state in \('scheduled', 'live'\)/);
    assertMatch(rule, /now\(\) >= ms\.starts_at/);
    assertMatch(rule, /now\(\) < ms\.ends_at/);
    assertMatch(rule, /case when ms\.state = 'live' then 0 else 1 end/);
    assertMatch(rule, /ms\.confirmed_at desc nulls last/);
    assertMatch(rule, /primary_location\.is_primary desc/);
    assertMatch(rule, /private\.is_business_location_publicly_eligible/);
  }
});

Deno.test("fixed-location categories retain multi-location map behavior", () => {
  const mapRule = mobileLocationRule(migration, "map_food_places");
  assertMatch(mapRule, /b\.kind not in \('food_truck', 'pop_up'\)/);
  assert(!mapRule.includes("restaurant"));
  assert(!mapRule.includes("cafe_bakery"));
});

Deno.test("map authority remains service-only and has hosted runtime coverage", () => {
  assertMatch(
    migration,
    /revoke all on function public\.map_food_places\([\s\S]+from public, anon, authenticated;[\s\S]+grant execute on function public\.map_food_places\([\s\S]+to service_role;/,
  );
  assertMatch(runtime, /do \$mobile_map_location_authority\$/);
  assertMatch(runtime, /Mobile map did not use the primary fallback/);
  assertMatch(runtime, /Mobile map ignored the current active stop/);
  assertMatch(runtime, /Mobile map did not restore the primary fallback/);
});
