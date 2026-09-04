import { HttpError } from "../_shared/http.ts";
import { validateWebPushEndpointOrigin } from "../notification-device/contract.ts";
import type { GenericNotificationPayload } from "./contract.ts";

const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;
const PRIVATE_KEY = /^[A-Za-z0-9_-]{43}$/;
const AUTH_SECRET = /^[A-Za-z0-9_-]{22}$/;
const MAX_SUBSCRIPTION_LENGTH = 1536;

export type WebPushSubscription = {
  endpoint: string;
  keys: { auth: string; p256dh: string };
};

export type WebPushProviderConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
  allowedOrigins: string;
};

export type WebPushOutcome =
  | { state: "accepted"; code: "WebPushAccepted" }
  | { state: "invalid"; code: "WebPushSubscriptionExpired" }
  | { state: "rejected"; code: string; retry: boolean }
  | { state: "unknown"; code: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

export function parseWebPushSubscription(
  raw: string,
  allowedOrigins: string,
): WebPushSubscription {
  if (!raw || raw.length > MAX_SUBSCRIPTION_LENGTH) {
    throw new HttpError(503, "INVALID_WEB_PUSH_SUBSCRIPTION");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(503, "INVALID_WEB_PUSH_SUBSCRIPTION");
  }
  const subscription = record(parsed);
  const keys = record(subscription?.keys);
  if (
    !subscription || !keys ||
    !exactKeys(subscription, ["endpoint", "keys"]) ||
    !exactKeys(keys, ["auth", "p256dh"]) ||
    typeof subscription.endpoint !== "string" ||
    typeof keys.auth !== "string" || !AUTH_SECRET.test(keys.auth) ||
    typeof keys.p256dh !== "string" || !PUBLIC_KEY.test(keys.p256dh)
  ) throw new HttpError(503, "INVALID_WEB_PUSH_SUBSCRIPTION");
  try {
    validateWebPushEndpointOrigin(subscription.endpoint, allowedOrigins);
  } catch {
    throw new HttpError(503, "INVALID_WEB_PUSH_SUBSCRIPTION");
  }
  return {
    endpoint: subscription.endpoint,
    keys: { auth: keys.auth, p256dh: keys.p256dh },
  };
}

export function validateWebPushProviderConfig(
  config: WebPushProviderConfig,
): WebPushProviderConfig {
  if (!PUBLIC_KEY.test(config.publicKey) || !PRIVATE_KEY.test(config.privateKey)) {
    throw new HttpError(503, "INVALID_WEB_PUSH_VAPID_KEYS");
  }
  let validSubject = false;
  if (config.subject.startsWith("mailto:")) {
    validSubject = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.subject) &&
      config.subject.length <= 320;
  } else {
    try {
      const subject = new URL(config.subject);
      validSubject = subject.protocol === "https:" && !subject.username && !subject.password &&
        !subject.hash && !subject.search && subject.pathname === "/" &&
        (!subject.port || subject.port === "443");
    } catch {
      validSubject = false;
    }
  }
  if (!validSubject) throw new HttpError(503, "INVALID_WEB_PUSH_VAPID_SUBJECT");
  return config;
}

function normalizedHttpCode(status: number): string {
  return `WebPushHttp${Math.trunc(status)}`.slice(0, 80);
}

export function classifyWebPushFailure(error: unknown): WebPushOutcome {
  const providerError = record(error);
  const statusCode = providerError?.statusCode;
  if (Number.isSafeInteger(statusCode) && Number(statusCode) >= 400 && Number(statusCode) <= 599) {
    const status = Number(statusCode);
    if (status === 404 || status === 410) {
      return { state: "invalid", code: "WebPushSubscriptionExpired" };
    }
    if (status === 429) {
      return { state: "rejected", code: "WebPushThrottled", retry: true };
    }
    if (status >= 500) {
      return { state: "unknown", code: normalizedHttpCode(status) };
    }
    return { state: "rejected", code: normalizedHttpCode(status), retry: false };
  }
  return { state: "unknown", code: "WebPushNetworkAmbiguous" };
}

export async function sendWebPushNotification(
  subscription: WebPushSubscription,
  payload: GenericNotificationPayload,
  sourceEventId: number,
  rawConfig: WebPushProviderConfig,
): Promise<WebPushOutcome> {
  const config = validateWebPushProviderConfig(rawConfig);
  const serializedPayload = JSON.stringify(payload);
  if (
    serializedPayload.length > 2048 || !Number.isSafeInteger(sourceEventId) || sourceEventId < 1
  ) {
    throw new HttpError(500, "INVALID_WEB_PUSH_PAYLOAD");
  }
  try {
    // Keep the Node-compatible encryption dependency off parse-only and
    // contract-test paths. Supabase Edge loads it only after every provider
    // gate and VAPID setting has been validated.
    // @deno-types="npm:@types/web-push@3.6.4"
    const { default: webPush } = await import("npm:web-push@3.6.7");
    const result = await webPush.sendNotification(subscription, serializedPayload, {
      TTL: 300,
      contentEncoding: "aes128gcm",
      timeout: 10_000,
      topic: String(sourceEventId).slice(-32),
      urgency: "normal",
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return { state: "unknown", code: normalizedHttpCode(result.statusCode) };
    }
    return { state: "accepted", code: "WebPushAccepted" };
  } catch (error) {
    return classifyWebPushFailure(error);
  }
}
