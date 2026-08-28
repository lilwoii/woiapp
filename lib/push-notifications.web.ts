import type { ActionResult } from '@/types/marketplace';

export async function registerPushNotificationDevice(_expectedUserId: string): Promise<ActionResult> {
  return {
    ok: false,
    code: 'CONFIG_REQUIRED',
    reason: 'Web push is not enabled. Spottr still shows followed-place updates in the app.',
  };
}

export async function revokePushNotificationDevice(
  _expectedUserId: string,
): Promise<ActionResult> {
  return { ok: true };
}

export async function revokeAllPushNotificationDevices(_expectedUserId: string): Promise<ActionResult> {
  return { ok: true };
}
