import { assert, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL("../migrations/20260803000000_global_map_viewport.sql", import.meta.url),
);

Deno.test("map viewport is bounded, privacy safe, and public-read only", () => {
  assertMatch(migration, /safe_limit integer := least\(greatest\(.+\), 1\), 2500\)/);
  assertMatch(migration, /b\.kind = 'home_kitchen'.+st_snaptogrid/s);
  assertMatch(migration, /private\.is_business_publicly_eligible\(b\.id\)/);
  assertMatch(migration, /grant execute on function public\.map_food_places[\s\S]+to anon, authenticated/);
  assert(migration.includes("revoke all on function public.map_food_places"));
});

Deno.test("map viewport supports clusters, individuals, kinds, and antimeridian", () => {
  assertMatch(migration, /safe_zoom < 14/);
  assertMatch(migration, /safe_zoom >= 14/);
  assertMatch(migration, /west_longitude > east_longitude/);
  assertMatch(migration, /requested_kinds <@ array/);
  assertMatch(migration, /when b\.kind = 'food_truck' then 0/);
});

