import {
  createSplitAuthStorage,
  decideLocalAuthSessionClear,
  deriveSupabaseAuthStorageKey,
  inspectStoredAuthSession,
  isPkceVerifierKey,
} from '@/lib/auth-storage';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('web auth storage', () => {
  it('derives the SDK storage key only from a valid HTTP(S) Supabase URL', () => {
    expect(deriveSupabaseAuthStorageKey('https://project-ref.supabase.co')).toBe(
      'sb-project-ref-auth-token'
    );
    expect(deriveSupabaseAuthStorageKey('http://127.0.0.1:54321')).toBe(
      'sb-127-auth-token'
    );
    expect(deriveSupabaseAuthStorageKey('not-a-url')).toBeNull();
    expect(deriveSupabaseAuthStorageKey('file:///unsafe')).toBeNull();
    expect(deriveSupabaseAuthStorageKey(undefined)).toBeNull();
  });

  it('keeps sessions tab-scoped and PKCE verifiers cross-tab', () => {
    const tab = memoryStorage();
    const crossTab = memoryStorage();
    const storage = createSplitAuthStorage(tab, crossTab);

    storage.setItem('sb-project-auth-token', 'session');
    storage.setItem('sb-project-auth-token-code-verifier', 'verifier');

    expect(tab.getItem('sb-project-auth-token')).toBe('session');
    expect(crossTab.getItem('sb-project-auth-token')).toBeNull();
    expect(tab.getItem('sb-project-auth-token-code-verifier')).toBeNull();
    expect(crossTab.getItem('sb-project-auth-token-code-verifier')).toBe('verifier');
  });

  it('cleans both stores after an exchange or sign-out', () => {
    const tab = memoryStorage();
    const crossTab = memoryStorage();
    const storage = createSplitAuthStorage(tab, crossTab);
    const key = 'sb-project-auth-token-code-verifier';

    tab.setItem(key, 'stale-tab-value');
    crossTab.setItem(key, 'active-value');
    storage.removeItem(key);

    expect(tab.getItem(key)).toBeNull();
    expect(crossTab.getItem(key)).toBeNull();
    expect(isPkceVerifierKey(key)).toBe(true);
    expect(isPkceVerifierKey('sb-project-auth-token')).toBe(false);
  });
});

describe('stored auth session identity', () => {
  it('extracts the user bound to a persisted Supabase session', () => {
    expect(
      inspectStoredAuthSession(
        JSON.stringify({ access_token: 'token', refresh_token: 'refresh', user: { id: 'user-a' } })
      )
    ).toEqual({ status: 'valid', userId: 'user-a' });
  });

  it('fails closed for missing or malformed session values', () => {
    expect(inspectStoredAuthSession(null)).toEqual({ status: 'missing' });
    expect(inspectStoredAuthSession('{not-json')).toEqual({ status: 'invalid' });
    expect(inspectStoredAuthSession(JSON.stringify({ user: {} }))).toEqual({ status: 'invalid' });
  });

  it('never clears a valid session belonging to a different user', () => {
    expect(
      decideLocalAuthSessionClear({ status: 'valid', userId: 'user-b' }, 'user-a')
    ).toBe('different-user');
    expect(
      decideLocalAuthSessionClear({ status: 'valid', userId: 'user-a' }, 'user-a')
    ).toBe('cleared');
    expect(decideLocalAuthSessionClear({ status: 'invalid' }, 'user-a')).toBe('unknown');
    expect(decideLocalAuthSessionClear({ status: 'missing' }, 'user-a')).toBe('missing');
  });
});
