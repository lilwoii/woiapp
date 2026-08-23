import * as SecureStore from 'expo-secure-store';

import { createShadowOrderingRecoveryStore } from '@/lib/ordering-recovery-core';

const nativeLockTails = new Map<string, Promise<void>>();

async function runNativeExclusive<T>(key: string, operation: () => Promise<T>) {
  const previous = nativeLockTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  nativeLockTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (nativeLockTails.get(key) === tail) nativeLockTails.delete(key);
  }
}

const store = createShadowOrderingRecoveryStore({
  getItem: (key) => SecureStore.getItemAsync(key),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
  runExclusive: runNativeExclusive,
  setItem: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
});

export const clearShadowOrderingRecovery = store.clearIfMatches;
export const loadShadowOrderingRecovery = store.load;
export const saveShadowOrderingRecovery = store.save;
