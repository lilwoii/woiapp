import {
  adminClient,
  HttpError,
  internalBearer,
  jsonResponse,
  publicError,
  readJson,
} from "../_shared/http.ts";

type ScanBody = { assetId?: unknown };
type ScannerResult = {
  verdict?: unknown;
  reasonCode?: unknown;
  malwareClean?: unknown;
  contentSafe?: unknown;
  reencoded?: unknown;
  metadataStripped?: unknown;
  outputBase64?: unknown;
  mimeType?: unknown;
  width?: unknown;
  height?: unknown;
  sha256?: unknown;
};

type ScanClaim = {
  status: "claimed";
  assetId: string;
  attemptToken: string;
  businessId: string | null;
  storagePath: string;
  source: "owner_upload" | "review_upload" | "chat_upload" | "licensed_provider";
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseScanClaim(
  value: unknown,
): ScanClaim | { status: "clean" | "rejected"; assetId: string } {
  if (!value || typeof value !== "object") throw new HttpError(502, "INVALID_SCAN_CLAIM");
  const claim = value as Record<string, unknown>;
  if (
    (claim.status === "clean" || claim.status === "rejected") &&
    typeof claim.asset_id === "string" &&
    UUID_PATTERN.test(claim.asset_id)
  ) {
    return { status: claim.status, assetId: claim.asset_id };
  }
  if (
    claim.status !== "claimed" ||
    typeof claim.asset_id !== "string" ||
    !UUID_PATTERN.test(claim.asset_id) ||
    typeof claim.attempt_token !== "string" ||
    !UUID_PATTERN.test(claim.attempt_token) ||
    (claim.business_id !== null &&
      claim.business_id !== undefined &&
      (typeof claim.business_id !== "string" || !UUID_PATTERN.test(claim.business_id))) ||
    typeof claim.storage_path !== "string" ||
    !/^quarantine\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(claim.storage_path) ||
    !["owner_upload", "review_upload", "chat_upload", "licensed_provider"].includes(
      String(claim.source),
    )
  ) {
    throw new HttpError(502, "INVALID_SCAN_CLAIM");
  }
  return {
    status: "claimed",
    assetId: claim.asset_id,
    attemptToken: claim.attempt_token,
    businessId: typeof claim.business_id === "string" ? claim.business_id : null,
    storagePath: claim.storage_path,
    source: claim.source as ScanClaim["source"],
  };
}

function scanFinalizationStatus(value: unknown): string {
  if (!value || typeof value !== "object") throw new HttpError(502, "INVALID_SCAN_FINALIZATION");
  const status = (value as Record<string, unknown>).status;
  if (status !== "clean" && status !== "rejected" && status !== "abandoned_for_account_deletion") {
    throw new HttpError(502, "INVALID_SCAN_FINALIZATION");
  }
  return status;
}

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function pipelineConfig(): { url: string; key: string } {
  if (Deno.env.get("SPOTTR_MEDIA_PIPELINE_ENABLED") !== "true") {
    throw new HttpError(503, "MEDIA_PIPELINE_DISABLED");
  }
  const url = Deno.env.get("SPOTTR_MEDIA_SCANNER_URL")?.trim() ?? "";
  const key = Deno.env.get("SPOTTR_MEDIA_SCANNER_API_KEY")?.trim() ?? "";
  if (!url.startsWith("https://") || key.length < 32) {
    throw new HttpError(503, "MEDIA_SCANNER_NOT_CONFIGURED");
  }
  return { url, key };
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new HttpError(502, "INVALID_SCANNER_OUTPUT");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hasExpectedMagic(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/png") {
    return bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        .every((value, index) => bytes[index] === value);
  }
  if (mime === "image/webp") {
    return bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer so Deno's WebCrypto type contract cannot
  // receive a SharedArrayBuffer-backed view.
  const digestInput = Uint8Array.from(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    internalBearer(request, "SPOTTR_MEDIA_SCAN_SECRET");
    const scanner = pipelineConfig();
    const body = await readJson<ScanBody>(request, 2048);
    if (
      typeof body.assetId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(body.assetId)
    ) {
      throw new HttpError(400, "INVALID_ASSET_ID");
    }

    const admin = adminClient();
    const { data: rawClaim, error: claimError } = await admin.rpc(
      "claim_media_scan_attempt",
      { target_asset_id: body.assetId },
    );
    if (claimError) {
      if (claimError.message.includes("MEDIA_SCAN_IN_PROGRESS")) {
        return jsonResponse({ status: "processing", asset_id: body.assetId }, 202);
      }
      if (claimError.message.includes("MEDIA_ASSET_NOT_FOUND")) {
        throw new HttpError(404, "MEDIA_ASSET_NOT_FOUND");
      }
      throw claimError;
    }
    const asset = parseScanClaim(rawClaim);
    if (asset.status !== "claimed") {
      return jsonResponse({ status: asset.status, asset_id: asset.assetId });
    }

    const { data: signedInput, error: signError } = await admin.storage
      .from("spottr-media")
      .createSignedUrl(asset.storagePath, 300);
    if (signError || !signedInput) throw new HttpError(503, "MEDIA_INPUT_UNAVAILABLE");

    const scanResponse = await fetch(scanner.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${scanner.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: "2026-07-29",
        assetId: asset.assetId,
        inputUrl: signedInput.signedUrl,
        policy: {
          allowedMimeTypes: Object.keys(MIME_EXTENSION),
          maxOutputBytes: 5_242_880,
          maxDimension: 8192,
          requireMalwareClean: true,
          requireContentSafe: true,
          requireMetadataStripped: true,
          requireReencode: true,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const rawResult = await scanResponse.text();
    if (
      !scanResponse.ok ||
      new TextEncoder().encode(rawResult).byteLength > 7_500_000
    ) {
      throw new HttpError(503, "MEDIA_SCANNER_UNAVAILABLE");
    }

    let result: ScannerResult;
    try {
      result = JSON.parse(rawResult) as ScannerResult;
    } catch {
      throw new HttpError(502, "INVALID_SCANNER_OUTPUT");
    }

    if (result.verdict === "rejected") {
      const reasonCode = typeof result.reasonCode === "string" &&
          /^[A-Z0-9_]{3,80}$/.test(result.reasonCode)
        ? result.reasonCode
        : "CONTENT_POLICY_REJECTED";
      const { data: finalized, error } = await admin.rpc("finalize_media_scan_attempt", {
        target_asset_id: asset.assetId,
        target_attempt_token: asset.attemptToken,
        scan_state: "rejected",
        clean_storage_path: null,
        clean_mime_type: null,
        clean_width: null,
        clean_height: null,
        clean_byte_size: null,
        clean_sha256: null,
        scan_rejection_reason: reasonCode,
      });
      if (error) throw error;
      if (scanFinalizationStatus(finalized) === "abandoned_for_account_deletion") {
        return jsonResponse(
          { status: "account_deletion_in_progress", asset_id: asset.assetId },
          202,
        );
      }
      return jsonResponse({ status: "rejected", asset_id: asset.assetId }, 200);
    }

    if (
      result.verdict !== "clean" ||
      result.malwareClean !== true ||
      result.contentSafe !== true ||
      result.reencoded !== true ||
      result.metadataStripped !== true ||
      typeof result.outputBase64 !== "string" ||
      typeof result.mimeType !== "string" ||
      !(result.mimeType in MIME_EXTENSION) ||
      !Number.isInteger(result.width) ||
      !Number.isInteger(result.height) ||
      (result.width as number) < 1 ||
      (result.width as number) > 8192 ||
      (result.height as number) < 1 ||
      (result.height as number) > 8192 ||
      typeof result.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(result.sha256)
    ) {
      throw new HttpError(502, "INVALID_SCANNER_OUTPUT");
    }

    const bytes = decodeBase64(result.outputBase64);
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > 5_242_880 ||
      !hasExpectedMagic(bytes, result.mimeType)
    ) {
      throw new HttpError(502, "INVALID_SCANNER_OUTPUT");
    }
    const computedHash = await sha256Hex(bytes);
    if (computedHash !== result.sha256) {
      throw new HttpError(502, "SCANNER_HASH_MISMATCH");
    }

    const namespace = asset.source === "review_upload"
      ? `reviews/${asset.businessId ?? "unscoped"}`
      : asset.source === "chat_upload"
      ? `chat/${asset.businessId ?? "unscoped"}`
      : asset.businessId
      ? `businesses/${asset.businessId}`
      : "profiles";
    const cleanPath = `published/${namespace}/${asset.assetId}/${asset.attemptToken}.${
      MIME_EXTENSION[result.mimeType]
    }`;

    const { error: planError } = await admin.rpc("plan_media_scan_output", {
      target_asset_id: asset.assetId,
      target_attempt_token: asset.attemptToken,
      target_output_path: cleanPath,
    });
    if (planError) throw planError;

    const { error: uploadError } = await admin.storage
      .from("spottr-media")
      .upload(cleanPath, bytes, {
        cacheControl: "31536000",
        contentType: result.mimeType,
        upsert: false,
      });
    if (uploadError) throw new HttpError(503, "MEDIA_OUTPUT_STORE_FAILED");

    const { data: finalized, error: finalizeError } = await admin.rpc(
      "finalize_media_scan_attempt",
      {
        target_asset_id: asset.assetId,
        target_attempt_token: asset.attemptToken,
        scan_state: "clean",
        clean_storage_path: cleanPath,
        clean_mime_type: result.mimeType,
        clean_width: result.width,
        clean_height: result.height,
        clean_byte_size: bytes.byteLength,
        clean_sha256: computedHash,
        scan_rejection_reason: null,
      },
    );
    if (finalizeError) throw finalizeError;
    if (scanFinalizationStatus(finalized) === "abandoned_for_account_deletion") {
      return jsonResponse(
        { status: "account_deletion_in_progress", asset_id: asset.assetId },
        202,
      );
    }

    // The clean, re-encoded output is now authoritative. Raw quarantine input
    // is best-effort deleted here; the scheduled cleanup worker retries safely.
    const { error: rawDeleteError } = await admin.storage
      .from("spottr-media")
      .remove([asset.storagePath]);
    if (rawDeleteError) console.error("MEDIA_RAW_SOURCE_CLEANUP_DEFERRED");

    return jsonResponse({
      status: "clean_approved",
      asset_id: asset.assetId,
    });
  } catch (error) {
    return publicError(error);
  }
});
