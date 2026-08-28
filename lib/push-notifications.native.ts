import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { createAccountBoundSupabaseClient } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';

const INSTALLATION_KEY = 'spottr.push.installation.v1';
const CONSENT_POLICY_VERSION = 'product-updates-v1';

async function installationId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(INSTALLATION_KEY, created, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return created;
}

function projectId(): string | null {
  return Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId ?? null;
}

function failure(reason: string): ActionResult {
  return { ok: false, code: 'CONFIG_REQUIRED', reason };
}

export async function registerPushNotificationDevice(
  expectedUserId: string,
): Promise<ActionResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return failure('Device push notifications are available in the iOS and Android apps.');
  }
  const easProjectId = projectId();
  if (!easProjectId) return failure('Secure notification delivery is not configured for this build.');
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in again to enable alerts.' };

  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('spottr-updates', {
        name: 'Places you follow',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 180],
        lightColor: '#F06445',
        sound: null,
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    if (permission.status !== Notifications.PermissionStatus.GRANTED) {
      permission = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
    }
    const provisional = Platform.OS === 'ios' &&
      permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (permission.status !== Notifications.PermissionStatus.GRANTED && !provisional) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'Notifications are off for Spottr. You can allow them in device settings.',
      };
    }
    const token = await Notifications.getExpoPushTokenAsync({ projectId: easProjectId });
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return failure('Your device timezone could not be verified.');
    const { error } = await client.functions.invoke('notification-device', {
      body: {
        action: 'register',
        installationId: await installationId(),
        platform: Platform.OS,
        projectId: easProjectId,
        token: token.data,
        timezone,
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        permissionState: provisional ? 'provisional' : 'granted',
        consentPolicyVersion: CONSENT_POLICY_VERSION,
      },
    });
    if (error) throw error;
    return { ok: true, message: 'Device alerts are ready.' };
  } catch {
    return failure('Spottr could not register this device securely. Try again later.');
  }
}

export async function revokePushNotificationDevice(
  expectedUserId: string,
): Promise<ActionResult> {
  const storedInstallationId = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (!storedInstallationId) return { ok: true };
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) return { ok: false, code: 'AUTH_REQUIRED', reason: 'The active session changed.' };
  try {
    const { error } = await client.functions.invoke('notification-device', {
      body: {
        action: 'revoke',
        installationId: storedInstallationId,
        consentPolicyVersion: CONSENT_POLICY_VERSION,
      },
    });
    if (error) throw error;
    return { ok: true, message: 'Alerts are off on this device.' };
  } catch {
    return { ok: false, code: 'UNKNOWN', reason: 'This device could not be removed from alerts.' };
  }
}

export async function revokeAllPushNotificationDevices(
  expectedUserId: string,
): Promise<ActionResult> {
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) return { ok: false, code: 'AUTH_REQUIRED', reason: 'The active session changed.' };
  try {
    const { error } = await client.functions.invoke('notification-device', {
      body: {
        action: 'revoke_all',
        consentPolicyVersion: CONSENT_POLICY_VERSION,
      },
    });
    if (error) throw error;
    return { ok: true };
  } catch {
    return { ok: false, code: 'UNKNOWN', reason: 'Registered devices could not be removed.' };
  }
}
