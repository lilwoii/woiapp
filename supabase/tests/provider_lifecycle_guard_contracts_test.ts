import { assert, assertMatch } from "jsr:@std/assert@1";

const schema = await Deno.readTextFile(new URL("../schema.sql", import.meta.url));
const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260829000000_provider_lifecycle_guard.sql",
    import.meta.url,
  ),
);
const maintenance = await Deno.readTextFile(
  new URL("../../scripts/production-maintenance.mjs", import.meta.url),
);

Deno.test("licensed provider visibility requires a current active source", () => {
  for (const source of [schema, migration]) {
    assertMatch(source, /b\.provenance <> 'licensed_provider'/);
    assertMatch(source, /source\.source_status = 'active'/);
    assertMatch(source, /account\.enabled/);
    assertMatch(
      source,
      /current_date between account\.license_effective_on[\s\S]*account\.license_expires_on/,
    );
  }
  assertMatch(
    migration,
    /revoke all on function private\.is_business_publicly_eligible\(uuid\)[\s\S]*from public, anon, authenticated[\s\S]*grant execute on function private\.is_business_publicly_eligible\(uuid\)[\s\S]*to anon, authenticated/,
  );
  assertMatch(
    schema,
    /revoke all on schema private from public, anon, authenticated/,
  );
});

Deno.test("provider lifecycle cleanup is bounded, audited, and service-only", () => {
  for (const source of [schema, migration]) {
    assertMatch(source, /create or replace function public\.reconcile_licensed_provider_lifecycle/);
    assertMatch(source, /pg_try_advisory_xact_lock/);
    assertMatch(source, /for update of source skip locked/);
    assertMatch(source, /source_status = 'stale'/);
    assertMatch(source, /'sources_marked_stale'/);
    assertMatch(source, /'businesses_archived'/);
    assertMatch(source, /business\.provenance = 'licensed_provider'/);
    assertMatch(source, /member\.status = 'active'/);
    assertMatch(source, /claim\.state = 'approved'/);
    assertMatch(source, /account\.archive_after/);
    assertMatch(source, /'more_work'/);
  }
  assertMatch(
    migration,
    /revoke all on function public\.reconcile_licensed_provider_lifecycle\(integer\)[\s\S]*from public, anon, authenticated/,
  );
  assertMatch(
    migration,
    /grant execute on function public\.reconcile_licensed_provider_lifecycle\(integer\)[\s\S]*to service_role/,
  );
  assert(!migration.includes("delete from public.businesses"));
});

Deno.test("production maintenance drains provider lifecycle before heartbeat", () => {
  const lifecycleCall = maintenance.indexOf("`${restRoot}/reconcile_licensed_provider_lifecycle`");
  const heartbeatCall = maintenance.indexOf("const heartbeat = await fetchImpl");
  assert(lifecycleCall >= 0 && heartbeatCall > lifecycleCall);
  assertMatch(maintenance, /providerLifecycle\.more_work !== false/);
  assertMatch(maintenance, /providerLifecycle\.skipped !== false/);
});
