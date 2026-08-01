import { createSplitAuthStorage, isPkceVerifierKey } from '@/lib/auth-storage';

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
