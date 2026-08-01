import { adminClient, HttpError, jsonResponse, timingSafeEqual } from "../_shared/http.ts";
import {
  consumeInstanceRateLimit,
  ContractError,
  hmacSha256Hex,
  PROVIDER_INGEST_MAX_BYTES,
  providerSecret,
  sha256Hex,
  signatureInput,
  validateIdempotencyKey,
  validateKeyId,
  validateProviderBatch,
  validateProviderName,
  validateRequestTimestamp,
} from "./contract.ts";

const REQUIRED_CONTENT_TYPE = "application/json";

function providerError(status: number, code: string): Response {
  return jsonResponse({ error: { code } }, status);
}

function contractStatus(code: string): number {
  if (code === "RATE_LIMITED") return 429;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (code === "UNSUPPORTED_CONTENT_TYPE" || code === "UNSUPPORTED_CONTENT_ENCODING") {
    return 415;
  }
  if (
    code === "INVALID_INTERNAL_CREDENTIAL" ||
    code === "INVALID_SIGNATURE" ||
    code === "STALE_REQUEST"
  ) {
    return 401;
  }
  if (code === "SERVICE_NOT_CONFIGURED") return 503;
  return 400;
}

function requiredHeader(request: Request, name: string, code: string): string {
  const value = request.headers.get(name)?.trim() ?? "";
  if (!value) throw new ContractError(code);
  return value;
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== REQUIRED_CONTENT_TYPE) {
    throw new ContractError("UNSUPPORTED_CONTENT_TYPE");
  }
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new ContractError("UNSUPPORTED_CONTENT_ENCODING");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > PROVIDER_INGEST_MAX_BYTES) {
      throw new ContractError("REQUEST_TOO_LARGE");
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ContractError("INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > PROVIDER_INGEST_MAX_BYTES) {
      await reader.cancel();
      throw new ContractError("REQUEST_TOO_LARGE");
    }
    chunks.push(value);
  }
  if (byteLength === 0) throw new ContractError("INVALID_JSON");
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson(body: Uint8Array): unknown {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ContractError("INVALID_JSON");
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new ContractError("INVALID_JSON");
  }
}

type IngestResult = {
  status: "applied" | "replayed";
  batch_id: string;
  accepted_records: number;
  inactive_records: number;
};

function safeResult(value: unknown): IngestResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(503, "INGESTION_STORE_UNAVAILABLE");
  }
  const object = value as Record<string, unknown>;
  if (
    (object.status !== "applied" && object.status !== "replayed") ||
    typeof object.batch_id !== "string" ||
    object.batch_id.length < 16 ||
    object.batch_id.length > 128 ||
    !Number.isInteger(object.accepted_records) ||
    (object.accepted_records as number) < 0 ||
    (object.accepted_records as number) > 100 ||
    !Number.isInteger(object.inactive_records) ||
    (object.inactive_records as number) < 0 ||
    (object.inactive_records as number) > 100 ||
    (object.accepted_records as number) + (object.inactive_records as number) > 100
  ) {
    throw new HttpError(503, "INGESTION_STORE_UNAVAILABLE");
  }
  return {
    status: object.status,
    batch_id: object.batch_id,
    accepted_records: object.accepted_records as number,
    inactive_records: object.inactive_records as number,
  };
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") return providerError(405, "METHOD_NOT_ALLOWED");
    if (Deno.env.get("SPOTTR_PROVIDER_INGEST_ENABLED") !== "true") {
      return providerError(503, "PROVIDER_INGEST_DISABLED");
    }
    if (request.headers.has("origin")) {
      return providerError(403, "BROWSER_REQUEST_NOT_ALLOWED");
    }

    const provider = validateProviderName(
      requiredHeader(request, "x-spottr-provider", "INVALID_PROVIDER"),
    );
    const keyId = validateKeyId(
      requiredHeader(request, "x-spottr-key-id", "INVALID_KEY_ID"),
    );
    const timestamp = validateRequestTimestamp(
      requiredHeader(request, "x-spottr-timestamp", "INVALID_REQUEST_TIMESTAMP"),
    );
    const idempotencyKey = validateIdempotencyKey(
      requiredHeader(request, "idempotency-key", "INVALID_IDEMPOTENCY_KEY"),
    );
    const suppliedSignature = requiredHeader(
      request,
      "x-spottr-signature",
      "INVALID_SIGNATURE",
    );
    if (!/^v1=[0-9a-f]{64}$/.test(suppliedSignature)) {
      throw new ContractError("INVALID_SIGNATURE");
    }

    const bodyBytes = await boundedBody(request);
    const bodyHash = await sha256Hex(bodyBytes);
    const secret = providerSecret(
      Deno.env.get("SPOTTR_PROVIDER_INGEST_KEYS_JSON"),
      provider,
      keyId,
    );
    const expectedSignature = await hmacSha256Hex(
      secret,
      signatureInput(provider, keyId, timestamp, idempotencyKey, bodyHash),
    );
    if (!timingSafeEqual(suppliedSignature.slice(3), expectedSignature)) {
      throw new ContractError("INVALID_SIGNATURE");
    }
    consumeInstanceRateLimit(provider, keyId);

    const payload = validateProviderBatch(parseJson(bodyBytes), provider);
    if (payload.batchId !== idempotencyKey) {
      throw new ContractError("IDEMPOTENCY_KEY_MISMATCH");
    }

    // This RPC is deliberately the only mutation boundary. It must be installed
    // from the reviewed migration specified in docs/PROVIDER_INGESTION.md.
    const { data, error } = await adminClient().rpc("ingest_licensed_provider_batch", {
      provider_slug: provider,
      signing_key_id: keyId,
      idempotency_key: idempotencyKey,
      request_sha256: bodyHash,
      request_payload: payload,
    });
    if (error) {
      // Do not log the request, headers, provider secret, SQL message, or vendor data.
      return providerError(503, "INGESTION_STORE_UNAVAILABLE");
    }
    const result = safeResult(data);
    if (result.batch_id !== payload.batchId) {
      return providerError(503, "INGESTION_STORE_UNAVAILABLE");
    }
    return jsonResponse({
      status: result.status,
      batchId: result.batch_id,
      acceptedRecords: result.accepted_records,
      inactiveRecords: result.inactive_records,
    }, result.status === "applied" ? 202 : 200);
  } catch (error) {
    if (error instanceof ContractError) {
      return providerError(contractStatus(error.code), error.code);
    }
    if (error instanceof HttpError) {
      return providerError(error.status, error.code);
    }
    // Keep unknown failures opaque; request material and credentials are never logged.
    return providerError(500, "INTERNAL_ERROR");
  }
});
