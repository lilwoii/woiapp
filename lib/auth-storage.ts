export type AuthStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export const isPkceVerifierKey = (key: string) => key.endsWith('-code-verifier');

export type StoredAuthSessionIdentity =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'valid'; userId: string };

export type LocalAuthSessionClearResult =
  | 'cleared'
  | 'different-user'
  | 'missing'
  | 'unknown';

export function deriveSupabaseAuthStorageKey(urlValue: string | undefined): string | null {
  if (!urlValue) return null;
  try {
    const url = new URL(urlValue);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null;
    const projectRef = url.hostname.split('.')[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch {
    return null;
  }
}

export function inspectStoredAuthSession(rawValue: string | null): StoredAuthSessionIdentity {
  if (rawValue === null) return { status: 'missing' };
  try {
    const parsed = JSON.parse(rawValue) as { user?: { id?: unknown } } | null;
    const userId = parsed?.user?.id;
    return typeof userId === 'string' && userId.length > 0
      ? { status: 'valid', userId }
      : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

export function decideLocalAuthSessionClear(
  identity: StoredAuthSessionIdentity,
  expectedUserId: string
): LocalAuthSessionClearResult {
  if (identity.status === 'missing') return 'missing';
  if (identity.status === 'invalid') return 'unknown';
  return identity.userId === expectedUserId ? 'cleared' : 'different-user';
}

export function createSplitAuthStorage(
  tabStorage: AuthStorage,
  crossTabPkceStorage: AuthStorage
): AuthStorage {
  return {
    getItem: (key) =>
      isPkceVerifierKey(key)
        ? crossTabPkceStorage.getItem(key)
        : tabStorage.getItem(key),
    setItem: (key, value) => {
      if (isPkceVerifierKey(key)) {
        crossTabPkceStorage.setItem(key, value);
        return;
      }
      tabStorage.setItem(key, value);
    },
    removeItem: (key) => {
      tabStorage.removeItem(key);
      crossTabPkceStorage.removeItem(key);
    },
  };
}
