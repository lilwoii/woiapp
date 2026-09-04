import { createShadowOrderingRecoveryStore } from '@/lib/ordering-recovery-core';

function browserStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('Secure browser recovery storage is unavailable.');
  }
  return window.localStorage;
}

const store = createShadowOrderingRecoveryStore({
  getItem: async (key) => browserStorage().getItem(key),
  removeItem: async (key) => browserStorage().removeItem(key),
  runExclusive: async (key, operation) => {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new Error('Cross-tab ordering recovery locks are unavailable.');
    }
    return navigator.locks.request(`spottr-ordering-recovery:${key}`, operation);
  },
  setItem: async (key, value) => browserStorage().setItem(key, value),
});

export const clearShadowOrderingRecovery = store.clearIfMatches;
export const loadShadowOrderingRecovery = store.load;
export const saveShadowOrderingRecovery = store.save;
