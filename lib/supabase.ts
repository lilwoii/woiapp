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
  isPkceVerifierKey,
  type LocalAuthSessionClearResult,
} from '@/lib/auth-storage';
import type { AuthIdentityQuarantineRead } from '@/lib/auth-identity-quarantine';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const authStorageKey = deriveSupabaseAuthStorageKey(supabaseUrl);

export const isSupabaseConfigured = Boolean(authStorageKey && supabaseAnonKey?.trim());

export async function readAuthIdentityQuarantine(): Promise<AuthIdentityQuarantineRead> {
  return { status: 'clear' };
}

export async function persistAuthIdentityQuarantine(_userId: string): Promise<boolean> {
  return true;
}

export async function clearAuthIdentityQuarantine(): Promise<boolean> {
  return true;
}

// A static web client cannot issue HttpOnly session cookies without a BFF.
// Sessions stay tab-scoped, while the short-lived PKCE verifier uses local
// storage so email links opened in another tab can complete safely. Supabase
// removes the verifier after exchange. A strict CSP and short server-side token
// lifetimes remain mandatory in production.
const webAuthStorage = {
  getItem: (key: string) => {
    if (typeof window === 'undefined') return null;
    return isPkceVerifierKey(key)
      ? window.localStorage.getItem(key)
      : window.sessionStorage.getItem(key);
  },
  setItem: (key: string, value: string) => {
    if (typeof window === 'undefined') return;
    if (isPkceVerifierKey(key)) {
      window.localStorage.setItem(key, value);
      return;
    }
    window.sessionStorage.setItem(key, value);
  },
  removeItem: (key: string) => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.removeItem(key);
    window.localStorage.removeItem(key);
  },
};

export async function clearLocalAuthSessionForUser(
  expectedUserId: string
): Promise<LocalAuthSessionClearResult> {
  if (!authStorageKey || typeof window === 'undefined') return 'missing';
  return processLock(`lock:${authStorageKey}`, -1, async () => {
    const identity = inspectStoredAuthSession(webAuthStorage.getItem(authStorageKey));
    const decision = decideLocalAuthSessionClear(identity, expectedUserId);
    if (decision !== 'cleared') return decision;

    // Sessions are tab-scoped. This uses the same in-process lock as GoTrue,
    // so refresh cannot write the revoked session back after this removal.
    webAuthStorage.removeItem(authStorageKey);
    webAuthStorage.removeItem(`${authStorageKey}-user`);
    if (accountBoundClientCache?.expectedUserId === expectedUserId) {
      accountBoundClientCache = null;
    }
    // The PKCE verifier is intentionally cross-tab and is not account-bound;
    // clearing account A must not cancel account B's active email flow.
    return 'cleared';
  });
}

export function getLocalAuthSessionSnapshot(): Session | null | undefined {
  if (!authStorageKey || typeof window === 'undefined') return undefined;
  const rawValue = webAuthStorage.getItem(authStorageKey);
  const identity = inspectStoredAuthSession(rawValue);
  if (identity.status === 'missing') return null;
  if (identity.status === 'invalid' || rawValue === null) return undefined;
  try {
    const session = JSON.parse(rawValue) as Session;
    return typeof session.access_token === 'string' ? session : undefined;
  } catch {
    return undefined;
  }
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        autoRefreshToken: true,
        flowType: 'pkce',
        lock: processLock,
        storage: webAuthStorage,
        storageKey: authStorageKey as string,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;

type AccountBoundClientCache = {
  accessToken: string;
  expectedUserId: string;
  promise: Promise<SupabaseClient | null>;
};

let accountBoundClientCache: AccountBoundClientCache | null = null;

export async function createAccessTokenBoundSupabaseClient(
  expectedUserId: string,
  accessToken: string,
): Promise<SupabaseClient | null> {
  if (!supabase || !supabaseUrl || !supabaseAnonKey || !expectedUserId.trim() || !accessToken) {
    return null;
  }
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
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
}

/**
 * Create a short-lived client whose requests are permanently tied to the
 * session that was verified for the expected account.
 *
 * Marketplace mutations can outlive a sign-out/account switch while their
 * promise is in flight.  The app's shared client is intentionally mutable and
 * may refresh to a different account during that window, so callers that have
 * an account identity must use this client for the complete mutation.  The
 * client is memory-only and never writes the captured token to storage.
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

    const promise = createAccessTokenBoundSupabaseClient(expectedUserId, accessToken);
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
