import {
  adminClient,
  corsHeaders,
  HttpError,
  jsonResponse,
  optionsResponse,
  readJson,
  timingSafeEqual,
} from "../_shared/http.ts";
import {
  DiscoveryContractError,
  discoveryKinds,
  isUuid,
  normalizePublicDiscoveryRows,
  normalizeSponsoredInteractionReceipt,
  normalizeSponsoredPlacement,
  PUBLIC_DISCOVERY_MAX_BYTES,
  type PublicDiscoveryRequest,
  validatePublicDiscoveryRequest,
  validateSponsoredInteractionRequest,
} from "./contract.ts";

const DATABASE_TIMEOUT_MS = 2_500;
const AUTH_TIMEOUT_MS = 2_500;
const AUTH_RESPONSE_MAX_BYTES = 65_536;
const HMAC_PATTERN = /^[0-9a-f]{64}$/;

type RpcError = { code?: string; message?: string };

class DiscoveryHttpError extends HttpError {
  constructor(
    status: number,
    code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(status, code);
  }
}

class DatabaseRpcUncertainError extends HttpError {
  constructor() {
    super(503, "DISCOVERY_QUERY_UNAVAILABLE");
  }
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim() ?? "";
  if (!value) throw new HttpError(503, "DISCOVERY_NOT_CONFIGURED");
  return value;
}

function normalizeTrustedIp(value: string | null): string {
  const candidate = value?.trim() ?? "";
  if (!candidate || candidate.length > 45 || candidate.includes(",")) {
    throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
  }

  if (/^[0-9.]+$/.test(candidate)) {
    const parts = candidate.split(".");
    if (
      parts.length !== 4 ||
      parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)
    ) {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    return parts.map((part) => String(Number(part))).join(".");
  }

  if (
    !candidate.includes(":") ||
    candidate.includes("%") ||
    !/^[0-9a-f:.]+$/i.test(candidate)
  ) {
    throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
  }
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!normalized.includes(":")) throw new Error("not IPv6");
    return normalized;
  } catch {
    throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
  }
}

let hmacKeyPromise: Promise<CryptoKey> | null = null;

function discoveryHmacKey(): Promise<CryptoKey> {
  if (hmacKeyPromise) return hmacKeyPromise;
  const secret = requiredEnvironment("SPOTTR_DISCOVERY_RATE_SECRET");
  const material = new TextEncoder().encode(secret);
  if (material.byteLength < 32 || secret.startsWith("replace-with-")) {
    throw new HttpError(503, "DISCOVERY_NOT_CONFIGURED");
  }
  hmacKeyPromise = crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hmacKeyPromise;
}

async function identityHmac(kind: "ip" | "account", value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await discoveryHmacKey(),
    new TextEncoder().encode(`${kind}\u0000${value}`),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function authenticatedAccountId(request: Request): Promise<string | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]{20,4096})$/);
  if (!match) throw new HttpError(401, "INVALID_SESSION");

  const token = match[1];
  if (timingSafeEqual(token, requiredEnvironment("SUPABASE_ANON_KEY"))) return null;

  const controller = new AbortController();
  const abortFromRequest = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  request.signal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    const authUrl = new URL(
      "/auth/v1/user",
      requiredEnvironment("SUPABASE_URL"),
    );
    const response = await fetch(authUrl, {
      headers: {
        apikey: requiredEnvironment("SUPABASE_ANON_KEY"),
        Authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    if (!response.ok) {
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 401 : 503,
        response.status === 401 || response.status === 403
          ? "INVALID_SESSION"
          : "DISCOVERY_GUARD_UNAVAILABLE",
      );
    }
    const declaredSize = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredSize) && declaredSize > AUTH_RESPONSE_MAX_BYTES) {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    const raw = await response.text();
    if (controller.signal.aborted) {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    if (new TextEncoder().encode(raw).byteLength > AUTH_RESPONSE_MAX_BYTES) {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    const id = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).id
      : null;
    if (!isUuid(id)) throw new HttpError(401, "INVALID_SESSION");
    return id;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "AbortError") {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromRequest);
  }
}

async function databaseRpc(
  name: string,
  parameters: Record<string, unknown>,
  parentSignal?: AbortSignal,
): Promise<{ data: unknown; error: RpcError | null }> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), DATABASE_TIMEOUT_MS);
  try {
    const result = await adminClient().rpc(name, parameters).abortSignal(controller.signal);
    if (controller.signal.aborted) throw new DatabaseRpcUncertainError();
    return { data: result.data, error: result.error };
  } catch {
    // Once an RPC fetch throws, the Edge process cannot distinguish a local
    // transport failure from a statement that reached PostgREST and continued.
    // Treat every thrown transport outcome as uncertain so the caller retains
    // any active lease until its conservative expiry.
    throw new DatabaseRpcUncertainError();
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function guardFailure(error: RpcError): never {
  const signal = `${error.code ?? ""} ${error.message ?? ""}`;
  if (signal.includes("PUBLIC_DISCOVERY_RATE_LIMITED")) {
    throw new DiscoveryHttpError(429, "DISCOVERY_RATE_LIMITED", 60);
  }
  if (
    signal.includes("PUBLIC_DISCOVERY_BUSY") ||
    signal.includes("PUBLIC_DISCOVERY_CONCURRENCY_LIMITED")
  ) {
    throw new DiscoveryHttpError(429, "DISCOVERY_BUSY", 2);
  }
  throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
}

function queryParameters(request: PublicDiscoveryRequest): Record<string, unknown> {
  if (request.operation === "map") {
    return {
      west_longitude: request.west_longitude,
      south_latitude: request.south_latitude,
      east_longitude: request.east_longitude,
      north_latitude: request.north_latitude,
      map_zoom: request.map_zoom,
      requested_kinds: request.requested_kinds,
      max_features: request.max_features,
    };
  }
  if (request.operation === "nearby") {
    return {
      search_lat: request.search_lat,
      search_lng: request.search_lng,
      radius_meters: request.radius_meters,
      result_limit: request.result_limit,
      result_offset: request.result_offset,
    };
  }
  return {
    search_text: request.search_text,
    result_limit: request.result_limit,
    result_offset: request.result_offset,
  };
}

async function releaseLease(leaseHmac: string): Promise<void> {
  try {
    const { data, error } = await databaseRpc("release_public_discovery_lease", {
      target_lease_hmac: leaseHmac,
    });
    const released = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).released
      : null;
    if (error || released !== true) {
      console.error("Public discovery lease release failed");
    }
  } catch {
    console.error("Public discovery lease release failed");
  }
}

function discoveryErrorResponse(error: unknown, cors: HeadersInit): Response {
  if (error instanceof DiscoveryHttpError) {
    return jsonResponse(
      {
        error: {
          code: error.code,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retry_after_seconds: error.retryAfterSeconds }),
        },
      },
      error.status,
      {
        ...Object.fromEntries(new Headers(cors)),
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { "Retry-After": String(error.retryAfterSeconds) }),
      },
    );
  }
  if (error instanceof HttpError) {
    return jsonResponse({ error: { code: error.code } }, error.status, cors);
  }
  console.error("Public discovery request failed");
  return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500, cors);
}

export async function handlePublicDiscovery(request: Request): Promise<Response> {
  let cors: HeadersInit = {};
  let leaseHmac: string | null = null;
  let retainLeaseUntilExpiry = false;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return optionsResponse(request);
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
      throw new HttpError(415, "JSON_CONTENT_TYPE_REQUIRED");
    }

    const rawRequest = await readJson<unknown>(
      request,
      PUBLIC_DISCOVERY_MAX_BYTES,
    );
    const requestedOperation = rawRequest && typeof rawRequest === "object" &&
        !Array.isArray(rawRequest)
      ? (rawRequest as Record<string, unknown>).operation
      : null;
    const trustedIp = normalizeTrustedIp(request.headers.get("cf-connecting-ip"));
    const ipHmac = await identityHmac("ip", trustedIp);

    if (requestedOperation === "sponsored_interaction") {
      if (
        Deno.env.get("SPOTTR_SPONSORED_PLACEMENTS_ENABLED")?.trim() !==
          "true"
      ) {
        throw new HttpError(503, "SPONSORED_INTERACTION_UNAVAILABLE");
      }
      let interactionRequest;
      try {
        interactionRequest = validateSponsoredInteractionRequest(rawRequest);
      } catch (error) {
        if (error instanceof DiscoveryContractError) {
          throw new HttpError(400, error.code);
        }
        throw error;
      }
      const interactionAccountId = await authenticatedAccountId(request);
      const interactionSubjectHmac = interactionAccountId === null
        ? ipHmac
        : await identityHmac("account", interactionAccountId);
      const interaction = await databaseRpc("record_sponsored_interaction", {
        placement_token: interactionRequest.placement_token,
        interaction_type: interactionRequest.interaction_type,
        idempotency_key: interactionRequest.idempotency_key,
        interaction_subject_hmac: interactionSubjectHmac,
      }, request.signal);
      if (interaction.error) {
        const signal = `${interaction.error.code ?? ""} ${interaction.error.message ?? ""}`;
        if (signal.includes("SPONSORED_RATE_LIMITED")) {
          throw new DiscoveryHttpError(429, "SPONSORED_RATE_LIMITED", 60);
        }
        if (
          signal.includes("SPONSORED_TOKEN_EXPIRED") ||
          signal.includes("INVALID_SPONSORED_INTERACTION")
        ) {
          throw new HttpError(400, "INVALID_SPONSORED_INTERACTION");
        }
        throw new HttpError(503, "SPONSORED_INTERACTION_UNAVAILABLE");
      }
      let receipt;
      try {
        receipt = normalizeSponsoredInteractionReceipt(interaction.data);
      } catch {
        throw new HttpError(503, "SPONSORED_INTERACTION_UNAVAILABLE");
      }
      return jsonResponse(
        { operation: "sponsored_interaction", receipt },
        200,
        cors,
      );
    }

    let discoveryRequest: PublicDiscoveryRequest;
    try {
      discoveryRequest = validatePublicDiscoveryRequest(rawRequest);
    } catch (error) {
      if (error instanceof DiscoveryContractError) {
        throw new HttpError(400, error.code);
      }
      throw error;
    }

    let accountId: string | null = null;
    let accountHmac: string | null = null;

    const acquisition = await databaseRpc("acquire_public_discovery_lease", {
      target_operation: discoveryRequest.operation,
      target_ip_hmac: ipHmac,
      target_account_hmac: null,
    }, request.signal);
    if (acquisition.error) guardFailure(acquisition.error);
    if (
      !acquisition.data || typeof acquisition.data !== "object" || Array.isArray(acquisition.data)
    ) {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    const lease = acquisition.data as Record<string, unknown>;
    if (
      lease.operation !== discoveryRequest.operation ||
      typeof lease.lease_hmac !== "string" ||
      !HMAC_PATTERN.test(lease.lease_hmac)
    ) {
      throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
    }
    leaseHmac = lease.lease_hmac;

    // Remote Auth validation occurs only after the cheap per-IP/concurrency
    // admission, so random bearer tokens cannot bypass discovery quotas.
    accountId = await authenticatedAccountId(request);
    if (accountId !== null) {
      accountHmac = await identityHmac("account", accountId);
      const attachment = await databaseRpc("attach_public_discovery_account", {
        target_lease_hmac: leaseHmac,
        target_account_hmac: accountHmac,
      }, request.signal);
      if (attachment.error) guardFailure(attachment.error);
      const attached = attachment.data && typeof attachment.data === "object" &&
          !Array.isArray(attachment.data)
        ? attachment.data as Record<string, unknown>
        : null;
      if (
        attached?.attached !== true ||
        attached.operation !== discoveryRequest.operation
      ) {
        throw new HttpError(503, "DISCOVERY_GUARD_UNAVAILABLE");
      }
    }

    const query = await databaseRpc(
      discoveryRequest.operation === "map"
        ? "map_food_places"
        : discoveryRequest.operation === "nearby"
        ? "nearby_businesses"
        : "search_businesses",
      queryParameters(discoveryRequest),
      request.signal,
    );
    if (query.error) throw new HttpError(503, "DISCOVERY_QUERY_UNAVAILABLE");

    let rows: Record<string, unknown>[];
    try {
      rows = normalizePublicDiscoveryRows(discoveryRequest, query.data);
    } catch (error) {
      if (error instanceof DiscoveryContractError) {
        throw new HttpError(503, "DISCOVERY_RESPONSE_INVALID");
      }
      throw error;
    }

    let sponsored = null;
    if (
      discoveryRequest.operation === "nearby" &&
      discoveryRequest.result_offset === 0 &&
      Deno.env.get("SPOTTR_SPONSORED_PLACEMENTS_ENABLED")?.trim() === "true"
    ) {
      try {
        const filterHash = await sha256Hex(JSON.stringify(discoveryRequest));
        const selection = await databaseRpc("select_sponsored_placement", {
          target_surface: "discover",
          search_lat: discoveryRequest.search_lat,
          search_lng: discoveryRequest.search_lng,
          search_radius_meters: discoveryRequest.radius_meters,
          requested_kinds: discoveryKinds,
          organic_filter_hash: filterHash,
          subject_hmac: accountHmac ?? ipHmac,
          target_account_id: accountId,
        }, request.signal);
        if (!selection.error) {
          sponsored = normalizeSponsoredPlacement(selection.data);
        } else {
          console.error("Sponsored selection unavailable");
        }
      } catch {
        // Ads must fail closed without taking organic discovery down with them.
        console.error("Sponsored selection unavailable");
      }
    }
    return jsonResponse(
      { operation: discoveryRequest.operation, rows, sponsored },
      200,
      cors,
    );
  } catch (error) {
    if (error instanceof DatabaseRpcUncertainError && leaseHmac) {
      // The HTTP client cannot prove whether PostgREST received or canceled the
      // outer statement. Keep the conservative two-minute lease until expiry.
      retainLeaseUntilExpiry = true;
    }
    return discoveryErrorResponse(error, cors);
  } finally {
    if (leaseHmac && !retainLeaseUntilExpiry) await releaseLease(leaseHmac);
  }
}

Deno.serve(handlePublicDiscovery);
