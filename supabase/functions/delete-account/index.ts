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

    const { data: manifest, error: manifestError } = await admin.rpc(
      "account_deletion_manifest",
      { target_user_id: user.id },
    );
    if (manifestError) throw manifestError;
    const storagePaths = Array.isArray(manifest?.storage_paths)
      ? (manifest.storage_paths as unknown[]).filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      )
      : [];

    for (let offset = 0; offset < storagePaths.length; offset += 100) {
      const { error } = await admin.storage
        .from("spottr-media")
        .remove(storagePaths.slice(offset, offset + 100));
      if (error) {
        await markFailed(admin, requestId, "STORAGE_DELETE_FAILED");
        throw new HttpError(503, "ACCOUNT_DELETE_RETRY_REQUIRED");
      }
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
