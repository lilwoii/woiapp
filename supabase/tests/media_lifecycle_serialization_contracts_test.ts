import { assert, assertMatch } from "jsr:@std/assert@1";

const migration = await Deno.readTextFile(
  new URL(
    "../migrations/20260810000000_media_lifecycle_serialization.sql",
    import.meta.url,
  ),
);
const stage = await Deno.readTextFile(
  new URL("../functions/media-stage/index.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../functions/media-scan/index.ts", import.meta.url),
);
const cleanup = await Deno.readTextFile(
  new URL("../functions/media-cleanup/index.ts", import.meta.url),
);
const deletion = await Deno.readTextFile(
  new URL("../functions/delete-account/index.ts", import.meta.url),
);

Deno.test("signed uploads are persisted and fenced before capability minting", () => {
  assertMatch(
    migration,
    /create table if not exists private\.media_stage_grants/,
  );
  assertMatch(
    migration,
    /create or replace function public\.create_media_stage_grant/,
  );
  assertMatch(migration, /pg_advisory_xact_lock\([\s\S]*7741902/);
  assertMatch(
    migration,
    /create trigger consume_media_stage_grant\s+after insert/,
  );
  assertMatch(migration, /ACCOUNT_MUTATIONS_FROZEN/);
  const reserve = stage.indexOf("create_media_stage_grant");
  const mint = stage.indexOf("createSignedUploadUrl");
  const cancel = stage.indexOf("cancel_media_stage_grant");
  assert(reserve >= 0 && mint > reserve && cancel > mint);
});

Deno.test("scan attempts use leases, unique outputs, and token CAS finalization", () => {
  assertMatch(
    migration,
    /create table if not exists private\.media_scan_claims/,
  );
  assertMatch(migration, /attempt_token uuid not null unique/);
  assertMatch(migration, /lease_expires_at timestamptz not null/);
  assertMatch(migration, /MEDIA_SCAN_IN_PROGRESS/);
  assertMatch(migration, /claim\.attempt_token <> target_attempt_token/);
  const claim = scanner.indexOf("claim_media_scan_attempt");
  const plan = scanner.indexOf("plan_media_scan_output");
  const upload = scanner.indexOf(".upload(cleanPath");
  const finalize = scanner.lastIndexOf("finalize_media_scan_attempt");
  assert(claim >= 0 && plan > claim && upload > plan && finalize > upload);
  assertMatch(scanner, /asset\.assetId}\/\$\{asset\.attemptToken}/);
  assertMatch(scanner, /upsert: false/);
  assert(!scanner.includes("record_media_scan_result"));
});

Deno.test("generic cleanup is durable across storage and database failures", () => {
  assertMatch(
    migration,
    /create table if not exists private\.media_cleanup_items/,
  );
  assertMatch(migration, /for update skip locked/);
  assertMatch(migration, /state = 'claimed'/);
  assertMatch(migration, /INVALID_MEDIA_CLEANUP_RECEIPT/);
  assertMatch(
    migration,
    /cardinality\(paths\) <> \([\s\S]*batch_id = target_batch_id/,
  );
  assertMatch(
    migration,
    /revoke all on function public\.media_quarantine_cleanup_manifest\(\)[\s\S]*service_role/,
  );
  const prepare = cleanup.indexOf("prepare_media_cleanup_batch");
  const remove = cleanup.lastIndexOf("removePaths");
  const finalize = cleanup.indexOf("finalize_media_cleanup_batch");
  assert(prepare >= 0 && remove > prepare && finalize > remove);
  assert(!cleanup.includes("media_quarantine_cleanup_manifest"));
});

Deno.test("account deletion freezes first and seals every storage checkpoint", () => {
  assertMatch(
    migration,
    /create table if not exists private\.account_deletion_freezes/,
  );
  assertMatch(migration, /update public\.profiles set status = 'deleted'/);
  assertMatch(
    migration,
    /state in \('issued', 'registered'\) and grant\.expires_at > now\(\)/,
  );
  assertMatch(
    migration,
    /create table if not exists private\.account_deletion_storage_items/,
  );
  assertMatch(migration, /ACCOUNT_DELETION_STORAGE_NOT_SEALED/);
  assertMatch(migration, /request\.state = 'storage_deleted'/);
  assertMatch(migration, /claim\.lease_expires_at \+ interval '15 minutes'/);
  assertMatch(
    migration,
    /revoke all on function public\.account_deletion_manifest/,
  );
  const sendFence = migration.slice(
    migration.lastIndexOf(
      "create or replace function public.send_marketplace_message",
    ),
  );
  assertMatch(sendFence, /pg_advisory_xact_lock\([\s\S]*7741902/);
  assertMatch(sendFence, /send_marketplace_message_dlp_core/);
  const begin = deletion.indexOf("begin_account_deletion");
  const claim = deletion.indexOf("claim_account_deletion");
  const batch = deletion.indexOf("prepare_account_deletion_storage_batch");
  const checkpoint = deletion.indexOf(
    "checkpoint_account_deletion_storage_batch",
  );
  const authDelete = deletion.indexOf("deleteUser");
  assert(
    begin >= 0 && claim > begin && batch > claim && checkpoint > batch &&
      authDelete > checkpoint,
  );
  assert(!deletion.includes("account_deletion_manifest"));
});
