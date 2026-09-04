import { assert, assertMatch, assertNotMatch } from "jsr:@std/assert@1";

const root = new URL("../", import.meta.url);

async function text(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, root));
}

Deno.test("notification eligibility uses the provider barrier before business locks", async () => {
  const repair = await text(
    "migrations/20261020000000_notification_provider_lock_order.sql",
  );
  const providerBarrier = await text(
    "migrations/20261007000000_provider_claim_serialization_barrier.sql",
  );

  const barrier = repair.indexOf("pg_catalog.pg_advisory_xact_lock(");
  const businessLock = repair.indexOf("for share of business");
  const jurisdictionLock = repair.indexOf("for share of jurisdiction");
  const permitLock = repair.indexOf("for share of permit");

  assert(
    barrier >= 0 && businessLock > barrier && jurisdictionLock > businessLock &&
      permitLock > jurisdictionLock,
  );
  assertMatch(repair, /spottr:provider-lifecycle/);
  assertNotMatch(repair, /for share of account/);
  assertNotMatch(repair, /for share of source/);
  assertMatch(
    providerBarrier,
    /provider_accounts_mutation_barrier[\s\S]+before insert or update or delete on private\.provider_accounts/,
  );
  assertMatch(
    providerBarrier,
    /provider_sources_mutation_barrier[\s\S]+before insert or update or delete on private\.provider_business_sources/,
  );
});

Deno.test("notification eligibility lock helper remains service-only", async () => {
  const repair = await text(
    "migrations/20261020000000_notification_provider_lock_order.sql",
  );

  assertMatch(
    repair,
    /revoke all on function private\.lock_notification_business_eligibility\(uuid\[\]\)[\s\S]+from public, anon, authenticated, service_role;[\s\S]+grant execute on function private\.lock_notification_business_eligibility\(uuid\[\]\)[\s\S]+to service_role;/,
  );
  assert(repair.includes("cardinality(normalized_ids) > 250"));
});

Deno.test("cloud runtime exercises the effective notification barrier", async () => {
  const runtimeGate = await Deno.readTextFile(
    new URL("../../scripts/database-runtime-gate.mjs", import.meta.url),
  );

  assertMatch(
    runtimeGate,
    /provider_mutation_shared_barrier_holder\.sql[\s\S]+lock_timeout = '500ms'[\s\S]+lock_notification_business_eligibility\(array\[/,
  );
});
