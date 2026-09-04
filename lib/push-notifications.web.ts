import Constants from 'expo-constants';

import {
  createAccessTokenBoundSupabaseClient,
  createAccountBoundSupabaseClient,
} from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';

const INSTALLATION_KEY = 'spottr.web-push.installation.v1';
const CONSENT_POLICY_VERSION = 'product-updates-v1';
const DEVICE_REQUEST_TIMEOUT_MS = 5_000;
const SERVICE_WORKER_READY_TIMEOUT_MS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VAPID_PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;

type NotificationClient = NonNullable<Awaited<ReturnType<typeof createAccountBoundSupabaseClient>>>;

function failure(
  reason: string,
  code: 'CONFIG_REQUIRED' | 'AUTH_REQUIRED' | 'UNKNOWN' = 'CONFIG_REQUIRED',
): ActionResult {
  return { ok: false, code, reason };
}

function webPushConfigured(): boolean {
  return process.env.EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED?.trim().toLowerCase() === 'true';
}

function applicationServerKey(): string | null {
  const value = process.env.EXPO_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  return value && VAPID_PUBLIC_KEY.test(value) ? value : null;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function installationId(): string | null {
  try {
    const existing = window.localStorage.getItem(INSTALLATION_KEY);
    if (existing && UUID.test(existing)) return existing.toLowerCase();
    const created = crypto.randomUUID();
    window.localStorage.setItem(INSTALLATION_KEY, created);
    return created;
  } catch {
    return null;
  }
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (
    typeof window === 'undefined' || window.location.protocol !== 'https:' ||
    !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)
  ) return null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function serializedSubscription(subscription: PushSubscription) {
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.auth || !value.keys?.p256dh) return null;
  return {
    endpoint: value.endpoint,
    keys: { auth: value.keys.auth, p256dh: value.keys.p256dh },
  };
}

async function invokeRevoke(
  client: NotificationClient,
  storedInstallationId: string,
): Promise<ActionResult> {
  try {
    const { error } = await client.functions.invoke('notification-device', {
      timeout: DEVICE_REQUEST_TIMEOUT_MS,
      body: {
        action: 'revoke',
        installationId: storedInstallationId,
        consentPolicyVersion: CONSENT_POLICY_VERSION,
      },
    });
    if (error) throw error;
    const registration = await serviceWorkerRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    return { ok: true, message: 'Browser alerts are off on this device.' };
  } catch {
    return failure('This browser could not be removed from alerts.', 'UNKNOWN');
  }
}

export async function registerPushNotificationDevice(expectedUserId: string): Promise<ActionResult> {
  if (!webPushConfigured()) return failure('Web push is not enabled for this release.');
  const vapidPublicKey = applicationServerKey();
  if (!vapidPublicKey) return failure('Secure web notification delivery is not configured.');
  const storedInstallationId = installationId();
  if (!storedInstallationId) {
    return failure('This browser blocks the storage needed to secure notification ownership.');
  }
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) return failure('Sign in again to enable alerts.', 'AUTH_REQUIRED');
  const registration = await serviceWorkerRegistration();
  if (!registration) return failure('This browser cannot securely receive Spottr notifications.');

  let createdSubscription = false;
  try {
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return failure('Notifications are off for Spottr. You can allow them in browser settings.', 'AUTH_REQUIRED');
    }
    let subscription = await registration.pushManager.getSubscription();
    const expectedKey = decodeBase64Url(vapidPublicKey);
    if (subscription?.options.applicationServerKey) {
      const currentKey = new Uint8Array(subscription.options.applicationServerKey);
      const keyMatches = currentKey.length === expectedKey.length &&
        currentKey.every((byte, index) => byte === expectedKey[index]);
      if (!keyMatches) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: expectedKey,
      });
      createdSubscription = true;
    }
    const payload = serializedSubscription(subscription);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!payload || !timezone) throw new Error('INVALID_WEB_PUSH_SUBSCRIPTION');
    const { error } = await client.functions.invoke('notification-device', {
      timeout: DEVICE_REQUEST_TIMEOUT_MS,
      body: {
        action: 'register_web',
        installationId: storedInstallationId,
        subscription: payload,
        applicationServerKey: vapidPublicKey,
        timezone,
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        permissionState: 'granted',
        consentPolicyVersion: CONSENT_POLICY_VERSION,
      },
    });
    if (error) throw error;
    return { ok: true, message: 'Browser alerts are ready.' };
  } catch {
    if (createdSubscription) {
      const subscription = await registration.pushManager.getSubscription().catch(() => null);
      await subscription?.unsubscribe().catch(() => false);
    }
    return failure('Spottr could not register this browser securely. Try again later.', 'UNKNOWN');
  }
}

export async function revokePushNotificationDevice(expectedUserId: string): Promise<ActionResult> {
  const storedInstallationId = installationId();
  if (!storedInstallationId) return { ok: true };
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) return failure('The active session changed.', 'AUTH_REQUIRED');
  return invokeRevoke(client, storedInstallationId);
}

export async function revokePushNotificationDeviceWithAccessToken(
  expectedUserId: string,
  accessToken: string,
): Promise<ActionResult> {
  const storedInstallationId = installationId();
  if (!storedInstallationId) return { ok: true };
  const client = await createAccessTokenBoundSupabaseClient(expectedUserId, accessToken);
  if (!client) return failure('The prior session ended.', 'AUTH_REQUIRED');
  return invokeRevoke(client, storedInstallationId);
}

export async function revokeAllPushNotificationDevices(expectedUserId: string): Promise<ActionResult> {
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) return failure('The active session changed.', 'AUTH_REQUIRED');
  try {
    const { error } = await client.functions.invoke('notification-device', {
      timeout: DEVICE_REQUEST_TIMEOUT_MS,
      body: { action: 'revoke_all', consentPolicyVersion: CONSENT_POLICY_VERSION },
    });
    if (error) throw error;
    const registration = await serviceWorkerRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    return { ok: true, message: 'Browser delivery is off for this account.' };
  } catch {
    return failure('Registered devices could not be removed.', 'UNKNOWN');
  }
}
