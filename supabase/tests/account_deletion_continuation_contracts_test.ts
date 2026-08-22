import { assert, assertMatch } from "jsr:@std/assert@1";

const queueSql = await Deno.readTextFile(
  new URL(
    "../migrations/20260811000000_account_deletion_continuation.sql",
    import.meta.url,
  ),
);
const receiptRecoverySql = await Deno.readTextFile(
  new URL(
    "../migrations/20260821000000_account_deletion_receipt_recovery.sql",
    import.meta.url,
  ),
);
const lifecycleSql = await Deno.readTextFile(
  new URL(
    "../migrations/20260810000000_media_lifecycle_serialization.sql",
    import.meta.url,
  ),
);
const worker = await Deno.readTextFile(
  new URL("../functions/delete-account-worker/index.ts", import.meta.url),
);
const deletion = await Deno.readTextFile(
  new URL("../functions/delete-account/index.ts", import.meta.url),
);
const authContext = await Deno.readTextFile(
  new URL("../../context/auth-context.tsx", import.meta.url),
);
const config = await Deno.readTextFile(
  new URL("../config.toml", import.meta.url),
);
const env = await Deno.readTextFile(
  new URL("../functions/.env.example", import.meta.url),
);

Deno.test("frozen deletion requests have a service-only autonomous queue", () => {
  assertMatch(
    queueSql,
    /create or replace function public\.claim_next_account_deletion/,
  );
  assertMatch(queueSql, /for update of request skip locked/);
  assertMatch(queueSql, /join private\.account_deletion_freezes/);
  assertMatch(
    queueSql,
    /grant execute on function public\.claim_next_account_deletion\(\) to service_role/,
  );
  assertMatch(
    worker,
    /internalBearer\(request, "SPOTTR_ACCOUNT_DELETE_WORKER_SECRET"\)/,
  );
  assertMatch(
    config,
    /\[functions\.delete-account-worker\]\s+verify_jwt = false/,
  );
  assertMatch(env, /SPOTTR_ACCOUNT_DELETE_WORKER_SECRET=/);
});

Deno.test("continuation preserves the storage seal before Auth deletion", () => {
  const claim = worker.indexOf("claim_next_account_deletion");
  const prepare = worker.indexOf("prepare_account_deletion_storage_batch");
  const checkpoint = worker.indexOf(
    "checkpoint_account_deletion_storage_batch",
  );
  const seal = worker.indexOf(
    'await transition(admin, requestId, "storage_deleted")',
  );
  const authDelete = worker.indexOf("deleteUser");
  assert(
    claim >= 0 && prepare > claim && checkpoint > prepare &&
      seal > checkpoint && authDelete > seal,
  );
  assertMatch(worker, /return jsonResponse\(\{\s+status: "waiting"/);
  assertMatch(worker, /return jsonResponse\(\{ status: "more_work"/);
});

Deno.test("post-Auth receipt finalization is service-only and recoverable", () => {
  assertMatch(
    receiptRecoverySql,
    /create or replace function public\.finalize_account_deletion_receipt/,
  );
  assertMatch(
    receiptRecoverySql,
    /create or replace function public\.finalize_next_account_deletion_receipt/,
  );
  assertMatch(receiptRecoverySql, /current_request\.user_id is null/);
  assertMatch(receiptRecoverySql, /current_request\.state = 'storage_deleted'/);
  assertMatch(receiptRecoverySql, /for update of current_request skip locked/);
  assertMatch(
    receiptRecoverySql,
    /revoke all on function public\.finalize_next_account_deletion_receipt\(\)[\s\S]*from public, anon, authenticated/,
  );
  assertMatch(
    receiptRecoverySql,
    /grant execute on function public\.finalize_next_account_deletion_receipt\(\)[\s\S]*to service_role/,
  );

  const pendingReceipt = worker.indexOf("finalize_next_account_deletion_receipt");
  const queueClaim = worker.indexOf("claim_next_account_deletion");
  const authDelete = worker.indexOf("deleteUser");
  const exactReceipt = worker.lastIndexOf("finalize_account_deletion_receipt");
  assert(
    pendingReceipt >= 0 && queueClaim > pendingReceipt && authDelete > queueClaim &&
      exactReceipt > authDelete,
  );
});

Deno.test("receipt persistence failure never claims deletion is complete", () => {
  const directAuthDelete = deletion.indexOf("deleteUser");
  const directReceipt = deletion.indexOf("finalize_account_deletion_receipt");
  assert(directAuthDelete >= 0 && directReceipt > directAuthDelete);
  assertMatch(deletion, /status: "processing",\s+phase: "receipt_finalization"/);
  assertMatch(deletion, /account_removed: true/);
  assertMatch(deletion, /retry_after_seconds: 60/);
  assertMatch(worker, /status: "waiting",\s+phase: "receipt_finalization"/);
  assertMatch(worker, /ACCOUNT_DELETE_RECEIPT_FINALIZATION_PENDING/);
  assertMatch(authContext, /response\?\.phase === 'receipt_finalization'/);
  assertMatch(authContext, /response\?\.account_removed === true/);
  assertMatch(authContext, /client\.auth\.signOut\(\{ scope: 'local' \}\)/);
});

Deno.test("an ambiguous Auth deletion result preserves the sealed retry state", () => {
  for (const source of [deletion, worker]) {
    const authDelete = source.indexOf("deleteUser");
    const exactReceipt = source.indexOf(
      "finalize_account_deletion_receipt",
      authDelete,
    );
    const authWindow = source.slice(authDelete, exactReceipt);
    assert(authDelete >= 0 && exactReceipt > authDelete);
    assertMatch(authWindow, /ACCOUNT_DELETE_AUTH_RESULT_UNCERTAIN/);
    assertMatch(authWindow, /catch \{/);
    assert(!authWindow.includes("AUTH_DELETE_FAILED"));
    assert(!authWindow.includes('"failed"'));
  }
  assertMatch(deletion, /status: "processing",\s+phase: "auth_deletion"/);
  assertMatch(worker, /status: "waiting",\s+phase: "auth_deletion"/);
  assertMatch(deletion, /!authDeletionConfirmed/);
  assertMatch(worker, /!authDeletionConfirmed/);
});

Deno.test("cleanup cannot starve or race protected claim evidence", () => {
  const producer = lifecycleSql.slice(
    lifecycleSql.indexOf("for target_storage_path in"),
    lifecycleSql.indexOf("for target_asset_id in"),
  );
  assertMatch(producer, /not exists \([\s\S]*public\.media_assets/);
  assertMatch(producer, /not exists \([\s\S]*private\.media_stage_grants/);
  assertMatch(producer, /not exists \([\s\S]*public\.business_claims/);
  assertMatch(lifecycleSql, /CLAIM_EVIDENCE_CLEANUP_STARTED/);
  const claimWrapper = lifecycleSql.slice(
    lifecycleSql.lastIndexOf(
      "create or replace function public.submit_business_claim",
    ),
  );
  assertMatch(claimWrapper, /pg_advisory_xact_lock\([\s\S]*7741903/);
  assertMatch(claimWrapper, /media_cleanup_items/);
});
