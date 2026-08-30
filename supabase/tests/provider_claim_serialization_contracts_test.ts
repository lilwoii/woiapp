import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261007000000_provider_claim_serialization_barrier.sql",
    import.meta.url,
  ),
);
const ingest = await Deno.readTextFile(
  new URL(
    "../migrations/20260804000000_provider_ingest_rpc.sql",
    import.meta.url,
  ),
);
const lifecycle = await Deno.readTextFile(
  new URL(
    "../migrations/20260829000000_provider_lifecycle_guard.sql",
    import.meta.url,
  ),
);
const runtimeGate = await Deno.readTextFile(
  new URL("../../scripts/database-runtime-gate.mjs", import.meta.url),
);
const runtimeHolder = await Deno.readTextFile(
  new URL("./provider_mutation_shared_barrier_holder.sql", import.meta.url),
);
const sourceRuntimeHolder = await Deno.readTextFile(
  new URL("./provider_source_shared_barrier_holder.sql", import.meta.url),
);
const ingestRuntimeHolder = await Deno.readTextFile(
  new URL("./provider_ingest_shared_barrier_holder.sql", import.meta.url),
);

Deno.test("provider mutations take the shared eligibility barrier before materialization", () => {
  assertMatch(
    migration,
    /private\.acquire_provider_mutation_barrier\(\)[\s\S]+pg_advisory_xact_lock_shared\([\s\S]+spottr:provider-lifecycle/,
  );
  for (
    const trigger of [
      "provider_accounts_mutation_barrier",
      "provider_sources_mutation_barrier",
      "provider_ingest_mutation_barrier",
    ]
  ) {
    assert(migration.includes(`create trigger ${trigger}`));
  }
  assertMatch(
    migration,
    /provider_ingest_mutation_barrier[\s\S]+before insert on private\.provider_rate_limit_buckets[\s\S]+for each statement/,
  );
  const accountLock = ingest.indexOf("select account.*");
  const firstIngestWrite = ingest.indexOf(
    "insert into private.provider_rate_limit_buckets",
  );
  const firstSourceWrite = ingest.indexOf(
    "insert into private.provider_business_sources",
  );
  assert(accountLock >= 0 && firstIngestWrite > accountLock);
  assert(firstSourceWrite > firstIngestWrite);
  assertMatch(
    lifecycle,
    /pg_try_advisory_xact_lock\([\s\S]+spottr:provider-lifecycle/,
  );
});

Deno.test("claim review takes the exclusive provider barrier before authority locks", () => {
  const wrapperStart = migration.indexOf(
    "create function public.review_business_claim",
  );
  const wrapper = migration.slice(wrapperStart);
  const aal2 = wrapper.indexOf("private.require_aal2()");
  const staff = wrapper.indexOf("private.is_platform_staff(");
  const barrier = wrapper.indexOf("pg_advisory_xact_lock(");
  const coreCall = wrapper.indexOf(
    "private.review_business_claim_provider_serialized_core",
  );
  assert(
    wrapperStart >= 0 && aal2 >= 0 && staff > aal2 && barrier > staff &&
      coreCall > barrier,
  );
  assertMatch(
    wrapper,
    /if decision = 'approved' then[\s\S]+pg_advisory_xact_lock\(/,
  );
  assertMatch(wrapper, /spottr:provider-lifecycle/);
});

Deno.test("review core and barrier helpers are private with explicit ACLs", () => {
  assertMatch(
    migration,
    /alter function public\.review_business_claim_provider_serialized_core\(uuid, text, text\)\s+set schema private/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.review_business_claim_provider_serialized_core\(uuid, text, text\)\s+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.acquire_provider_mutation_barrier\(\)\s+from public, anon, authenticated, service_role/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.review_business_claim\(uuid, text, text\)\s+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.review_business_claim\(uuid, text, text\)\s+to authenticated/,
  );
});

Deno.test("cloud runtime proves trigger contention and authorization-before-lock ordering", () => {
  assertMatch(
    runtimeHolder,
    /update private\.provider_accounts[\s\S]+where false;[\s\S]+SPOTTR_PROVIDER_MUTATION_SHARED_BARRIER_READY/,
  );
  assertMatch(
    runtimeGate,
    /verifyProviderClaimSerializationBarrier[\s\S]+provider_mutation_shared_barrier_holder\.sql/,
  );
  assertMatch(
    sourceRuntimeHolder,
    /update private\.provider_business_sources[\s\S]+where false;[\s\S]+SPOTTR_PROVIDER_SOURCE_SHARED_BARRIER_READY/,
  );
  assertMatch(
    ingestRuntimeHolder,
    /insert into private\.provider_rate_limit_buckets[\s\S]+where false;[\s\S]+SPOTTR_PROVIDER_INGEST_SHARED_BARRIER_READY/,
  );
  assert(runtimeGate.includes("provider_source_shared_barrier_holder.sql"));
  assert(runtimeGate.includes("provider_ingest_shared_barrier_holder.sql"));
  assertMatch(
    runtimeGate,
    /spottr:provider-lifecycle[\s\S]+lock_timeout = '500ms'/,
  );
  assertMatch(
    runtimeGate,
    /review_business_claim[\s\S]+expectedPatterns: \[\/42501\/[\s\S]+Platform administrator role required/,
  );
});
