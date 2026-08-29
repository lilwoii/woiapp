import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260930000000_provider_location_lifecycle_guard.sql",
    import.meta.url,
  ),
);
const runtimeProbe = await Deno.readTextFile(
  new URL("./provider_location_lifecycle_guard_runtime_test.sql", import.meta.url),
);
const runtimeGate = await Deno.readTextFile(
  new URL("../../scripts/database-runtime-gate.mjs", import.meta.url),
);

Deno.test("provider child lifecycle guard preserves manual locations", () => {
  assertMatch(
    migration,
    /create or replace function private\.is_business_location_publicly_eligible\([\s\S]*?b\.provenance <> 'licensed_provider'/,
  );
  assertMatch(
    migration,
    /or not exists \(\s*select 1\s*from private\.provider_location_sources child\s*where child\.materialized_location_id = bl\.id\s*\)[\s\S]*?or exists \([\s\S]*?active_child\.source_status = 'active'/,
  );
  assertMatch(
    migration,
    /parent_source\.business_id = b\.id/,
  );
  assertMatch(
    migration,
    /provider_location_sources_materialized_location_idx[\s\S]*?materialized_location_id, source_status/,
  );
  assertMatch(migration, /active_parent_source\.source_status = 'active'/);
  assertMatch(migration, /active_account\.enabled/);
  assertMatch(
    migration,
    /current_date between active_account\.license_effective_on[\s\S]*?active_account\.license_expires_on/,
  );
  assertMatch(
    migration,
    /grant execute on function private\.is_business_location_publicly_eligible\(uuid\)[\s\S]*?to anon, authenticated/,
  );
});

Deno.test("mobile stops, events, and fallback selection share location eligibility", () => {
  assertMatch(
    migration,
    /from public\.mobile_stops ms[\s\S]*?is_business_location_publicly_eligible\(ms\.location_id\)/,
  );
  assertMatch(
    migration,
    /from public\.business_locations primary_location[\s\S]*?is_business_location_publicly_eligible\(primary_location\.id\)/,
  );
  assertMatch(
    migration,
    /create policy "eligible published stops are readable"[\s\S]*?is_business_location_publicly_eligible\(location_id\)/,
  );
  assertMatch(
    migration,
    /create policy "active public business events are readable"[\s\S]*?event_type <> 'mobile_stop'[\s\S]*?is_business_location_publicly_eligible/,
  );
});

Deno.test("all public location-backed discovery paths apply the guard", () => {
  const projectionNames = [
    "public_business_locations",
    "map_food_places",
    "nearby_businesses",
    "search_businesses",
  ];
  for (const name of projectionNames) {
    const start = migration.indexOf(name);
    assert(start >= 0, `missing ${name} replacement`);
    const nextObject = migration.indexOf("create or replace ", start + name.length);
    const body = migration.slice(start, nextObject < 0 ? undefined : nextObject);
    assertMatch(body, /is_business_location_publicly_eligible/);
  }
  assertMatch(
    migration,
    /revoke all on function public\.map_food_places\([\s\S]*?from public, anon, authenticated[\s\S]*?grant execute on function public\.map_food_places\([\s\S]*?to service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.nearby_businesses\([\s\S]*?from public, anon, authenticated[\s\S]*?grant execute on function public\.nearby_businesses\([\s\S]*?to service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.search_businesses\(text, integer, integer\)[\s\S]*?from public, anon, authenticated[\s\S]*?grant execute on function public\.search_businesses\(text, integer, integer\)[\s\S]*?to service_role/,
  );
});

Deno.test("licensed provider attribution wins over owner verification", () => {
  const providerIndex = migration.indexOf(
    "when bucketed.provenance = 'licensed_provider'",
  );
  const ownerIndex = migration.indexOf(
    "when bucketed.verification = 'verified'",
  );
  assert(providerIndex >= 0 && ownerIndex > providerIndex);
  assertMatch(
    migration,
    /position\('provenance = ''licensed_provider''' in map_definition\) = 0[\s\S]*?position\('verification = ''verified''' in map_definition\) = 0/,
  );
  assertMatch(migration, /business_locations_point_gix/);
  assertMatch(
    migration,
    /st_intersects\(redacted\.safe_point::public\.geography/,
  );
});

Deno.test("runtime gate proves provider-linked orphan rows fail closed", () => {
  assertMatch(
    runtimeProbe,
    /Child with null parent business was treated as manual/,
  );
  assertMatch(
    runtimeProbe,
    /Child with mismatched parent business was treated as manual/,
  );
  assertMatch(
    runtimeProbe,
    /Deleting the provider child did not restore manual eligibility/,
  );
  assertMatch(
    runtimeGate,
    /provider_location_lifecycle_guard_runtime_test\.sql/,
  );
});
