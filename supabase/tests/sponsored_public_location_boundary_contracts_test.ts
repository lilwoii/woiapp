import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261014000000_sponsored_public_location_boundary.sql",
    import.meta.url,
  ),
);
const runtimeProbe = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);

Deno.test("sponsored selection uses only the public redacted location projection", () => {
  const selectorStart = migration.indexOf(
    "create or replace function public.select_sponsored_placement",
  );
  const selectorEnd = migration.indexOf(
    "revoke all on function",
    selectorStart,
  );
  const selector = migration.slice(selectorStart, selectorEnd);

  assert(selectorStart >= 0 && selectorEnd > selectorStart);
  assertMatch(selector, /security definer\s+set search_path = ''/);
  assertMatch(selector, /from public\.public_business_locations location/);
  assertMatch(
    selector,
    /st_makepoint\(location\.longitude, location\.latitude\)[\s\S]*?search_radius_meters/,
  );
  assert(
    !selector.includes("from public.business_locations location"),
    "Sponsored selection must not inspect a raw business location coordinate",
  );
});

Deno.test("sponsored selector ACL remains service-only after replacement", () => {
  assertMatch(
    migration,
    /revoke all on function public\.select_sponsored_placement\([\s\S]*?from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /grant execute on function public\.select_sponsored_placement\([\s\S]*?to service_role/,
  );
});

Deno.test("migration fails closed if raw-location targeting returns", () => {
  assertMatch(migration, /pg_get_functiondef/);
  assertMatch(
    migration,
    /from public\.business_locations location'[\s\S]*?raise exception 'Sponsored selection is not bound/,
  );
});

Deno.test("runtime probe distinguishes raw and redacted proximity", () => {
  assertMatch(runtimeProbe, /sponsored_redacted_location_boundary/);
  assertMatch(
    runtimeProbe,
    /'discover', 34\.043, -118\.237, 500[\s\S]*?if result is not null[\s\S]*?Sponsored selector exposed a raw redacted location/,
  );
  assertMatch(
    runtimeProbe,
    /has_function_privilege\(\s*'authenticated',[\s\S]*?public\.select_sponsored_placement/,
  );
  assertMatch(
    runtimeProbe,
    /set local role anon;[\s\S]*?perform public\.select_sponsored_placement\([\s\S]*?when insufficient_privilege/,
  );
  assertMatch(
    runtimeProbe,
    /set local role service_role;[\s\S]*?select public\.select_sponsored_placement\(/,
  );
});
