import {
  adminClient,
  authenticatedUser,
  corsHeaders,
  HttpError,
  jsonResponse,
  normalizeIdempotencyKey,
  optionsResponse,
  publicError,
  readJson,
} from "../_shared/http.ts";

type DeleteBody = { confirmation?: unknown };
type DeletionStart = { request_id: string };

type StorageBatch =
  | { ready: false; retryAfterSeconds: number }
  | { ready: true; paths: string[]; pendingCount: number };

const STORAGE_PATH = /^(?:quarantine|published)\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,510}$/;

function isStoragePath(value: string): boolean {
  return STORAGE_PATH.test(value) &&
    !/(^|\/)\.\.?($|\/)/.test(value) &&
    !value.includes("//") &&
    !value.endsWith("/");
}

function parseStorageBatch(value: unknown): StorageBatch {
  if (!value || typeof value !== "object") {
    throw new HttpError(502, "INVALID_ACCOUNT_DELETE_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  if (record.ready === false) {
    const retry = record.retry_after_seconds;
    if (typeof retry !== "number" || !Number.isInteger(retry) || retry < 1 || retry > 7_800) {
      throw new HttpError(502, "INVALID_ACCOUNT_DELETE_MANIFEST");
    }
    return { ready: false, retryAfterSeconds: retry };
  }
  if (
    record.ready !== true ||
    !Array.isArray(record.storage_paths) ||
    typeof record.pending_count !== "number" ||
    !Number.isInteger(record.pending_count) ||
    record.pending_count < 0 ||
    record.storage_paths.length > 500 ||
    record.storage_paths.some(
      (path) => typeof path !== "string" || path.length > 512 || !isStoragePath(path),
    ) ||
    new Set(record.storage_paths).size !== record.storage_paths.length
  ) {
    throw new HttpError(502, "INVALID_ACCOUNT_DELETE_MANIFEST");
  }
  return {
    ready: true,
    paths: record.storage_paths as string[],
    pendingCount: record.pending_count,
  };
}

async function releaseForRetry(
  admin: ReturnType<typeof adminClient>,
  requestId: string,
): Promise<void> {
  const { error } = await admin.rpc("advance_account_deletion", {
    target_request_id: requestId,
    next_state: "started",
    target_failure_code: null,
  });
  if (error) throw error;
}

async function markFailed(
  admin: ReturnType<typeof adminClient>,
  requestId: string | null,
  failureCode: string,
): Promise<void> {
  if (!requestId) return;
  await admin.rpc("advance_account_deletion", {
    target_request_id: requestId,
    next_state: "failed",
    target_failure_code: failureCode,
  });
}

Deno.serve(async (request) => {
  let cors: HeadersInit = {};
  let requestId: string | null = null;
  let admin: ReturnType<typeof adminClient> | null = null;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return optionsResponse(request);
    if (request.method !== "DELETE") throw new HttpError(405, "METHOD_NOT_ALLOWED");

    const { user } = await authenticatedUser(request, true);
    const key = normalizeIdempotencyKey(request);
    const body = await readJson<DeleteBody>(request, 1024);
    const headerConfirmation = request.headers.get("x-spottr-delete-confirmation");
    if (body.confirmation !== "DELETE" || headerConfirmation !== "DELETE") {
      throw new HttpError(400, "DELETE_CONFIRMATION_REQUIRED");
    }

    admin = adminClient();
    const { data: started, error: startError } = await admin
      .rpc("begin_account_deletion", {
        target_user_id: user.id,
        request_key: key,
      })
      .single();
    const deletionStart = started as DeletionStart | null;
    if (startError || !deletionStart) {
      throw startError ?? new Error("Deletion request unavailable");
    }
    requestId = deletionStart.request_id;

    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_account_deletion",
      {
        target_request_id: requestId,
        target_user_id: user.id,
      },
    );
    if (claimError) throw claimError;
    if (!claimed) {
      return jsonResponse({ status: "processing", request_id: requestId }, 202, cors);
    }

    let storageComplete = false;
    for (let batchNumber = 0; batchNumber < 5; batchNumber += 1) {
      const { data: rawBatch, error: batchError } = await admin.rpc(
        "prepare_account_deletion_storage_batch",
        {
          target_request_id: requestId,
          target_user_id: user.id,
        },
      );
      if (batchError) throw batchError;
      const batch = parseStorageBatch(rawBatch);
      if (!batch.ready) {
        await releaseForRetry(admin, requestId);
        return jsonResponse(
          {
            status: "processing",
            request_id: requestId,
            retry_after_seconds: batch.retryAfterSeconds,
          },
          202,
          cors,
        );
      }

      for (let offset = 0; offset < batch.paths.length; offset += 100) {
        const { error } = await admin.storage
          .from("spottr-media")
          .remove(batch.paths.slice(offset, offset + 100));
        if (error) {
          await markFailed(admin, requestId, "STORAGE_DELETE_FAILED");
          throw new HttpError(503, "ACCOUNT_DELETE_RETRY_REQUIRED");
        }
      }

      const { data: checkpoint, error: checkpointError } = await admin.rpc(
        "checkpoint_account_deletion_storage_batch",
        {
          target_request_id: requestId,
          target_user_id: user.id,
          deleted_storage_paths: batch.paths,
        },
      );
      if (checkpointError) throw checkpointError;
      storageComplete = checkpoint?.storage_complete === true;
      if (storageComplete) break;
    }

    if (!storageComplete) {
      await releaseForRetry(admin, requestId);
      return jsonResponse(
        { status: "processing", request_id: requestId, retry_after_seconds: 1 },
        202,
        cors,
      );
    }

    const { error: storageStateError } = await admin.rpc("advance_account_deletion", {
      target_request_id: requestId,
      next_state: "storage_deleted",
      target_failure_code: null,
    });
    if (storageStateError) throw storageStateError;

    const { error: prepareError } = await admin.rpc("prepare_account_deletion", {
      target_user_id: user.id,
      target_request_id: requestId,
    });
    if (prepareError) {
      await markFailed(admin, requestId, "DATABASE_PREPARE_FAILED");
      throw prepareError;
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
    if (deleteError) {
      await markFailed(admin, requestId, "AUTH_DELETE_FAILED");
      throw new HttpError(503, "ACCOUNT_DELETE_RETRY_REQUIRED");
    }

    const { error: completeError } = await admin.rpc("advance_account_deletion", {
      target_request_id: requestId,
      next_state: "completed",
      target_failure_code: null,
    });
    if (completeError) console.error("Deletion completed but receipt update failed", completeError);

    return jsonResponse(
      { status: "deleted", request_id: requestId },
      200,
      cors,
    );
  } catch (error) {
    if (
      admin &&
      requestId &&
      !(error instanceof HttpError && error.code === "ACCOUNT_DELETE_RETRY_REQUIRED")
    ) {
      await markFailed(admin, requestId, "UNEXPECTED_FAILURE");
    }
    return publicError(error, cors);
  }
});
