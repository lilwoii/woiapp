import * as SecureStore from 'expo-secure-store';
import {
  createClient,
  processLock,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';

import {
  decideLocalAuthSessionClear,
  deriveSupabaseAuthStorageKey,
  inspectStoredAuthSession,
  type LocalAuthSessionClearResult,
} from '@/lib/auth-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const authStorageKey = deriveSupabaseAuthStorageKey(supabaseUrl);

export const isSupabaseConfigured = Boolean(authStorageKey && supabaseAnonKey?.trim());

const secureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export async function clearLocalAuthSessionForUser(
  expectedUserId: string
): Promise<LocalAuthSessionClearResult> {
  if (!authStorageKey) return 'missing';
  return processLock(`lock:${authStorageKey}`, -1, async () => {
    const identity = inspectStoredAuthSession(await secureStoreAdapter.getItem(authStorageKey));
    const decision = decideLocalAuthSessionClear(identity, expectedUserId);
    if (decision !== 'cleared') return decision;

    // Use the same process lock name as GoTrue's persisted-session writes, so
    // refresh and session replacement cannot interleave with this clear.
    await secureStoreAdapter.removeItem(authStorageKey);
    await secureStoreAdapter.removeItem(`${authStorageKey}-user`);
    if (accountBoundClientCache?.expectedUserId === expectedUserId) {
      accountBoundClientCache = null;
    }
    // The PKCE verifier is a separate, non-account-bound email flow.
    return 'cleared';
  });
}

// SecureStore is asynchronous, so native auth events are reconciled through
// auth.getSession after Supabase releases its process lock.
export function getLocalAuthSessionSnapshot(): Session | null | undefined {
  return undefined;
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
        lock: processLock,
        persistSession: true,
        storage: secureStoreAdapter,
        storageKey: authStorageKey as string,
      },
    })
  : null;

type AccountBoundClientCache = {
  accessToken: string;
  expectedUserId: string;
  promise: Promise<SupabaseClient | null>;
};

let accountBoundClientCache: AccountBoundClientCache | null = null;

/**
 * Return a memory-only client pinned to the currently verified account.
 * Native marketplace mutations use this instead of the shared client so an
 * in-flight request cannot be re-attributed after sign-out or account switch.
 */
export async function createAccountBoundSupabaseClient(
  expectedUserId: string,
): Promise<SupabaseClient | null> {
  if (!supabase || !supabaseUrl || !supabaseAnonKey || !expectedUserId.trim()) {
    return null;
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    const session = data.session;
    const accessToken = session?.access_token;
    if (error || !accessToken || session.user.id !== expectedUserId) {
      accountBoundClientCache = null;
      return null;
    }

    if (
      accountBoundClientCache?.accessToken === accessToken &&
      accountBoundClientCache.expectedUserId === expectedUserId
    ) {
      return await accountBoundClientCache.promise;
    }

    const promise = (async () => {
      try {
        const { data: userData, error: userError } =
          await supabase.auth.getUser(accessToken);
        if (userError || userData.user?.id !== expectedUserId) return null;
        return createClient(supabaseUrl, supabaseAnonKey, {
          accessToken: async () => accessToken,
          auth: {
            autoRefreshToken: false,
            detectSessionInUrl: false,
            persistSession: false,
          },
        });
      } catch {
        return null;
      }
    })();
    const cacheEntry = { accessToken, expectedUserId, promise };
    accountBoundClientCache = cacheEntry;
    const verifiedClient = await promise;
    if (!verifiedClient && accountBoundClientCache === cacheEntry) {
      accountBoundClientCache = null;
    }
    return verifiedClient;
  } catch {
    accountBoundClientCache = null;
    return null;
  }
}

export async function resetRealtimeAuthToAnonymous(): Promise<void> {
  accountBoundClientCache = null;
  if (!supabase || !supabaseAnonKey) return;
  await supabase.realtime.setAuth(supabaseAnonKey);
}
