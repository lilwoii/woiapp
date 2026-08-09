import { assert, assertMatch } from "jsr:@std/assert@1";

const queueSql = await Deno.readTextFile(
  new URL(
    "../migrations/20260811000000_account_deletion_continuation.sql",
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
