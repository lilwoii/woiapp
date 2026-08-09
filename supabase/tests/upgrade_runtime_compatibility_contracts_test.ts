import { assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260817000000_upgrade_runtime_compatibility.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);
const runner = await Deno.readTextFile(
  new URL("../../scripts/database-runtime-gate.mjs", import.meta.url),
);

Deno.test("forward migration revokes anonymous base-table reads", () => {
  assertMatch(
    migration,
    /revoke select on[\s\S]*public\.businesses[\s\S]*public\.business_live_status[\s\S]*from anon/,
  );
});

Deno.test("forward migration repairs PostgreSQL 17 reserved aliases", () => {
  assertMatch(migration, /account_deletion_freezes freeze/);
  assertMatch(migration, /account_deletion_freezes deletion_freeze/);
  assertMatch(migration, /media_stage_grants grant/);
  assertMatch(migration, /media_stage_grants stage_grant/);
  assertMatch(migration, /pgcrypto_schema/);
  assertMatch(migration, /geometry_type/);
  assertMatch(migration, / geography\(%/);
  assertMatch(migration, /citext_type/);
  assertMatch(migration, /language\.lanname in \('plpgsql', 'sql'\)/);
  assertMatch(migration, /dependency\.refclassid = 'pg_catalog\.pg_extension'/);
  assertMatch(migration, /Legacy aliases or extension namespaces remain/);
});

Deno.test("runtime gate installs and executes a representative legacy function", () => {
  assertMatch(runner, /upgrade_runtime_compatibility_runtime_setup\.sql/);
  assertMatch(runtime, /private\.runtime_legacy_upgrade_probe\(\)/);
  assertMatch(runtime, /private\.runtime_legacy_sql_upgrade_probe\('spottr'\)/);
});

Deno.test("runtime gate executes anonymous allowed and denied paths", () => {
  assertMatch(runtime, /set local role anon/);
  assertMatch(runtime, /from public\.public_business_directory/);
  assertMatch(runtime, /perform 1 from public\.profiles/);
  assertMatch(runtime, /perform public\.prepare_media_cleanup_batch\(\)/);
  assertMatch(runtime, /when insufficient_privilege then null/);
});
