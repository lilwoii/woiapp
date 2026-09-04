import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20261004000000_business_claim_evidence_retention_foundation.sql",
    import.meta.url,
  ),
);
const mediaStage = await Deno.readTextFile(
  new URL("../functions/media-stage/index.ts", import.meta.url),
);
const runtimeSql = await Deno.readTextFile(
  new URL("./full_stack_security_runtime_test.sql", import.meta.url),
);
const databaseRuntimeGate = await Deno.readTextFile(
  new URL("../../scripts/database-runtime-gate.mjs", import.meta.url),
);
const conflictSetup = await Deno.readTextFile(
  new URL(
    "./business_claim_evidence_migration_conflict_setup.sql",
    import.meta.url,
  ),
);
const conflictAssertion = await Deno.readTextFile(
  new URL(
    "./business_claim_evidence_migration_conflict_assert_and_cleanup.sql",
    import.meta.url,
  ),
);
const mutationRollbackSetup = await Deno.readTextFile(
  new URL(
    "./business_claim_evidence_migration_mutation_rollback_setup.sql",
    import.meta.url,
  ),
);
const mutationRollbackAssertion = await Deno.readTextFile(
  new URL(
    "./business_claim_evidence_migration_mutation_rollback_assert_and_cleanup.sql",
    import.meta.url,
  ),
);
const sharedBarrierHolder = await Deno.readTextFile(
  new URL(
    "./business_claim_evidence_shared_barrier_holder.sql",
    import.meta.url,
  ),
);
const exclusiveBarrierHolder = await Deno.readTextFile(
  new URL(
    "./business_claim_evidence_exclusive_barrier_holder.sql",
    import.meta.url,
  ),
);

function section(start: string, end: string): string {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing start marker: ${start}`);
  assert(endIndex > startIndex, `missing end marker: ${end}`);
  return migration.slice(startIndex, endIndex);
}

Deno.test("claim evidence moves to a private, ungranted legal-hold table", () => {
  assertMatch(migration, /create table private\.business_claim_evidence \(/);
  assertMatch(migration, /legal_hold boolean not null default true/);
  assertMatch(migration, /retention_policy_version text/);
  assertMatch(migration, /purge_after timestamptz/);
  assertMatch(migration, /storage_path_hash text not null unique/);
  assertMatch(
    migration,
    /revoke all privileges on table private\.business_claim_evidence\s+from public, anon, authenticated, service_role;/,
  );
  assertMatch(
    migration,
    /revoke all privileges on table private\.business_claim_evidence_audit\s+from public, anon, authenticated, service_role;/,
  );
  assertMatch(
    migration,
    /create table private\.business_claim_evidence_account_deletion_exceptions/,
  );
  assertMatch(
    migration,
    /revoke all privileges on table private\.business_claim_evidence_account_deletion_exceptions\s+from public, anon, authenticated, service_role;/,
  );
  assertMatch(
    migration,
    /create table private\.business_claim_evidence_purge_receipts/,
  );
  assertMatch(
    migration,
    /revoke all privileges on table private\.business_claim_evidence_purge_receipts\s+from public, anon, authenticated, service_role;/,
  );
  assertMatch(
    migration,
    /create trigger audit_business_claim_evidence_insert[\s\S]+after insert on private\.business_claim_evidence/,
  );
  assertMatch(
    migration,
    /audit_business_claim_evidence_insert\(\)[\s\S]+new\.lifecycle_state/,
  );
  assert(!migration.includes("on private.business_claim_evidence for"));
  assert(
    !migration.includes(
      "alter publication supabase_realtime add table private.business_claim_evidence",
    ),
  );
});

Deno.test("legacy public paths are validated, backfilled, nulled, and retired", () => {
  const validation = migration.indexOf("do $legacy_claim_evidence_validation$");
  const insert = migration.indexOf(
    "insert into private.business_claim_evidence (",
  );
  const clear = migration.indexOf(
    "update public.business_claims\nset evidence_private_path = null",
  );
  const constraint = migration.indexOf(
    "business_claims_legacy_evidence_path_retired",
  );
  assert(
    validation >= 0 && insert > validation && clear > insert &&
      constraint > clear,
  );
  assertMatch(migration, /LEGACY_CLAIM_EVIDENCE_OBJECT_MISSING/);
  assertMatch(migration, /LEGACY_CLAIM_EVIDENCE_CLEANUP_CONFLICT/);
  assertMatch(
    migration,
    /deletion_item\.state in \('pending', 'deleted'\)[\s\S]+LEGACY_CLAIM_EVIDENCE_ACCOUNT_DELETION_CONFLICT/,
  );
  assertMatch(migration, /LEGACY_CLAIM_EVIDENCE_UPLOAD_CAPABILITY_ACTIVE/);
  assertMatch(migration, /LEGACY_CLAIM_EVIDENCE_STAGE_GRANT_MISMATCH/);
  assertMatch(migration, /LEGACY_CLAIM_EVIDENCE_DELETION_ALREADY_SEALED/);
  assertMatch(
    migration,
    /business_claims_legacy_evidence_path_retired[\s\S]+check \(evidence_private_path is null\)/,
  );
});

Deno.test("storage mutation barrier precedes cleanup, deletion, and migration row locks", () => {
  const migrationBarrier = migration.indexOf(
    "select pg_catalog.pg_advisory_xact_lock(7742004, 1);",
  );
  const firstTableLock = migration.indexOf(
    "lock table public.business_claims in share row exclusive mode;",
  );
  assert(migrationBarrier >= 0 && firstTableLock > migrationBarrier);

  const sections = [
    section(
      "create or replace function public.prepare_business_claim_evidence_purge_batch()",
      "revoke all on function public.prepare_business_claim_evidence_purge_batch()",
    ),
    section(
      "create or replace function public.finalize_business_claim_evidence_purge_batch(",
      "revoke all on function public.finalize_business_claim_evidence_purge_batch(uuid, text[])",
    ),
    section(
      "create or replace function public.prepare_media_cleanup_batch()",
      "revoke all on function public.prepare_media_cleanup_batch()",
    ),
    section(
      "create or replace function public.finalize_media_cleanup_batch(",
      "revoke all on function public.finalize_media_cleanup_batch(uuid, text[])",
    ),
    section(
      "create or replace function public.prepare_account_deletion_storage_batch(",
      "revoke all on function public.prepare_account_deletion_storage_batch(uuid, uuid)",
    ),
    section(
      "create or replace function public.checkpoint_account_deletion_storage_batch(",
      "revoke all on function public.checkpoint_account_deletion_storage_batch(uuid, uuid, text[])",
    ),
  ];
  for (const body of sections) {
    assertMatch(
      body,
      /begin\s+perform pg_catalog\.pg_advisory_xact_lock_shared\(7742004, 1\);/,
    );
  }

  const preflightStart = migration.indexOf(
    "do $legacy_claim_evidence_validation$",
  );
  const backfillStart = migration.indexOf(
    "insert into private.business_claim_evidence (",
    preflightStart,
  );
  const preflight = migration.slice(preflightStart, backfillStart);
  assertMatch(preflight, /deletion_item\.state in \('pending', 'deleted'\)/);
  assert(
    !preflight.includes("delete from private.account_deletion_storage_items"),
  );
});

Deno.test("disposable runtime proves migration rollback and both advisory lock directions", () => {
  assertMatch(
    databaseRuntimeGate,
    /migrationName === CLAIM_EVIDENCE_MIGRATION[\s\S]+business_claim_evidence_migration_conflict_setup\.sql[\s\S]+copyAndExpectSqlFailure[\s\S]+LEGACY_CLAIM_EVIDENCE_ACCOUNT_DELETION_CONFLICT[\s\S]+business_claim_evidence_migration_conflict_assert_and_cleanup\.sql[\s\S]+Applying \$\{migrationName\}/,
  );
  assertMatch(
    databaseRuntimeGate,
    /business_claim_evidence_migration_mutation_rollback_setup\.sql[\s\S]+migrationSource\.trimEnd\(\)[\s\S]+CLAIM_EVIDENCE_FORCED_ROLLBACK[\s\S]+business_claim_evidence_migration_mutation_rollback_assert_and_cleanup\.sql[\s\S]+Applying \$\{migrationName\}/,
  );
  assertMatch(
    databaseRuntimeGate,
    /business_claim_evidence_shared_barrier_holder\.sql[\s\S]+SPOTTR_CLAIM_EVIDENCE_SHARED_BARRIER_READY[\s\S]+pg_advisory_xact_lock\(\$\{CLAIM_EVIDENCE_BARRIER_CLASS_ID\}, \$\{CLAIM_EVIDENCE_BARRIER_OBJECT_ID\}\)/,
  );
  assertMatch(
    databaseRuntimeGate,
    /business_claim_evidence_exclusive_barrier_holder\.sql[\s\S]+SPOTTR_CLAIM_EVIDENCE_EXCLUSIVE_BARRIER_READY[\s\S]+prepare_media_cleanup_batch\(\)/,
  );
  assertMatch(databaseRuntimeGate, /\[\/55P03\/, \/lock timeout\/i\]/);
  assertMatch(databaseRuntimeGate, /await holder\.waitForOutput\(/);
  assertMatch(databaseRuntimeGate, /holder\.sendLine\('release'\)/);
  assertMatch(databaseRuntimeGate, /await holder\.waitForCompletion\(/);
  assertMatch(databaseRuntimeGate, /child\.kill\('SIGKILL'\)/);
  assertMatch(
    databaseRuntimeGate,
    /interactivePsqlFileArguments[\s\S]+args\.splice\(1, 0, '-i'\)[\s\S]+const holderArguments = interactivePsqlFileArguments/,
  );
  assertMatch(
    databaseRuntimeGate,
    /await verifyBusinessClaimEvidenceStorageBarrier\(/,
  );
  assertMatch(
    conflictSetup,
    /insert into public\.business_claims[\s\S]+evidence_private_path[\s\S]+insert into storage\.objects[\s\S]+insert into private\.account_deletion_storage_items/,
  );
  assertMatch(
    conflictAssertion,
    /to_regclass\('private\.business_claim_evidence'\) is not null[\s\S]+claim\.evidence_private_path[\s\S]+item\.state = 'pending'/,
  );
  assertMatch(
    sharedBarrierHolder,
    /begin;[\s\S]+prepare_media_cleanup_batch\(\)[\s\S]+SPOTTR_CLAIM_EVIDENCE_SHARED_BARRIER_READY[\s\S]+\\prompt '' release_signal[\s\S]+rollback;/,
  );
  assertMatch(
    exclusiveBarrierHolder,
    /begin;[\s\S]+pg_advisory_xact_lock\(7742004, 1\)[\s\S]+SPOTTR_CLAIM_EVIDENCE_EXCLUSIVE_BARRIER_READY[\s\S]+\\prompt '' release_signal[\s\S]+rollback;/,
  );
  assertMatch(
    mutationRollbackSetup,
    /insert into public\.business_claims[\s\S]+evidence_private_path[\s\S]+insert into storage\.objects/,
  );
  assertMatch(
    mutationRollbackAssertion,
    /to_regclass\('private\.business_claim_evidence'\) is not null[\s\S]+claim\.evidence_private_path[\s\S]+business_claims_legacy_evidence_path_retired/,
  );
});

Deno.test("generic cleanup and account deletion exclude every retained evidence path", () => {
  const cleanup = section(
    "create or replace function public.prepare_media_cleanup_batch()",
    "revoke all on function public.prepare_media_cleanup_batch()",
  );
  const accountDeletion = section(
    "create or replace function public.prepare_account_deletion_storage_batch(",
    "revoke all on function public.prepare_account_deletion_storage_batch(uuid, uuid)",
  );
  for (const body of [cleanup, accountDeletion]) {
    assertMatch(body, /private\.business_claim_evidence/);
    assertMatch(body, /evidence\.lifecycle_state <> 'purged'/);
    assert(!body.includes("evidence_private_path"));
  }
  assertMatch(
    migration,
    /create trigger enforce_claim_evidence_account_deletion_seal[\s\S]+before update of state on private\.account_deletion_requests/,
  );
  assertMatch(
    accountDeletion,
    /business_claim_evidence_account_deletion_exceptions/,
  );
  assertMatch(accountDeletion, /'preserved_evidence_count'/);
  assertMatch(migration, /ACCOUNT_DELETION_CLAIM_EVIDENCE_NOT_SEALED/);
});

Deno.test("authenticated quarantine deletion cannot remove retained claim evidence", () => {
  assertMatch(
    migration,
    /create or replace function private\.is_protected_business_claim_evidence_path/,
  );
  assertMatch(
    migration,
    /revoke all on function private\.is_protected_business_claim_evidence_path\(text\)\s+from public, anon, authenticated, service_role;[\s\S]+grant execute on function private\.is_protected_business_claim_evidence_path\(text\)\s+to authenticated;/,
  );
  assertMatch(
    migration,
    /drop policy if exists "users delete own quarantine media" on storage\.objects;[\s\S]+create policy "users delete own quarantine media"[\s\S]+not private\.is_protected_business_claim_evidence_path\(name\)/,
  );
  assertMatch(
    runtimeSql,
    /business_claim_evidence_storage_delete_policy_contract[\s\S]+Direct deletion from storage tables is not allowed[\s\S]+storage\.allow_delete_query[\s\S]+deleted_count <> 0[\s\S]+deleted_count <> 1/,
  );
  assertMatch(
    runtimeSql,
    /business_claim_evidence_auth_delete_contract[\s\S]+delete from auth\.users[\s\S]+evidence\.claimant_id is null[\s\S]+deletion_request\.user_id is null[\s\S]+retention_boundary/,
  );
});

Deno.test("purge is default-off, bounded, leased, receipt-driven, and service-only", () => {
  const prepare = section(
    "create or replace function public.prepare_business_claim_evidence_purge_batch()",
    "revoke all on function public.prepare_business_claim_evidence_purge_batch()",
  );
  const finalize = section(
    "create or replace function public.finalize_business_claim_evidence_purge_batch(",
    "revoke all on function public.finalize_business_claim_evidence_purge_batch(uuid, text[])",
  );
  assertMatch(migration, /intake_enabled boolean not null default false/);
  assertMatch(migration, /purge_enabled boolean not null default false/);
  assertMatch(prepare, /if not coalesce/);
  assertMatch(prepare, /'enabled', false/);
  assertMatch(prepare, /not evidence\.legal_hold/);
  assertMatch(prepare, /retention_policy_version/);
  assertMatch(prepare, /for update of evidence skip locked/);
  assertMatch(prepare, /limit 100/);
  assertMatch(prepare, /interval '15 minutes'/);
  assertMatch(prepare, /business_claim_evidence_purge_receipts/);
  assertMatch(prepare, /state = 'superseded'/);
  assertMatch(finalize, /INVALID_CLAIM_EVIDENCE_PURGE_RECEIPT/);
  assertMatch(finalize, /cardinality\(paths\) > 100/);
  assertMatch(finalize, /if receipt\.state = 'finalized' then/);
  assertMatch(finalize, /'already_finalized', true/);
  assertMatch(finalize, /storage_path = null/);
  assertMatch(
    migration,
    /revoke all on function public\.prepare_business_claim_evidence_purge_batch\(\)\s+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.prepare_business_claim_evidence_purge_batch\(\)\s+to service_role;/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.finalize_business_claim_evidence_purge_batch\(uuid, text\[\]\)\s+from public, anon, authenticated, service_role;[\s\S]+grant execute on function public\.finalize_business_claim_evidence_purge_batch\(uuid, text\[\]\)\s+to service_role;/,
  );
});

Deno.test("legacy cleanup stays retired and durable cleanup rechecks private evidence", () => {
  const finalize = section(
    "create or replace function public.finalize_media_cleanup_batch(",
    "revoke all on function public.finalize_media_cleanup_batch(uuid, text[])",
  );
  assertMatch(finalize, /private\.business_claim_evidence/);
  assertMatch(finalize, /evidence\.lifecycle_state <> 'purged'/);
  assertMatch(
    migration,
    /revoke all on function public\.media_quarantine_cleanup_manifest\(\)\s+from public, anon, authenticated, service_role;/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.finalize_media_quarantine_cleanup\(text\[\]\)\s+from public, anon, authenticated, service_role;/,
  );
});

Deno.test("claim evidence staging consults the server gate before reserving upload capacity", () => {
  const gate = mediaStage.indexOf('"business_claim_evidence_intake_enabled"');
  const rateLimit = mediaStage.indexOf('"consume_media_stage_slot"');
  const grant = mediaStage.indexOf('"create_media_stage_grant"');
  const signedUpload = mediaStage.indexOf(".createSignedUploadUrl(path)");
  assert(
    gate >= 0 && rateLimit > gate && grant > rateLimit && signedUpload > grant,
  );
  assertMatch(mediaStage, /intakeEnabled !== true/);
  assertMatch(mediaStage, /CLAIM_EVIDENCE_INTAKE_DISABLED/);
});
