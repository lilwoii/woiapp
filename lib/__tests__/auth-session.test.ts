import {
  canProcessAuthEventAfterInitialRestore,
  createAuthMutationGate,
  createInitialAuthRestoreBarrier,
  createSessionHydrationGuard,
  isUnexpectedAuthenticatedIdentityReplacement,
  reconcilePasswordRecoveryIntent,
} from '../auth-session';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('session hydration guard', () => {
  it('ignores delayed prior-user hydration after sign-out', async () => {
    const guard = createSessionHydrationGuard();
    const prior = guard.begin('user-a');
    const delay = deferred();
    const commits: string[] = [];
    const delayedHydration = (async () => {
      await delay.promise;
      if (guard.isCurrent(prior)) commits.push('user-a');
    })();

    guard.begin(null);
    delay.resolve();
    await delayedHydration;

    expect(commits).toEqual([]);
    expect(guard.current()).toEqual({ epoch: 2, userId: null });
  });

  it('commits only the newest user during a rapid account switch', async () => {
    const guard = createSessionHydrationGuard();
    const userA = guard.begin('user-a');
    const userADelay = deferred();
    const commits: string[] = [];
    const delayedA = (async () => {
      await userADelay.promise;
      if (guard.isCurrent(userA)) commits.push('user-a');
    })();

    const userB = guard.begin('user-b');
    const userBDelay = deferred();
    const delayedB = (async () => {
      await userBDelay.promise;
      if (guard.isCurrent(userB)) commits.push('user-b');
    })();

    userADelay.resolve();
    userBDelay.resolve();
    await Promise.all([delayedA, delayedB]);

    expect(commits).toEqual(['user-b']);
    expect(guard.isCurrent({ epoch: userB.epoch, userId: 'user-a' })).toBe(false);
  });

  it('ignores an initial restore that resolves after a newer auth event', async () => {
    const guard = createSessionHydrationGuard();
    const restore = guard.advance();
    const delay = deferred();
    let restored = false;
    const delayedRestore = (async () => {
      await delay.promise;
      if (guard.isCurrent(restore)) restored = true;
    })();

    guard.begin('user-b');
    delay.resolve();
    await delayedRestore;

    expect(restored).toBe(false);
    expect(guard.current().userId).toBe('user-b');
  });

  it('rejects a delayed account operation after switching users', async () => {
    const guard = createSessionHydrationGuard();
    guard.begin('user-a');
    const requestKey = 'delete-user-a';
    let currentRequestKey: string | null = requestKey;
    const delay = deferred();
    const delayedCompletion = (async () => {
      await delay.promise;
      return guard.isCurrentUser('user-a') && currentRequestKey === requestKey;
    })();

    guard.begin('user-b');
    currentRequestKey = null;
    delay.resolve();

    await expect(delayedCompletion).resolves.toBe(false);
    expect(guard.isCurrentUser('user-b')).toBe(true);
  });
});

describe('initial auth restore barrier', () => {
  it('settles against the post-hydration reservation rather than the stale read token', async () => {
    const guard = createSessionHydrationGuard();
    const barrier = createInitialAuthRestoreBarrier();
    const storageRead = guard.advance();
    const restoredIdentity = guard.begin('user-a');

    expect(guard.isCurrent(storageRead)).toBe(false);
    barrier.settle(guard.isCurrent(restoredIdentity));

    await expect(barrier.ready).resolves.toBe(true);
  });

  it('holds a replacement callback until the restored identity is committed', async () => {
    const barrier = createInitialAuthRestoreBarrier();
    let committedUserId: string | null = null;
    const rejected: string[] = [];

    const replacementCallback = barrier.ready.then((restored) => {
      if (restored && isUnexpectedAuthenticatedIdentityReplacement(committedUserId, 'user-b')) {
        rejected.push('user-b');
      }
    });

    expect(rejected).toEqual([]);
    committedUserId = 'user-a';
    barrier.settle(true);
    await replacementCallback;

    expect(rejected).toEqual(['user-b']);
  });

  it('does not release queued callbacks when startup restoration fails closed', async () => {
    const barrier = createInitialAuthRestoreBarrier();
    let processed = false;
    const queuedCallback = barrier.ready.then((restored) => {
      if (restored) processed = true;
    });

    barrier.settle(false);
    barrier.settle(true);
    await queuedCallback;

    expect(processed).toBe(false);
  });

  it('allows recovery only through anonymous or explicit-auth events after failure', () => {
    expect(canProcessAuthEventAfterInitialRestore(false, true, null)).toBe(false);
    expect(canProcessAuthEventAfterInitialRestore(false, false, null)).toBe(true);
    expect(canProcessAuthEventAfterInitialRestore(false, true, 'sign-in')).toBe(true);
    expect(canProcessAuthEventAfterInitialRestore(false, true, 'session-exchange')).toBe(false);
    expect(canProcessAuthEventAfterInitialRestore(true, true, null)).toBe(true);
  });
});

describe('auth mutation gate', () => {
  it('keeps account deletion exclusive through a deferred local-session clear', async () => {
    const gate = createAuthMutationGate();
    const deletion = gate.begin('account-delete', 'user-a')!;
    const delay = deferred();
    const completion = (async () => {
      await delay.promise;
      gate.finish(deletion);
    })();

    expect(gate.begin('sign-in')).toBeNull();
    expect(gate.current()).toBe(deletion);

    delay.resolve();
    await completion;
    expect(gate.begin('sign-in')).not.toBeNull();
  });

  it('keeps a deletion valid across a same-user token refresh', () => {
    const gate = createAuthMutationGate();
    const hydration = createSessionHydrationGuard();
    hydration.begin('user-a');
    const deletion = gate.begin('account-delete', 'user-a')!;

    hydration.begin('user-a');

    expect(hydration.isCurrentUser('user-a')).toBe(true);
    expect(gate.isActive(deletion)).toBe(true);
  });

  it('does not let a stale completion release a newer auth operation', () => {
    const gate = createAuthMutationGate();
    const first = gate.begin('sign-out', 'user-a')!;
    gate.finish(first);
    const second = gate.begin('sign-in')!;

    gate.finish(first);

    expect(gate.isActive(second)).toBe(true);
    expect(gate.current()).toBe(second);
  });
});

describe('password recovery intent', () => {
  it('survives a superseding same-user auth event', () => {
    const guard = createSessionHydrationGuard();
    const intendedUsers = new Set(['user-a']);

    guard.begin('user-a');
    guard.advance();

    expect(reconcilePasswordRecoveryIntent(intendedUsers, guard.current().userId)).toBe(true);
    expect([...intendedUsers]).toEqual(['user-a']);
  });

  it('is discarded when the authoritative user differs from the recovery hint', () => {
    const intendedUsers = new Set(['user-b']);

    expect(reconcilePasswordRecoveryIntent(intendedUsers, 'user-a')).toBe(false);
    expect(intendedUsers.size).toBe(0);
  });
});

describe('authenticated identity replacement', () => {
  it('flags only a direct change between two authenticated users', () => {
    expect(isUnexpectedAuthenticatedIdentityReplacement('user-a', 'user-b')).toBe(true);
    expect(isUnexpectedAuthenticatedIdentityReplacement('user-a', 'user-a')).toBe(false);
    expect(isUnexpectedAuthenticatedIdentityReplacement(null, 'user-b')).toBe(false);
    expect(isUnexpectedAuthenticatedIdentityReplacement('user-a', null)).toBe(false);
  });
});
