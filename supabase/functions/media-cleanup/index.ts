import {
  adminClient,
  HttpError,
  internalBearer,
  jsonResponse,
  publicError,
} from "../_shared/http.ts";
import {
  chunkPaths,
  parseCleanupBatch,
  parseLegacyCleanupPaths,
} from "./contract.ts";

async function removePaths(admin: ReturnType<typeof adminClient>, paths: string[]) {
  for (const chunk of chunkPaths(paths)) {
    const { error } = await admin.storage.from("spottr-media").remove(chunk);
    if (error) throw new HttpError(503, "MEDIA_CLEANUP_RETRY_REQUIRED");
  }
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    internalBearer(request, "SPOTTR_MEDIA_CLEANUP_SECRET");

    const admin = adminClient();
    const { data: chatManifest, error: chatManifestError } = await admin.rpc(
      "prepare_chat_media_cleanup_batch",
    );
    if (chatManifestError) throw chatManifestError;
    const chatBatch = parseCleanupBatch(chatManifest);
    await removePaths(admin, chatBatch.paths);
    const { data: chatFinalized, error: chatFinalizeError } = await admin.rpc(
      "finalize_chat_media_cleanup_batch",
      {
        target_batch_id: chatBatch.batchId,
        deleted_storage_paths: chatBatch.paths,
      },
    );
    if (chatFinalizeError) throw chatFinalizeError;

    const { data: manifest, error: manifestError } = await admin.rpc(
      "media_quarantine_cleanup_manifest",
    );
    if (manifestError) throw manifestError;
    const paths = parseLegacyCleanupPaths(manifest);
    await removePaths(admin, paths);

    const { data: deletedRecords, error: finalizeError } = await admin.rpc(
      "finalize_media_quarantine_cleanup",
      { target_storage_paths: paths },
    );
    if (finalizeError) throw finalizeError;

    return jsonResponse({
      status: "complete",
      deleted_objects: chatBatch.paths.length + paths.length,
      deleted_chat_asset_records: chatFinalized?.deleted_asset_records ?? 0,
      deleted_quarantine_asset_records: deletedRecords ?? 0,
    });
  } catch (error) {
    return publicError(error);
  }
});
