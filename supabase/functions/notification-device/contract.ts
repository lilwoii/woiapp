export const PUSH_CONSENT_POLICY_VERSION = "product-updates-v1";

export type RegisterNotificationDevice = {
  action: "register";
  installationId: string;
  platform: "ios" | "android";
  projectId: string;
  token: string;
  timezone: string;
  appVersion: string;
  permissionState: "granted" | "provisional";
  consentPolicyVersion: string;
};

export type RevokeNotificationDevice = {
  action: "revoke";
  installationId: string;
  consentPolicyVersion: string;
};

export type RevokeAllNotificationDevices = {
  action: "revoke_all";
  consentPolicyVersion: string;
};

export type NotificationDeviceRequest =
  | RegisterNotificationDevice
  | RevokeNotificationDevice
  | RevokeAllNotificationDevices;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPO_TOKEN = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{20,220}\]$/;
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.every((key) => allowed.includes(key)) &&
    allowed.every((key) => keys.includes(key));
}

function validTimezone(value: string): boolean {
  if (value.length < 1 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function parseNotificationDeviceRequest(value: unknown): NotificationDeviceRequest {
  const body = record(value);
  if (!body || !["register", "revoke", "revoke_all"].includes(String(body.action))) {
    throw new Error("INVALID_NOTIFICATION_DEVICE_REQUEST");
  }
  if (body.action === "revoke_all") {
    if (
      !exactKeys(body, ["action", "consentPolicyVersion"]) ||
      body.consentPolicyVersion !== PUSH_CONSENT_POLICY_VERSION
    ) {
      throw new Error("INVALID_NOTIFICATION_DEVICE_REQUEST");
    }
    return {
      action: "revoke_all",
      consentPolicyVersion: body.consentPolicyVersion,
    };
  }
  if (body.action === "revoke") {
    if (
      !exactKeys(body, ["action", "installationId", "consentPolicyVersion"]) ||
      typeof body.installationId !== "string" || !UUID.test(body.installationId) ||
      body.consentPolicyVersion !== PUSH_CONSENT_POLICY_VERSION
    ) {
      throw new Error("INVALID_NOTIFICATION_DEVICE_REQUEST");
    }
    return {
      action: "revoke",
      installationId: body.installationId.toLowerCase(),
      consentPolicyVersion: body.consentPolicyVersion,
    };
  }

  if (
    !exactKeys(body, [
      "action",
      "installationId",
      "platform",
      "projectId",
      "token",
      "timezone",
      "appVersion",
      "permissionState",
      "consentPolicyVersion",
    ]) ||
    typeof body.installationId !== "string" || !UUID.test(body.installationId) ||
    (body.platform !== "ios" && body.platform !== "android") ||
    typeof body.projectId !== "string" || !UUID.test(body.projectId) ||
    typeof body.token !== "string" || !EXPO_TOKEN.test(body.token) ||
    typeof body.timezone !== "string" || !validTimezone(body.timezone) ||
    typeof body.appVersion !== "string" || !APP_VERSION.test(body.appVersion) ||
    (body.permissionState !== "granted" && body.permissionState !== "provisional") ||
    (body.platform === "android" && body.permissionState !== "granted") ||
    body.consentPolicyVersion !== PUSH_CONSENT_POLICY_VERSION
  ) {
    throw new Error("INVALID_NOTIFICATION_DEVICE_REQUEST");
  }
  return {
    action: "register",
    installationId: body.installationId.toLowerCase(),
    platform: body.platform,
    projectId: body.projectId.toLowerCase(),
    token: body.token,
    timezone: body.timezone,
    appVersion: body.appVersion,
    permissionState: body.permissionState,
    consentPolicyVersion: body.consentPolicyVersion,
  };
}

function base64UrlToBytes(value: string, errorCode: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(errorCode);
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error(errorCode);
  }
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function protectPushToken(
  token: string,
  encodedKey: string,
  encodedHashKey: string,
  nonce = crypto.getRandomValues(new Uint8Array(12)),
): Promise<{ tokenHash: string; tokenCiphertext: string; tokenNonce: string }> {
  const keyBytes = base64UrlToBytes(encodedKey, "INVALID_ENCRYPTION_KEY");
  const hashKeyBytes = base64UrlToBytes(encodedHashKey, "INVALID_HASH_KEY");
  if (keyBytes.byteLength !== 32 || nonce.byteLength !== 12) {
    throw new Error("INVALID_ENCRYPTION_KEY");
  }
  if (hashKeyBytes.byteLength !== 32) throw new Error("INVALID_HASH_KEY");
  const keyData = Uint8Array.from(keyBytes).buffer;
  const initializationVector = Uint8Array.from(nonce).buffer;
  const key = await crypto.subtle.importKey("raw", keyData, "AES-GCM", false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(token);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: initializationVector },
    key,
    plaintext,
  );
  const hashKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hashKeyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hashKey, plaintext));
  return {
    tokenHash: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    tokenCiphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    tokenNonce: bytesToBase64Url(nonce),
  };
}
