import {
  adminClient,
  HttpError,
  internalBearer,
  jsonResponse,
  publicError,
} from "../_shared/http.ts";

type QueueClaim = { request_id: string; user_id: string };
type FinalizedReceipt = { request_id: string };
type StorageBatch =
  | { ready: false; retryAfterSeconds: number }
  | { ready: true; paths: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PATH = /^(?:quarantine|published)\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,510}$/;

function isStoragePath(value: string): boolean {
  return STORAGE_PATH.test(value) &&
    !/(^|\/)\.\.?($|\/)/.test(value) &&
    !value.includes("//") &&
    !value.endsWith("/");
}

function parseQueueClaim(value: unknown): QueueClaim | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") {
    throw new HttpError(502, "INVALID_ACCOUNT_DELETE_QUEUE_CLAIM");
  }
  const claim = value as Record<string, unknown>;
  if (
    typeof claim.request_id !== "string" || !UUID.test(claim.request_id) ||
    typeof claim.user_id !== "string" || !UUID.test(claim.user_id)
  ) {
    throw new HttpError(502, "INVALID_ACCOUNT_DELETE_QUEUE_CLAIM");
  }
  return { request_id: claim.request_id, user_id: claim.user_id };
}

function parseFinalizedReceipt(value: unknown): FinalizedReceipt | null {
  if (value === null) return null;
  if (
    !value || typeof value !== "object" ||
    typeof (value as Record<string, unknown>).request_id !== "string" ||
    !UUID.test((value as Record<string, unknown>).request_id as string)
  ) {
    throw new HttpError(502, "INVALID_ACCOUNT_DELETE_RECEIPT");
  }
  return {
    request_id: (value as Record<string, unknown>).request_id as string,
  };
}

function parseStorageBatch(value: unknown): StorageBatch {
  if (!value || typeof value !== "object") {
    throw new HttpError(502, "INVALID_ACCOUNT_DELETE_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  if (record.ready === false) {
    const retry = record.retry_after_seconds;
    if (
      typeof retry !== "number" || !Number.isInteger(retry) ||
      retry < 1 || retry > 7_800
    ) {
      throw new HttpError(502, "INVALID_ACCOUNT_DELETE_MANIFEST");
    }
    return { ready: false, retryAfterSeconds: retry };
  }
  if (
    record.ready !== true || !Array.isArray(record.storage_paths) ||
    record.storage_paths.length > 500 ||
    record.storage_paths.some((path) =>
      typeof path !== "string" || path.length > 512 || !isStoragePath(path)
    ) || new Set(record.storage_paths).size !== record.storage_paths.length
  ) {
    throw new HttpError(502, "INVALID_ACCOUNT_DELETE_MANIFEST");
  }
  return { ready: true, paths: record.storage_paths as string[] };
}

async function transition(
  admin: ReturnType<typeof adminClient>,
  requestId: string,
  state: "started" | "storage_deleted" | "completed" | "failed",
  failureCode: string | null = null,
): Promise<void> {
  const { error } = await admin.rpc("advance_account_deletion", {
    target_request_id: requestId,
    next_state: state,
    target_failure_code: failureCode,
  });
  if (error) throw error;
}

Deno.serve(async (request) => {
  let requestId: string | null = null;
  let admin: ReturnType<typeof adminClient> | null = null;
  let authDeletionConfirmed = false;
  try {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    internalBearer(request, "SPOTTR_ACCOUNT_DELETE_WORKER_SECRET");
    admin = adminClient();

    const { data: rawFinalizedReceipt, error: finalizePendingError } = await admin
      .rpc("finalize_next_account_deletion_receipt")
      .maybeSingle();
    if (finalizePendingError) throw finalizePendingError;
    const finalizedReceipt = parseFinalizedReceipt(rawFinalizedReceipt);
    if (finalizedReceipt) {
      return jsonResponse({
        status: "deleted",
        request_id: finalizedReceipt.request_id,
      });
    }

    const { data: rawClaim, error: claimError } = await admin
      .rpc("claim_next_account_deletion")
      .maybeSingle();
    if (claimError) throw claimError;
    const claim = parseQueueClaim(rawClaim);
    if (!claim) return jsonResponse({ status: "idle" });
    requestId = claim.request_id;

    let storageComplete = false;
    for (let batchNumber = 0; batchNumber < 5; batchNumber += 1) {
      const { data: rawBatch, error: batchError } = await admin.rpc(
        "prepare_account_deletion_storage_batch",
        { target_request_id: requestId, target_user_id: claim.user_id },
      );
      if (batchError) throw batchError;
      const batch = parseStorageBatch(rawBatch);
      if (!batch.ready) {
        await transition(admin, requestId, "started");
        return jsonResponse({
          status: "waiting",
          request_id: requestId,
          retry_after_seconds: batch.retryAfterSeconds,
        }, 202);
      }

      for (let offset = 0; offset < batch.paths.length; offset += 100) {
        const { error } = await admin.storage.from("spottr-media")
          .remove(batch.paths.slice(offset, offset + 100));
        if (error) {
          await transition(admin, requestId, "failed", "STORAGE_DELETE_FAILED");
          throw new HttpError(503, "ACCOUNT_DELETE_RETRY_REQUIRED");
        }
      }

      const { data: checkpoint, error: checkpointError } = await admin.rpc(
        "checkpoint_account_deletion_storage_batch",
        {
          target_request_id: requestId,
          target_user_id: claim.user_id,
          deleted_storage_paths: batch.paths,
        },
      );
      if (checkpointError) throw checkpointError;
      storageComplete = checkpoint?.storage_complete === true;
      if (storageComplete) break;
    }

    if (!storageComplete) {
      await transition(admin, requestId, "started");
      return jsonResponse({ status: "more_work", request_id: requestId }, 202);
    }

    await transition(admin, requestId, "storage_deleted");
    const { error: prepareError } = await admin.rpc("prepare_account_deletion", {
      target_user_id: claim.user_id,
      target_request_id: requestId,
    });
    if (prepareError) {
      await transition(admin, requestId, "failed", "DATABASE_PREPARE_FAILED");
      throw prepareError;
    }

    let authDeleteUncertain = false;
    try {
      const { error: deleteError } = await admin.auth.admin.deleteUser(
        claim.user_id,
        false,
      );
      authDeleteUncertain = Boolean(deleteError);
    } catch {
      authDeleteUncertain = true;
    }
    if (authDeleteUncertain) {
      console.error("ACCOUNT_DELETE_AUTH_RESULT_UNCERTAIN");
      return jsonResponse({
        status: "waiting",
        phase: "auth_deletion",
        request_id: requestId,
        retry_after_seconds: 60,
      }, 202);
    }
    authDeletionConfirmed = true;
    const { data: receiptCompleted, error: completeError } = await admin.rpc(
      "finalize_account_deletion_receipt",
      { target_request_id: requestId },
    );
    if (completeError || receiptCompleted !== true) {
      console.error("ACCOUNT_DELETE_RECEIPT_FINALIZATION_PENDING");
      return jsonResponse({
        status: "waiting",
        phase: "receipt_finalization",
        request_id: requestId,
        retry_after_seconds: 60,
      }, 202);
    }
    return jsonResponse({ status: "deleted", request_id: requestId });
  } catch (error) {
    if (
      admin && requestId &&
      !authDeletionConfirmed &&
      !(error instanceof HttpError &&
        error.code === "ACCOUNT_DELETE_RETRY_REQUIRED")
    ) {
      try {
        await transition(admin, requestId, "failed", "UNEXPECTED_FAILURE");
      } catch {
        console.error("ACCOUNT_DELETE_WORKER_FAILURE_CHECKPOINT_FAILED");
      }
    }
    return publicError(error);
  }
});
