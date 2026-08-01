export type AuthStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export const isPkceVerifierKey = (key: string) => key.endsWith('-code-verifier');

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
