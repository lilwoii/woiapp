import {
  adminClient,
  HttpError,
  internalBearer,
  jsonResponse,
  publicError,
} from "../_shared/http.ts";

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    internalBearer(request, "SPOTTR_MEDIA_CLEANUP_SECRET");

    const admin = adminClient();
    const { data: manifest, error: manifestError } = await admin.rpc(
      "media_quarantine_cleanup_manifest",
    );
    if (manifestError) throw manifestError;
    const paths = Array.isArray(manifest?.storage_paths)
      ? (manifest.storage_paths as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
      : [];

    for (let offset = 0; offset < paths.length; offset += 100) {
      const { error } = await admin.storage
        .from("spottr-media")
        .remove(paths.slice(offset, offset + 100));
      if (error) throw new HttpError(503, "MEDIA_CLEANUP_RETRY_REQUIRED");
    }

    const { data: deletedRecords, error: finalizeError } = await admin.rpc(
      "finalize_media_quarantine_cleanup",
      { target_storage_paths: paths },
    );
    if (finalizeError) throw finalizeError;

    return jsonResponse({
      status: "complete",
      deleted_objects: paths.length,
      deleted_asset_records: deletedRecords ?? 0,
    });
  } catch (error) {
    return publicError(error);
  }
});

