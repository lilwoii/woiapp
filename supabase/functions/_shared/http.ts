import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.101.1";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
  }
  return value;
}

function allowedOrigins(): Set<string> {
  return new Set(
    (Deno.env.get("SPOTTR_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return { Vary: "Origin" };
  if (!allowedOrigins().has(origin)) {
    throw new HttpError(403, "ORIGIN_NOT_ALLOWED");
  }
  return {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage, idempotency-key, x-spottr-delete-confirmation",
    "Access-Control-Allow-Methods": "DELETE, GET, OPTIONS, POST",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}

export function optionsResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) throw new HttpError(401, "AUTHENTICATION_REQUIRED");
  return match[1];
}

export function userClient(token: string): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export function adminClient(): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function authenticatedUser(
  request: Request,
  requireAal2 = false,
): Promise<{ token: string; user: User; client: SupabaseClient }> {
  const token = bearerToken(request);
  const client = userClient(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "INVALID_SESSION");
  if (requireAal2 && jwtPayload(token).aal !== "aal2") {
    throw new HttpError(403, "AAL2_REQUIRED");
  }
  return { token, user: data.user, client };
}

export function authenticatedSessionId(token: string): string {
  const sessionId = jwtPayload(token).session_id;
  if (
    typeof sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sessionId,
    )
  ) {
    throw new HttpError(401, "INVALID_SESSION");
  }
  return sessionId.toLowerCase();
}

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return {};
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

export async function readJson<T>(request: Request, maxBytes = 8192): Promise<T> {
  const declaredSize = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new HttpError(413, "REQUEST_TOO_LARGE");
  }
  if (!request.body) throw new HttpError(400, "INVALID_JSON");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The response is already fail-closed; cancellation is best effort.
      }
      throw new HttpError(413, "REQUEST_TOO_LARGE");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

export function normalizeIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (
    key.length < 16 ||
    key.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  ) {
    throw new HttpError(400, "VALID_IDEMPOTENCY_KEY_REQUIRED");
  }
  return key;
}

export function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

export function internalBearer(request: Request, envName: string): void {
  const expected = requiredEnv(envName);
  if (expected.length < 32) throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!timingSafeEqual(supplied, expected)) {
    throw new HttpError(401, "INVALID_INTERNAL_CREDENTIAL");
  }
}

export function publicError(error: unknown, cors: HeadersInit = {}): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: { code: error.code } }, error.status, cors);
  }
  console.error(error);
  return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500, cors);
}
