import {
  createShadowOrderingRecoveryStore,
  parseShadowOrderingRecovery,
} from '../ordering-recovery-core';

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const businessId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const quotePublicId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function memoryAdapter({ gateFirstRemove = false } = {}) {
  const values = new Map<string, string>();
  const lockTails = new Map<string, Promise<void>>();
  let markFirstRemoveEntered = () => {};
  const firstRemoveEntered = new Promise<void>((resolve) => {
    markFirstRemoveEntered = resolve;
  });
  let releaseFirstRemove = () => {};
  const firstRemoveRelease = new Promise<void>((resolve) => {
    releaseFirstRemove = resolve;
  });
  let markReplacementSetEntered = () => {};
  const replacementSetEntered = new Promise<void>((resolve) => {
    markReplacementSetEntered = resolve;
  });
  let removeCalls = 0;
  let setCalls = 0;
  return {
    values,
    firstRemoveEntered,
    replacementSetEntered,
    releaseFirstRemove,
    adapter: {
      getItem: async (key: string) => values.get(key) ?? null,
      removeItem: async (key: string) => {
        removeCalls += 1;
        if (gateFirstRemove && removeCalls === 1) {
          markFirstRemoveEntered();
          await firstRemoveRelease;
        }
        values.delete(key);
      },
      runExclusive: async <T>(key: string, operation: () => Promise<T>) => {
        const previous = lockTails.get(key) ?? Promise.resolve();
        let release = () => {};
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = previous.then(() => current);
        lockTails.set(key, tail);
        await previous;
        try {
          return await operation();
        } finally {
          release();
          if (lockTails.get(key) === tail) lockTails.delete(key);
        }
      },
      setItem: async (key: string, value: string) => {
        setCalls += 1;
        if (gateFirstRemove && setCalls > 1) markReplacementSetEntered();
        values.set(key, value);
      },
    },
  };
}

describe('shadow ordering crash recovery', () => {
  it('round-trips and conditionally clears a placement retry key', async () => {
    const memory = memoryAdapter();
    const store = createShadowOrderingRecoveryStore(memory.adapter);
    const operation = {
      kind: 'place',
      attempt: {
        businessId,
        quotePublicId,
        quoteVersion: 1,
        idempotencyKey: 'spottr:shadow:place:stable-retry-key',
      },
    } as const;
    await store.save(accountId, businessId, operation);
    expect((await store.load(accountId, businessId))?.operation).toEqual(operation);
    await expect(
      store.save(accountId, businessId, {
        ...operation,
        attempt: {
          ...operation.attempt,
          idempotencyKey: 'spottr:shadow:place:different-retry-key',
        },
      })
    ).rejects.toThrow('different ordering operation');
    await expect(
      store.save(accountId, businessId, {
        ...operation,
        attempt: { ...operation.attempt, quoteVersion: 2 },
      })
    ).rejects.toThrow('different ordering operation');

    await store.clearIfMatches(accountId, businessId, 'a-different-idempotency-key');
    expect(await store.load(accountId, businessId)).not.toBeNull();
    await store.clearIfMatches(accountId, businessId, operation.attempt.idempotencyKey);
    expect(await store.load(accountId, businessId)).toBeNull();
  });

  it('rejects tampering, cross-account replay, and unsupported cancellation reasons', () => {
    const serialized = JSON.stringify({
      schemaVersion: 1,
      accountId,
      businessId,
      updatedAt: '2026-09-01T18:00:00.000Z',
      operation: {
        kind: 'cancel',
        attempt: {
          businessId,
          orderPublicId: quotePublicId,
          expectedVersion: 2,
          reasonCode: 'anything_else',
          idempotencyKey: 'spottr:shadow:cancel:stable-retry-key',
        },
      },
    });
    expect(() => parseShadowOrderingRecovery(serialized, accountId, businessId)).toThrow(
      'invalid'
    );
    expect(() =>
      parseShadowOrderingRecovery(
        serialized.replace('anything_else', 'customer_cancelled_before_acceptance'),
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        businessId
      )
    ).toThrow('invalid');
    expect(() =>
      parseShadowOrderingRecovery(
        serialized
          .replace('anything_else', 'customer_cancelled_before_acceptance')
          .replace(`\"businessId\":\"${businessId}\",\"orderPublicId\"`,
            `\"businessId\":\"dddddddd-dddd-4ddd-8ddd-dddddddddddd\",\"orderPublicId\"`),
        accountId,
        businessId
      )
    ).toThrow('invalid');
  });

  it('does not let an older clear erase a concurrently installed retry record', async () => {
    const memory = memoryAdapter({ gateFirstRemove: true });
    const store = createShadowOrderingRecoveryStore(memory.adapter);
    const first = {
      kind: 'place',
      attempt: {
        businessId,
        quotePublicId,
        quoteVersion: 1,
        idempotencyKey: 'spottr:shadow:place:first-retry-key',
      },
    } as const;
    const replacement = {
      ...first,
      attempt: {
        ...first.attempt,
        idempotencyKey: 'spottr:shadow:place:replacement-retry-key',
      },
    } as const;
    await store.save(accountId, businessId, first);

    const firstClear = store.clearIfMatches(
      accountId,
      businessId,
      first.attempt.idempotencyKey
    );
    await memory.firstRemoveEntered;
    let replacementSettled = false;
    const replacementFlow = (async () => {
      await store.clearIfMatches(accountId, businessId, first.attempt.idempotencyKey);
      await store.save(accountId, businessId, replacement);
      replacementSettled = true;
    })();
    const replacementReachedStorage = await Promise.race([
      memory.replacementSetEntered.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    memory.releaseFirstRemove();
    expect(replacementReachedStorage).toBe(false);
    expect(replacementSettled).toBe(false);
    await Promise.all([
      firstClear,
      replacementFlow,
    ]);

    expect((await store.load(accountId, businessId))?.operation).toEqual(replacement);
  });
});
