import { HttpError } from "../_shared/http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPO_TOKEN = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{20,220}\]$/;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_NONCE = /^[A-Za-z0-9_-]{16}$/;
const TICKET_ID = /^[A-Za-z0-9-]{1,240}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{32,2048}$/;
const PROVIDER_CODE = /^[A-Za-z0-9_]{1,80}$/;

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

export type NotificationKind = "owner_update" | "location_change" | "menu_return";

export type DispatchRequest = {
  outboxBatchSize: number;
  recipientBatchSize: number;
  deliveryBatchSize: number;
};

export type ReceiptRequest = { batchSize: number };

export type NotificationFinalization = {
  finalized: number;
  moreWork: boolean;
};

export type DeliveryClaim = {
  delivery_id: string;
  device_id: string;
  user_id: string;
  business_id: string;
  source_event_id: number;
  notification_kind: NotificationKind;
  provider: "expo";
  token_ciphertext: string;
  token_nonce: string;
  encryption_key_version: number;
  lease_token: string;
};

export type OutboxClaim = {
  outbox_id: string;
  source_event_id: number;
  business_id: string;
  notification_kind: NotificationKind;
  lease_token: string;
  expires_at: string;
};

export type ReceiptClaim = {
  receipt_check_id: string;
  delivery_id: string;
  device_id: string;
  provider_ticket_id: string;
  lease_token: string;
};

export type ExpoMessage = {
  to: string;
  title: "Spottr";
  body: string;
  data: { route: string; eventId: string };
};

export type DispatchOutcome =
  | { state: "accepted"; ticketId: string }
  | { state: "invalid"; code: "DeviceNotRegistered" }
  | { state: "rejected"; code: string; retry: boolean };

export type ReceiptOutcome =
  | { state: "delivered" }
  | { state: "invalid"; code: "DeviceNotRegistered" }
  | { state: "failed"; code: string }
  | { state: "retry"; code: string }
  | { state: "missing" };

export class PushProviderError extends Error {
  constructor(
    readonly resolution: "retry" | "unknown" | "dead",
    readonly code: string,
  ) {
    super(code);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.every((key) => allowed.includes(key));
}

function notificationKind(value: unknown): value is NotificationKind {
  return value === "owner_update" || value === "location_change" || value === "menu_return";
}

export function parseOutboxClaims(value: unknown, maximum: number): OutboxClaim[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new HttpError(502, "INVALID_NOTIFICATION_OUTBOX_CLAIM");
  }
  return value.map((raw): OutboxClaim => {
    const claim = record(raw);
    if (
      !claim || !UUID.test(String(claim.outbox_id ?? "")) ||
      !UUID.test(String(claim.business_id ?? "")) ||
      !UUID.test(String(claim.lease_token ?? "")) ||
      !Number.isSafeInteger(claim.source_event_id) ||
      !notificationKind(claim.notification_kind) ||
      typeof claim.expires_at !== "string" || !Number.isFinite(Date.parse(claim.expires_at))
    ) throw new HttpError(502, "INVALID_NOTIFICATION_OUTBOX_CLAIM");
    return claim as OutboxClaim;
  });
}

export function parseDeliveryClaims(value: unknown, maximum: number): DeliveryClaim[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new HttpError(502, "INVALID_NOTIFICATION_DELIVERY_CLAIM");
  }
  return value.map((raw): DeliveryClaim => {
    const claim = record(raw);
    if (
      !claim || !UUID.test(String(claim.delivery_id ?? "")) ||
      !UUID.test(String(claim.device_id ?? "")) ||
      !UUID.test(String(claim.user_id ?? "")) ||
      !UUID.test(String(claim.business_id ?? "")) ||
      !UUID.test(String(claim.lease_token ?? "")) ||
      !Number.isSafeInteger(claim.source_event_id) ||
      !notificationKind(claim.notification_kind) || claim.provider !== "expo" ||
      typeof claim.token_ciphertext !== "string" || claim.token_ciphertext.length > 2048 ||
      typeof claim.token_nonce !== "string" || !BASE64URL_NONCE.test(claim.token_nonce) ||
      !Number.isSafeInteger(claim.encryption_key_version) ||
      Number(claim.encryption_key_version) < 1
    ) throw new HttpError(502, "INVALID_NOTIFICATION_DELIVERY_CLAIM");
    return claim as DeliveryClaim;
  });
}

export function parseReceiptClaims(value: unknown, maximum: number): ReceiptClaim[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new HttpError(502, "INVALID_NOTIFICATION_RECEIPT_CLAIM");
  }
  return value.map((raw): ReceiptClaim => {
    const claim = record(raw);
    if (
      !claim || !UUID.test(String(claim.receipt_check_id ?? "")) ||
      !UUID.test(String(claim.delivery_id ?? "")) ||
      !UUID.test(String(claim.device_id ?? "")) ||
      !UUID.test(String(claim.lease_token ?? "")) ||
      typeof claim.provider_ticket_id !== "string" || !TICKET_ID.test(claim.provider_ticket_id)
    ) throw new HttpError(502, "INVALID_NOTIFICATION_RECEIPT_CLAIM");
    return claim as ReceiptClaim;
  });
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new HttpError(400, "INVALID_NOTIFICATION_WORKER_REQUEST");
  }
  return Number(value);
}

export function parseDispatchRequest(value: unknown): DispatchRequest {
  const body = record(value);
  if (
    !body || !exactKeys(body, [
      "outboxBatchSize",
      "recipientBatchSize",
      "deliveryBatchSize",
    ])
  ) {
    throw new HttpError(400, "INVALID_NOTIFICATION_WORKER_REQUEST");
  }
  return {
    outboxBatchSize: boundedInteger(body.outboxBatchSize, 20, 50),
    recipientBatchSize: boundedInteger(body.recipientBatchSize, 200, 500),
    deliveryBatchSize: boundedInteger(body.deliveryBatchSize, 50, 100),
  };
}

export function parseReceiptRequest(value: unknown): ReceiptRequest {
  const body = record(value);
  if (!body || !exactKeys(body, ["batchSize"])) {
    throw new HttpError(400, "INVALID_NOTIFICATION_WORKER_REQUEST");
  }
  return { batchSize: boundedInteger(body.batchSize, 100, 250) };
}

export function parseNotificationFinalization(
  value: unknown,
  maximum: number,
  errorCode: string,
): NotificationFinalization {
  const body = record(value);
  if (
    !body || !Number.isSafeInteger(body.finalized) ||
    Number(body.finalized) < 0 || Number(body.finalized) > maximum ||
    typeof body.more_work !== "boolean"
  ) {
    throw new HttpError(503, errorCode);
  }
  return { finalized: Number(body.finalized), moreWork: body.more_work };
}

function base64UrlToBytes(value: string, errorCode: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(503, errorCode);
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(503, errorCode);
  }
}

export function parseEncryptionKeyRing(raw: string): Map<number, Uint8Array> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(503, "INVALID_PUSH_KEY_RING");
  }
  const keys = record(parsed);
  if (!keys || Object.keys(keys).length < 1 || Object.keys(keys).length > 8) {
    throw new HttpError(503, "INVALID_PUSH_KEY_RING");
  }
  const ring = new Map<number, Uint8Array>();
  for (const [versionText, encoded] of Object.entries(keys)) {
    const version = Number(versionText);
    if (
      !/^[1-9][0-9]{0,9}$/.test(versionText) || !Number.isSafeInteger(version) ||
      typeof encoded !== "string" || !BASE64URL_KEY.test(encoded)
    ) {
      throw new HttpError(503, "INVALID_PUSH_KEY_RING");
    }
    const bytes = base64UrlToBytes(encoded, "INVALID_PUSH_KEY_RING");
    if (bytes.byteLength !== 32) throw new HttpError(503, "INVALID_PUSH_KEY_RING");
    ring.set(version, bytes);
  }
  return ring;
}

export async function decryptPushToken(
  claim: Pick<DeliveryClaim, "token_ciphertext" | "token_nonce" | "encryption_key_version">,
  keyRing: Map<number, Uint8Array>,
): Promise<string> {
  const keyBytes = keyRing.get(claim.encryption_key_version);
  if (!keyBytes || !BASE64URL_NONCE.test(claim.token_nonce)) {
    throw new HttpError(503, "PUSH_KEY_VERSION_UNAVAILABLE");
  }
  const ciphertext = base64UrlToBytes(claim.token_ciphertext, "INVALID_PUSH_CIPHERTEXT");
  const nonce = base64UrlToBytes(claim.token_nonce, "INVALID_PUSH_CIPHERTEXT");
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(keyBytes).buffer,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(nonce).buffer },
      key,
      Uint8Array.from(ciphertext).buffer,
    );
    const token = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!EXPO_TOKEN.test(token)) throw new Error("invalid token");
    return token;
  } catch {
    throw new HttpError(503, "PUSH_TOKEN_DECRYPTION_FAILED");
  }
}

export function buildGenericExpoMessage(
  token: string,
  claim: Pick<DeliveryClaim, "business_id" | "source_event_id" | "notification_kind">,
): ExpoMessage {
  if (
    !EXPO_TOKEN.test(token) || !UUID.test(claim.business_id) ||
    !Number.isSafeInteger(claim.source_event_id)
  ) {
    throw new HttpError(500, "INVALID_NOTIFICATION_DELIVERY_CLAIM");
  }
  const body = claim.notification_kind === "location_change"
    ? "A place you follow updated its location."
    : claim.notification_kind === "menu_return"
    ? "Something is available again at a place you follow."
    : "A place you follow has a new update.";
  return {
    to: token,
    title: "Spottr",
    body,
    data: {
      route: `/place/${claim.business_id}`,
      eventId: String(claim.source_event_id),
    },
  };
}

function normalizedProviderCode(value: unknown, fallback: string): string {
  return typeof value === "string" && PROVIDER_CODE.test(value) ? value : fallback;
}

function responseCode(status: number): string {
  return `ExpoHttp${status}`.slice(0, 80);
}

async function boundedJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw.length < 2 || raw.length > 131_072) {
    throw new PushProviderError("unknown", "ExpoMalformedResponse");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new PushProviderError("unknown", "ExpoMalformedResponse");
  }
}

export function validateExpoAccessToken(accessToken: string): string {
  if (!ACCESS_TOKEN.test(accessToken)) throw new HttpError(503, "INVALID_EXPO_ACCESS_TOKEN");
  return accessToken;
}

function providerHeaders(accessToken: string): Record<string, string> {
  const validated = validateExpoAccessToken(accessToken);
  return {
    Accept: "application/json",
    Authorization: `Bearer ${validated}`,
    "Content-Type": "application/json",
  };
}

export async function sendExpoMessages(
  messages: ExpoMessage[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<DispatchOutcome[]> {
  if (messages.length < 1 || messages.length > 100) {
    throw new HttpError(500, "INVALID_NOTIFICATION_BATCH");
  }
  const headers = providerHeaders(accessToken);
  let response: Response;
  try {
    response = await fetcher(EXPO_SEND_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(messages),
      signal,
    });
  } catch {
    throw new PushProviderError("unknown", "ExpoNetworkAmbiguous");
  }
  if (!response.ok) {
    // A provider 5xx does not tell us whether the batch was accepted. Keep
    // those rows unknown so the ambiguity finalizer can settle them later;
    // retrying here could duplicate a notification that already crossed the
    // provider boundary. Only explicit provider throttling is retryable.
    const resolution = response.status === 429
      ? "retry"
      : response.status >= 500
      ? "unknown"
      : "dead";
    throw new PushProviderError(resolution, responseCode(response.status));
  }
  const envelope = record(await boundedJson(response));
  const data = envelope?.data;
  if (!Array.isArray(data) || data.length !== messages.length) {
    throw new PushProviderError("unknown", "ExpoMalformedResponse");
  }
  return data.map((rawTicket): DispatchOutcome => {
    const ticket = record(rawTicket);
    if (ticket?.status === "ok" && typeof ticket.id === "string" && TICKET_ID.test(ticket.id)) {
      return { state: "accepted", ticketId: ticket.id };
    }
    if (ticket?.status === "error") {
      const details = record(ticket.details);
      const code = normalizedProviderCode(details?.error, "ExpoRejected");
      if (code === "DeviceNotRegistered") return { state: "invalid", code };
      return {
        state: "rejected",
        code,
        retry: code === "TOO_MANY_REQUESTS" || code === "MessageRateExceeded",
      };
    }
    throw new PushProviderError("unknown", "ExpoMalformedTicket");
  });
}

export async function fetchExpoReceipts(
  ticketIds: string[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Map<string, ReceiptOutcome>> {
  if (
    ticketIds.length < 1 || ticketIds.length > 250 ||
    ticketIds.some((ticketId) => !TICKET_ID.test(ticketId)) ||
    new Set(ticketIds).size !== ticketIds.length
  ) {
    throw new HttpError(500, "INVALID_NOTIFICATION_RECEIPT_BATCH");
  }
  const headers = providerHeaders(accessToken);
  let response: Response;
  try {
    response = await fetcher(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: ticketIds }),
      signal,
    });
  } catch {
    throw new PushProviderError("retry", "ExpoReceiptNetworkError");
  }
  if (!response.ok) {
    // Receipt polling is read-only and never resends a notification, so an
    // unavailable receipt endpoint can be polled again safely. This retry
    // path must not be reused by sendExpoMessages.
    throw new PushProviderError("retry", responseCode(response.status));
  }
  const envelope = record(await boundedJson(response));
  const data = record(envelope?.data);
  if (!data) throw new PushProviderError("retry", "ExpoMalformedReceiptResponse");
  const outcomes = new Map<string, ReceiptOutcome>();
  for (const ticketId of ticketIds) {
    const receipt = record(data[ticketId]);
    if (!receipt) {
      outcomes.set(ticketId, { state: "missing" });
      continue;
    }
    if (receipt.status === "ok") {
      outcomes.set(ticketId, { state: "delivered" });
      continue;
    }
    if (receipt.status !== "error") {
      throw new PushProviderError("retry", "ExpoMalformedReceipt");
    }
    const code = normalizedProviderCode(record(receipt.details)?.error, "ExpoReceiptRejected");
    if (code === "DeviceNotRegistered") outcomes.set(ticketId, { state: "invalid", code });
    else if (code === "TOO_MANY_REQUESTS" || code === "MessageRateExceeded") {
      outcomes.set(ticketId, { state: "retry", code });
    } else outcomes.set(ticketId, { state: "failed", code });
  }
  return outcomes;
}
