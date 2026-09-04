import { assert, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL("../migrations/20260820000000_global_map_provider_source_label.sql", import.meta.url),
);

Deno.test("map source label matches licensed provider provenance contract", () => {
  assertMatch(
    migration,
    /when b\.provenance = 'licensed_provider' then 'Licensed provider'/,
  );
  assert(!migration.includes("when b.provenance = 'provider'"));
  assertMatch(migration, /create or replace function public\.map_food_places/);
  assertMatch(migration, /to anon, authenticated/);
});
