import type { ActionResult } from '@/types/marketplace';

// TypeScript and non-native runtimes resolve this fail-closed implementation.
// Metro selects the platform-specific .native or .web module at bundle time.
export async function registerPushNotificationDevice(_expectedUserId: string): Promise<ActionResult> {
  return {
    ok: false,
    code: 'CONFIG_REQUIRED',
    reason: 'Device push notifications are available only in signed iOS and Android builds.',
  };
}

export async function revokePushNotificationDevice(
  _expectedUserId: string,
): Promise<ActionResult> {
  return { ok: true };
}

export async function revokePushNotificationDeviceWithAccessToken(
  _expectedUserId: string,
  _accessToken: string,
): Promise<ActionResult> {
  return { ok: true };
}

export async function revokeAllPushNotificationDevices(_expectedUserId: string): Promise<ActionResult> {
  return { ok: true };
}
