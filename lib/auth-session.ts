export type SessionHydrationToken = Readonly<{
  epoch: number;
  userId: string | null;
}>;

export type SessionHydrationGuard = {
  begin: (userId: string | null) => SessionHydrationToken;
  advance: () => SessionHydrationToken;
  current: () => SessionHydrationToken;
  isCurrent: (token: SessionHydrationToken) => boolean;
  isCurrentUser: (userId: string) => boolean;
};

export type AuthMutationKind =
  | 'account-delete'
  | 'mfa-change'
  | 'password-reset'
  | 'password-update'
  | 'session-exchange'
  | 'sign-in'
  | 'sign-out'
  | 'sign-up';

export type AuthMutationToken = Readonly<{
  sequence: number;
  kind: AuthMutationKind;
  userId: string | null;
}>;

export type AuthMutationGate = {
  begin: (kind: AuthMutationKind, userId?: string | null) => AuthMutationToken | null;
  current: () => AuthMutationToken | null;
  finish: (token: AuthMutationToken) => void;
  isActive: (token: AuthMutationToken) => boolean;
};

export type InitialAuthRestoreBarrier = Readonly<{
  ready: Promise<boolean>;
  settle: (succeeded: boolean) => void;
}>;

/**
 * Holds auth callbacks until the persisted startup identity has either been
 * committed or failed closed. Supabase may emit an auth event while the first
 * SecureStore read is still pending; processing that event early would lose
 * the prior authenticated identity needed to reject an account replacement.
 */
export function createInitialAuthRestoreBarrier(): InitialAuthRestoreBarrier {
  let settled = false;
  let resolveReady!: (succeeded: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  return {
    ready,
    settle(succeeded) {
      if (settled) return;
      settled = true;
      resolveReady(succeeded);
    },
  };
}

export function canProcessAuthEventAfterInitialRestore(
  restoreSucceeded: boolean,
  callbackHasSession: boolean,
  activeMutationKind: AuthMutationKind | null
): boolean {
  if (restoreSucceeded || !callbackHasSession) return true;
  return activeMutationKind === 'sign-in' || activeMutationKind === 'sign-up';
}

export function createSessionHydrationGuard(): SessionHydrationGuard {
  let epoch = 0;
  let currentUserId: string | null = null;

  return {
    begin(userId) {
      epoch += 1;
      currentUserId = userId;
      return { epoch, userId };
    },
    advance() {
      epoch += 1;
      return { epoch, userId: currentUserId };
    },
    current() {
      return { epoch, userId: currentUserId };
    },
    isCurrent(token) {
      return token.epoch === epoch && token.userId === currentUserId;
    },
    isCurrentUser(userId) {
      return userId === currentUserId;
    },
  };
}

/**
 * Serializes session-changing actions that share the singleton Supabase client.
 * In particular, account deletion keeps this gate until its server response and
 * local sign-out have both settled, so a later sign-in cannot be removed by a
 * stale deletion completion.
 */
export function createAuthMutationGate(): AuthMutationGate {
  let sequence = 0;
  let active: AuthMutationToken | null = null;

  return {
    begin(kind, userId = null) {
      if (active) return null;
      active = { sequence: ++sequence, kind, userId };
      return active;
    },
    current() {
      return active;
    },
    finish(token) {
      if (active === token) active = null;
    },
    isActive(token) {
      return active === token;
    },
  };
}

// The app intentionally has one Supabase auth client per platform bundle, so
// all callers must share the same mutation gate as well.
export const authMutationGate = createAuthMutationGate();

/** Keeps password-recovery intent bound to the authoritative current user. */
export function reconcilePasswordRecoveryIntent(
  intendedUserIds: Set<string>,
  currentUserId: string | null
): boolean {
  const matchesCurrentUser = Boolean(currentUserId && intendedUserIds.has(currentUserId));
  intendedUserIds.clear();
  if (matchesCurrentUser && currentUserId) intendedUserIds.add(currentUserId);
  return matchesCurrentUser;
}

export function isUnexpectedAuthenticatedIdentityReplacement(
  previousUserId: string | null,
  nextUserId: string | null
): boolean {
  return Boolean(previousUserId && nextUserId && previousUserId !== nextUserId);
}
