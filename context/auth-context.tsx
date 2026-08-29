import { isAuthSessionMissingError, type Session, type User } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';

import {
  authMutationGate,
  createSessionHydrationGuard,
  reconcilePasswordRecoveryIntent,
  type SessionHydrationToken,
} from '@/lib/auth-session';
import { toActionError } from '@/lib/errors';
import { appRouteUrl } from '@/lib/links';
import { usernameKey, validateUsername } from '@/lib/moderation';
import {
  revokeAllPushNotificationDevices,
  revokePushNotificationDevice,
} from '@/lib/push-notifications';
import {
  clearLocalAuthSessionForUser,
  getLocalAuthSessionSnapshot,
  isSupabaseConfigured,
  resetRealtimeAuthToAnonymous,
  supabase,
} from '@/lib/supabase';
import { AccountRole, AccountSummary, ActionResult } from '@/types/marketplace';

type AuthStatus = 'loading' | 'unconfigured' | 'anonymous' | 'authenticated' | 'error';
type SecurityStatus = 'loading' | 'ready' | 'error';
type SessionHydrationReservation = Readonly<{
  token: SessionHydrationToken;
  identityChanged: boolean;
}>;

type SignUpInput = {
  displayName: string;
  username: string;
  email: string;
  password: string;
  role: AccountRole;
  acceptedTerms: boolean;
};

type AuthContextValue = {
  account: AccountSummary | null;
  status: AuthStatus;
  isConfigured: boolean;
  isBusy: boolean;
  recoveryReady: boolean;
  mfaEnrolled: boolean;
  assuranceLevel: 'aal1' | 'aal2' | null;
  securityStatus: SecurityStatus;
  message: string | null;
  checkUsername: (username: string) => Promise<ActionResult<{ available: boolean }>>;
  signUp: (input: SignUpInput) => Promise<ActionResult<{ requiresEmailVerification: boolean }>>;
  signIn: (
    email: string,
    password: string
  ) => Promise<ActionResult<{ requiresMfa: boolean }>>;
  requestPasswordReset: (email: string) => Promise<ActionResult>;
  updatePassword: (password: string) => Promise<ActionResult>;
  signOut: () => Promise<ActionResult>;
  signOutAllSessions: () => Promise<ActionResult<{ signedOutCurrentSession: boolean }>>;
  deleteAccount: () => Promise<ActionResult>;
  refreshSecurity: () => Promise<ActionResult>;
  clearMessage: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const ACCOUNT_DELETION_TIMEOUT_MS = 30_000;

async function confirmNotificationRevocation(
  userId: string,
  allDevices: boolean,
): Promise<ActionResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      allDevices
        ? revokeAllPushNotificationDevices(userId)
        : revokePushNotificationDevice(userId),
      new Promise<ActionResult>((resolve) => {
        timeout = setTimeout(() => resolve({
          ok: false,
          code: 'NETWORK',
          reason: 'Spottr could not confirm that device alerts were detached. Check your connection and try again.',
        }), 5_000);
      }),
    ]);
  } catch {
    return {
      ok: false,
      code: 'NETWORK',
      reason: 'Spottr could not confirm that device alerts were detached. Check your connection and try again.',
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function authMutationConflict(): Extract<ActionResult, { ok: false }> {
  return {
    ok: false,
    code: 'CONFLICT',
    reason: 'Another account security action is still finishing. Wait a moment and try again.',
  };
}

function isAlreadyRevokedSignOutError(error: unknown): boolean {
  if (isAuthSessionMissingError(error)) return true;
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403 || status === 404;
}

function safeUserAccount(user: User): AccountSummary {
  const metadata = user.user_metadata ?? {};
  return {
    id: user.id,
    username:
      typeof metadata.username === 'string' && metadata.username.trim()
        ? metadata.username.trim()
        : `member_${user.id.replaceAll('-', '').slice(0, 8)}`,
    displayName:
      typeof metadata.display_name === 'string' && metadata.display_name.trim()
        ? metadata.display_name.trim()
        : 'Spottr member',
    email: user.email ?? '',
    role: 'customer',
    emailVerified: Boolean(user.email_confirmed_at),
    avatarPath: null,
  };
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>(isSupabaseConfigured ? 'loading' : 'unconfigured');
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const [assuranceLevel, setAssuranceLevel] = useState<'aal1' | 'aal2' | null>(null);
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus>(
    isSupabaseConfigured ? 'loading' : 'ready'
  );
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const deletionIdempotencyKey = useRef<string | null>(null);
  const recoveryIntentUsers = useRef(new Set<string>());
  const sessionHydration = useMemo(() => createSessionHydrationGuard(), []);

  const failClosedSessionReconciliation = useCallback(async (
    reason: string,
    expectedToken?: SessionHydrationToken,
    expectedUserId?: string | null
  ): Promise<boolean> => {
    if (expectedToken && !sessionHydration.isCurrent(expectedToken)) return false;
    if (expectedToken && expectedUserId !== undefined && expectedToken.userId !== expectedUserId) {
      return false;
    }
    const failureToken = sessionHydration.begin(null);
    deletionIdempotencyKey.current = null;
    recoveryIntentUsers.current.clear();
    setAccount(null);
    setMfaEnrolled(false);
    setAssuranceLevel(null);
    setRecoveryReady(false);
    setIsBusy(false);
    setStatus('error');
    setSecurityStatus('error');
    setMessage(reason);
    const client = supabase;
    if (!client) return true;
    client.realtime.disconnect();
    await Promise.all([
      resetRealtimeAuthToAnonymous().catch(() => undefined),
      client.removeAllChannels().catch(() => undefined),
    ]);
    if (!mounted.current || !sessionHydration.isCurrent(failureToken)) return true;
    client.realtime.disconnect();
    return true;
  }, [sessionHydration]);

  const hydrateSession = useCallback(async (
    session: Session | null,
    reservation?: SessionHydrationReservation
  ) => {
    const targetUserId = session?.user?.id ?? null;
    const identityChanged =
      reservation?.identityChanged ?? sessionHydration.current().userId !== targetUserId;
    const hydration = reservation?.token ?? sessionHydration.begin(targetUserId);
    if (
      hydration.userId !== targetUserId ||
      !mounted.current ||
      !sessionHydration.isCurrent(hydration)
    ) {
      return;
    }
    if (identityChanged) {
      const recoveryMatchesTarget = reconcilePasswordRecoveryIntent(
        recoveryIntentUsers.current,
        targetUserId
      );
      deletionIdempotencyKey.current = null;
      setAccount(null);
      setMfaEnrolled(false);
      setAssuranceLevel(null);
      setRecoveryReady(recoveryMatchesTarget);
      setMessage(null);
      setIsBusy(false);
    }
    if (!session?.user) {
      setStatus('anonymous');
      setSecurityStatus('ready');
      return;
    }
    if (identityChanged) {
      setStatus('loading');
      setSecurityStatus('loading');
    }

    const client = supabase;
    const fallback = safeUserAccount(session.user);
    if (!client) {
      if (!mounted.current || !sessionHydration.isCurrent(hydration)) return;
      setAccount(fallback);
      setStatus('authenticated');
      return;
    }

    const hydrationResults = await Promise.all([
      client
        .from('profiles')
        .select('username, display_name, avatar_path')
        .eq('user_id', session.user.id)
        .maybeSingle(),
      client
        .from('business_members')
        .select('business_id')
        .eq('user_id', session.user.id)
        .eq('status', 'active')
        .limit(1),
      client.auth.mfa.listFactors(),
      client.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]).catch(() => null);

    if (!mounted.current || !sessionHydration.isCurrent(hydration)) return;
    if (!hydrationResults) {
      setAccount(fallback);
      setMfaEnrolled(false);
      setAssuranceLevel(null);
      setSecurityStatus('error');
      setStatus('authenticated');
      return;
    }

    const [profileResult, membershipResult, factorsResult, assuranceResult] = hydrationResults;

    const profile = profileResult.data as
      | { username?: string; display_name?: string; avatar_path?: string | null }
      | null;
    const hasBusiness = Boolean(membershipResult.data?.length);
    const securityFailed = Boolean(factorsResult.error || assuranceResult.error);

    setAccount({
      ...fallback,
      username: profile?.username || fallback.username,
      displayName: profile?.display_name || fallback.displayName,
      avatarPath: profile?.avatar_path ?? null,
      role: hasBusiness ? 'business' : 'customer',
    });
    setMfaEnrolled(Boolean(factorsResult.data?.totp.length));
    setAssuranceLevel(assuranceResult.data?.currentLevel ?? null);
    setSecurityStatus(securityFailed ? 'error' : 'ready');
    setStatus('authenticated');
  }, [sessionHydration]);

  const reconcileSessionAfterRevocation = useCallback(async (
    expectedUserId: string
  ): Promise<boolean> => {
    const client = supabase;
    if (!client) return true;

    const readAuthoritativeSession = async (): Promise<
      | { kind: 'anonymous'; token: SessionHydrationToken }
      | { kind: 'already-anonymous' }
      | { kind: 'preserved' }
      | { kind: 'replacement' }
    > => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const readToken = sessionHydration.current();
        const sessionResult = await client.auth.getSession();
        if (sessionResult.error) throw sessionResult.error;
        if (!mounted.current) throw new Error('Account security was closed before reconciliation.');
        if (!sessionHydration.isCurrent(readToken)) continue;

        const remainingSession = sessionResult.data.session;
        if (remainingSession?.user.id === expectedUserId) {
          // A stale revocation must never clear account A from storage after
          // the in-memory epoch has already moved to account B.
          if (readToken.userId !== expectedUserId) return { kind: 'preserved' };
          const clearResult = await clearLocalAuthSessionForUser(expectedUserId);
          if (clearResult === 'unknown') {
            await failClosedSessionReconciliation(
              'Spottr could not verify the revoked local session. Sign in again to continue.',
              readToken,
              expectedUserId
            );
            throw new Error('The revoked local session identity could not be verified.');
          }
          continue;
        }
        if (!remainingSession) {
          if (readToken.userId === expectedUserId) {
            return { kind: 'anonymous', token: readToken };
          }
          return readToken.userId === null
            ? { kind: 'already-anonymous' }
            : { kind: 'preserved' };
        }

        // Channels created for account A must never be retokened as account B.
        // Close them before installing or hydrating the replacement identity.
        try {
          await Promise.all([
            resetRealtimeAuthToAnonymous(),
            client.removeAllChannels(),
          ]);
        } catch (error) {
          await resetRealtimeAuthToAnonymous().catch(() => undefined);
          client.realtime.disconnect();
          await failClosedSessionReconciliation(
            'Spottr could not isolate the replacement account session. Sign in again to continue.',
            readToken,
            expectedUserId
          );
          throw error;
        }
        if (!mounted.current) throw new Error('Account security was closed before reconciliation.');
        if (!sessionHydration.isCurrent(readToken)) continue;
        const sessionAfterChannelCleanup = await client.auth.getSession();
        if (sessionAfterChannelCleanup.error) throw sessionAfterChannelCleanup.error;
        if (!mounted.current) throw new Error('Account security was closed before reconciliation.');
        if (!sessionHydration.isCurrent(readToken)) continue;
        const activeSession = sessionAfterChannelCleanup.data.session;
        if (activeSession?.user.id === expectedUserId) {
          if (readToken.userId !== expectedUserId) return { kind: 'preserved' };
          continue;
        }
        if (!activeSession) {
          if (readToken.userId === expectedUserId) {
            return { kind: 'anonymous', token: readToken };
          }
          return readToken.userId === null
            ? { kind: 'already-anonymous' }
            : { kind: 'preserved' };
        }

        const replacementUserId = activeSession.user.id;
        const reservation: SessionHydrationReservation = {
          identityChanged: sessionHydration.current().userId !== replacementUserId,
          token: sessionHydration.begin(replacementUserId),
        };
        try {
          await client.realtime.setAuth(activeSession.access_token);
        } catch (error) {
          await resetRealtimeAuthToAnonymous().catch(() => undefined);
          client.realtime.disconnect();
          await failClosedSessionReconciliation(
            'Spottr could not secure the replacement account session. Sign in again to continue.',
            reservation.token,
            replacementUserId
          );
          throw error;
        }
        if (!mounted.current || !sessionHydration.isCurrent(reservation.token)) continue;
        await hydrateSession(activeSession, reservation);
        return { kind: 'replacement' };
      }
      throw new Error('The active session changed too often to reconcile safely.');
    };

    const firstResult = await readAuthoritativeSession();
    if (firstResult.kind === 'replacement' || firstResult.kind === 'preserved') return false;

    try {
      await Promise.all([
        resetRealtimeAuthToAnonymous(),
        client.removeAllChannels(),
      ]);
    } catch {
      await resetRealtimeAuthToAnonymous().catch(() => undefined);
      client.realtime.disconnect();
    }

    // Channel cleanup yields to the event loop. Re-read storage and bind the
    // anonymous commit to that exact epoch so it cannot overwrite a new login.
    const finalResult = await readAuthoritativeSession();
    if (finalResult.kind === 'replacement' || finalResult.kind === 'preserved') return false;
    if (finalResult.kind === 'already-anonymous') return true;
    if (!sessionHydration.isCurrent(finalResult.token)) {
      throw new Error('The active session changed before sign-out could finish.');
    }
    if (finalResult.token.userId !== expectedUserId) return false;
    const reservation: SessionHydrationReservation = {
      identityChanged: sessionHydration.current().userId !== null,
      token: sessionHydration.begin(null),
    };
    await hydrateSession(null, reservation);
    return true;
  }, [failClosedSessionReconciliation, hydrateSession, sessionHydration]);

  const refreshSecurity = useCallback(async (): Promise<ActionResult> => {
    const client = supabase;
    if (!client) {
      setMfaEnrolled(false);
      setAssuranceLevel(null);
      setSecurityStatus('ready');
      return { ok: true };
    }

    const expectedUserId = sessionHydration.current().userId;
    if (!expectedUserId) {
      setMfaEnrolled(false);
      setAssuranceLevel(null);
      setSecurityStatus('error');
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'Sign in again before checking account security.',
      };
    }
    setSecurityStatus('loading');
    try {
      const [factorsResult, assuranceResult] = await Promise.all([
        client.auth.mfa.listFactors(),
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
      const currentSession = await client.auth.getSession();
      if (
        !mounted.current ||
        !sessionHydration.isCurrentUser(expectedUserId) ||
        currentSession.error ||
        currentSession.data.session?.user.id !== expectedUserId
      ) {
        setMfaEnrolled(false);
        setAssuranceLevel(null);
        setSecurityStatus('error');
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'Your session changed. Sign in again before checking security.',
        };
      }
      if (factorsResult.error || assuranceResult.error) {
        setSecurityStatus('error');
        return toActionError(
          factorsResult.error ?? assuranceResult.error,
          'Account security status could not be verified.'
        );
      }
      setMfaEnrolled(Boolean(factorsResult.data.totp.length));
      setAssuranceLevel(assuranceResult.data.currentLevel);
      setSecurityStatus('ready');
      return { ok: true };
    } catch (error) {
      const currentSession = await client.auth.getSession().catch(() => null);
      if (
        !mounted.current ||
        !sessionHydration.isCurrentUser(expectedUserId) ||
        !currentSession ||
        currentSession.error ||
        currentSession.data.session?.user.id !== expectedUserId
      ) {
        setMfaEnrolled(false);
        setAssuranceLevel(null);
        setSecurityStatus('error');
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'Your session changed. Sign in again before checking security.',
        };
      }
      setSecurityStatus('error');
      return toActionError(error, 'Account security status could not be verified.');
    }
  }, [sessionHydration]);

  useEffect(() => {
    mounted.current = true;
    const client = supabase;

    if (!client) {
      return () => {
        mounted.current = false;
      };
    }

    const restoreRequest = sessionHydration.advance();
    client.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        if (!mounted.current || !sessionHydration.isCurrent(restoreRequest)) return;
        return hydrateSession(data.session);
      })
      .catch(() => {
        if (!mounted.current || !sessionHydration.isCurrent(restoreRequest)) return;
        return failClosedSessionReconciliation(
          'Spottr could not restore your session. You can retry by signing in.',
          restoreRequest
        );
      });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      const priorUserId = sessionHydration.current().userId;
      const recoveryHintUserId = session?.user?.id ?? null;
      if (event === 'PASSWORD_RECOVERY' && recoveryHintUserId) {
        recoveryIntentUsers.current.add(recoveryHintUserId);
      }
      const authEventRequest = sessionHydration.advance();
      let realtimePreparation: Promise<void> | null = null;

      if (Platform.OS === 'web') {
        const tabSession = getLocalAuthSessionSnapshot();
        if (tabSession && tabSession.user.id === priorUserId) {
          void client.realtime.setAuth(tabSession.access_token).catch(() => undefined);
        } else {
          realtimePreparation = (async () => {
            await Promise.all([
              resetRealtimeAuthToAnonymous().catch(() => undefined),
              client.removeAllChannels().catch(() => undefined),
            ]);
            if (!mounted.current || !sessionHydration.isCurrent(authEventRequest)) return;
          })();
        }
      } else if (session?.user.id === priorUserId) {
        void client.realtime.setAuth(session.access_token).catch(() => undefined);
      } else {
        // Native auth callbacks are authoritative. Neutralize the old token
        // immediately; the post-lock read below installs the verified session.
        realtimePreparation = (async () => {
          await Promise.all([
            resetRealtimeAuthToAnonymous().catch(() => undefined),
            client.removeAllChannels().catch(() => undefined),
          ]);
          if (!mounted.current || !sessionHydration.isCurrent(authEventRequest)) return;
        })();
      }

      // Supabase dispatches auth callbacks while its exclusive auth lock is
      // held. After it returns, read this tab/device's authoritative session;
      // the callback payload may have been broadcast by a different web tab.
      setTimeout(() => {
        void (async () => {
          let activeRequest = authEventRequest;
          try {
            if (realtimePreparation) await realtimePreparation;
            if (!mounted.current || !sessionHydration.isCurrent(authEventRequest)) return;
            const { data, error } = await client.auth.getSession();
            if (!mounted.current || !sessionHydration.isCurrent(authEventRequest)) return;
            if (error) throw error;

            const authoritativeSession = data.session;
            const targetUserId = authoritativeSession?.user?.id ?? null;
            const recoveryMatchesTarget = reconcilePasswordRecoveryIntent(
              recoveryIntentUsers.current,
              targetUserId
            );
            const reservation: SessionHydrationReservation = {
              identityChanged: sessionHydration.current().userId !== targetUserId,
              token: sessionHydration.begin(targetUserId),
            };
            activeRequest = reservation.token;
            if (reservation.identityChanged) {
              await Promise.all([
                resetRealtimeAuthToAnonymous(),
                client.removeAllChannels(),
              ]);
              if (!mounted.current || !sessionHydration.isCurrent(reservation.token)) return;
            }
            if (authoritativeSession) {
              await client.realtime.setAuth(authoritativeSession.access_token);
            } else {
              await Promise.all([
                resetRealtimeAuthToAnonymous(),
                client.removeAllChannels(),
              ]);
            }
            await hydrateSession(authoritativeSession, reservation);
            if (!mounted.current || !sessionHydration.isCurrent(reservation.token)) return;
            setRecoveryReady(recoveryMatchesTarget);
          } catch {
            if (!mounted.current || !sessionHydration.isCurrent(activeRequest)) return;
            await failClosedSessionReconciliation(
              'Spottr could not reconcile the current session. Sign in again to continue.',
              activeRequest
            );
          }
        })();
      }, 0);
    });

    const handleDeepLink = async ({ url }: { url: string }) => {
      if (Platform.OS === 'web') return;
      const parsed = Linking.parse(url);
      const path = (parsed.path ?? parsed.hostname ?? '').replace(/^\/+|\/+$/g, '');
      const isRecovery = path === 'reset-password';
      const isAuthCallback = path === 'auth';
      if (!isRecovery && !isAuthCallback) return;
      const code = typeof parsed.queryParams?.code === 'string' ? parsed.queryParams.code : null;
      if (!code) return;
      const authOperation = authMutationGate.begin('session-exchange');
      if (!authOperation) {
        if (mounted.current) {
          if (isRecovery) setRecoveryReady(false);
          setMessage(
            'Another account security action is still finishing. Open this link again shortly.'
          );
        }
        return;
      }
      try {
        recoveryIntentUsers.current.clear();
        setRecoveryReady(false);
        const currentSession = await client.auth.getSession();
        if (currentSession.error) throw currentSession.error;
        if (currentSession.data.session) {
          if (mounted.current) {
            setMessage(
              isRecovery
                ? 'Sign out before opening a password-recovery link. This protects the account already active on this device.'
                : 'Sign out before opening an account verification link. This protects the account already active on this device.'
            );
          }
          return;
        }
        const { data, error } = await client.auth.exchangeCodeForSession(code);
        if (error && mounted.current) {
          if (isRecovery) {
            recoveryIntentUsers.current.clear();
            setRecoveryReady(false);
          }
          setMessage(
            isRecovery
              ? 'This password-recovery link is invalid or has expired. Request a new one.'
              : 'This verification link is invalid or has expired. Sign in or request a new email.'
          );
        } else if (mounted.current && isRecovery) {
          const recoveredUserId = data.session?.user?.id;
          recoveryIntentUsers.current.clear();
          if (recoveredUserId) recoveryIntentUsers.current.add(recoveredUserId);
          setRecoveryReady(Boolean(recoveredUserId));
        }
      } catch {
        if (mounted.current) {
          recoveryIntentUsers.current.clear();
          setRecoveryReady(false);
          setMessage(
            isRecovery
              ? 'Password recovery could not be completed. Request a new link and try again.'
              : 'Account verification could not be completed. Open the link again shortly.'
          );
        }
      } finally {
        authMutationGate.finish(authOperation);
      }
    };
    const linkSubscription = Linking.addEventListener('url', (event) => {
      void handleDeepLink(event);
    });
    void Linking.getInitialURL()
      .then((url) => {
        if (url) void handleDeepLink({ url });
      })
      .catch(() => undefined);

    return () => {
      mounted.current = false;
      subscription.unsubscribe();
      linkSubscription.remove();
    };
  }, [failClosedSessionReconciliation, hydrateSession, sessionHydration]);

  const checkUsername = useCallback(
    async (username: string): Promise<ActionResult<{ available: boolean }>> => {
      const localError = validateUsername(username, []);
      if (localError) return { ok: false, code: 'INVALID', reason: localError };

      const client = supabase;
      if (!client) {
        const unavailable = ['maya.rose', 'miraeats', 'alexonfoot', 'westsidebites'].includes(
          username.trim().toLocaleLowerCase('en-US')
        );
        return { ok: true, data: { available: !unavailable } };
      }

      try {
        const { data, error } = await client.rpc('is_username_available', {
          candidate: username.normalize('NFKC').trim(),
        });
        if (error) throw error;
        return { ok: true, data: { available: Boolean(data) } };
      } catch (error) {
        return toActionError(error, 'Username availability could not be checked.');
      }
    },
    []
  );

  const signUp = useCallback(
    async (input: SignUpInput): Promise<ActionResult<{ requiresEmailVerification: boolean }>> => {
      const client = supabase;
      if (!client) {
        return {
          ok: false,
          code: 'CONFIG_REQUIRED',
          reason: 'Account creation becomes available when the production backend is connected.',
        };
      }

      const usernameError = validateUsername(input.username, []);
      if (usernameError) return { ok: false, code: 'INVALID', reason: usernameError };
      if (!input.acceptedTerms) {
        return { ok: false, code: 'INVALID', reason: 'Accept the Terms and Privacy Policy to continue.' };
      }

      const authOperation = authMutationGate.begin('sign-up');
      if (!authOperation) return authMutationConflict();

      recoveryIntentUsers.current.clear();
      setRecoveryReady(false);
      setIsBusy(true);
      setMessage(null);
      try {
        const availability = await checkUsername(input.username);
        if (!availability.ok) return availability;
        if (!availability.data?.available) {
          return { ok: false, code: 'CONFLICT', reason: 'That username is already taken.' };
        }

        const { data, error } = await client.auth.signUp({
          email: input.email.trim().toLocaleLowerCase('en-US'),
          password: input.password,
          options: {
            emailRedirectTo: appRouteUrl('/auth', {
              verified: '1',
              next: input.role === 'business' ? 'business-onboarding' : 'home',
            }),
            data: {
              display_name: input.displayName.trim(),
              username: usernameKey(input.username),
              requested_role: input.role,
              terms_accepted: true,
            },
          },
        });
        if (error) throw error;

        const requiresEmailVerification = !data.session;
        return {
          ok: true,
          data: { requiresEmailVerification },
          message: requiresEmailVerification
            ? 'Check your email to verify your account.'
            : 'Your Spottr account is ready.',
        };
      } catch (error) {
        return toActionError(error, 'Your account could not be created. Please try again.');
      } finally {
        authMutationGate.finish(authOperation);
        setIsBusy(false);
      }
    },
    [checkUsername]
  );

  const signIn = useCallback(async (
    email: string,
    password: string
  ): Promise<ActionResult<{ requiresMfa: boolean }>> => {
    const client = supabase;
    if (!client) {
      return {
        ok: false,
        code: 'CONFIG_REQUIRED',
        reason: 'Live sign-in is unavailable because Spottr services are not configured.',
      };
    }

    const authOperation = authMutationGate.begin('sign-in');
    if (!authOperation) return authMutationConflict();

    recoveryIntentUsers.current.clear();
    setRecoveryReady(false);
    setIsBusy(true);
    setMessage(null);
    try {
      const existingSession = await client.auth.getSession();
      if (existingSession.error) throw existingSession.error;
      if (existingSession.data.session) {
        return {
          ok: false,
          code: 'CONFLICT',
          reason: 'Sign out of the current account before signing in to another one.',
        };
      }
      const { data: signInData, error } = await client.auth.signInWithPassword({
        email: email.trim().toLocaleLowerCase('en-US'),
        password,
      });
      if (error) throw error;
      const signedInUserId = signInData.user?.id ?? signInData.session?.user?.id;
      if (!signedInUserId) throw new Error('Sign-in did not return an authenticated user.');
      const [factorsResult, assuranceResult] = await Promise.all([
        client.auth.mfa.listFactors(),
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
      const currentSession = await client.auth.getSession();
      if (currentSession.error || currentSession.data.session?.user?.id !== signedInUserId) {
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'Your session changed before sign-in finished. Check the current account and retry.',
        };
      }
      if (factorsResult.error || assuranceResult.error) {
        setSecurityStatus('error');
        return {
          ok: true,
          data: { requiresMfa: true },
          message: 'Signed in. Verify account security before continuing.',
        };
      }
      const enrolled = Boolean(factorsResult.data.totp.length);
      const currentLevel = assuranceResult.data.currentLevel;
      setMfaEnrolled(enrolled);
      setAssuranceLevel(currentLevel);
      setSecurityStatus('ready');
      return {
        ok: true,
        data: { requiresMfa: enrolled && currentLevel !== 'aal2' },
        message: 'Signed in securely.',
      };
    } catch (error) {
      return toActionError(error, 'Sign-in failed. Please try again.');
    } finally {
      authMutationGate.finish(authOperation);
      setIsBusy(false);
    }
  }, []);

  const requestPasswordReset = useCallback(async (email: string): Promise<ActionResult> => {
    const client = supabase;
    if (!client) {
      return {
        ok: false,
        code: 'CONFIG_REQUIRED',
        reason: 'Password recovery becomes available when the production backend is connected.',
      };
    }

    const authOperation = authMutationGate.begin('password-reset');
    if (!authOperation) return authMutationConflict();

    recoveryIntentUsers.current.clear();
    setRecoveryReady(false);
    setIsBusy(true);
    try {
      const { error } = await client.auth.resetPasswordForEmail(
        email.trim().toLocaleLowerCase('en-US'),
        { redirectTo: appRouteUrl('/reset-password') }
      );
      if (error) throw error;
      return {
        ok: true,
        message: 'If an account exists for that email, a recovery link is on the way.',
      };
    } catch (error) {
      return toActionError(error, 'Password recovery could not be started.');
    } finally {
      authMutationGate.finish(authOperation);
      setIsBusy(false);
    }
  }, []);

  const updatePassword = useCallback(async (password: string): Promise<ActionResult> => {
    const client = supabase;
    if (!client) {
      return {
        ok: false,
        code: 'CONFIG_REQUIRED',
        reason: 'Password recovery becomes available when the production backend is connected.',
      };
    }
    if (!recoveryReady) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'Open a current password-recovery link to choose a new password.',
      };
    }

    const authOperation = authMutationGate.begin(
      'password-update',
      sessionHydration.current().userId
    );
    if (!authOperation) return authMutationConflict();

    setIsBusy(true);
    try {
      const sessionBeforeUpdate = await client.auth.getSession();
      const updatingUserId = sessionBeforeUpdate.data.session?.user?.id ?? null;
      if (
        sessionBeforeUpdate.error ||
        !updatingUserId ||
        !recoveryIntentUsers.current.has(updatingUserId)
      ) {
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'Open a current password-recovery link to choose a new password.',
        };
      }
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      const sessionAfterUpdate = await client.auth.getSession();
      const updatedSession = sessionAfterUpdate.data.session;
      if (
        sessionAfterUpdate.error ||
        !updatedSession ||
        updatedSession.user.id !== updatingUserId
      ) {
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'Your password changed, but the active session also changed. Sign in again.',
        };
      }
      let otherSessionsRevoked = false;
      try {
        const revokeResult = await client.auth.admin.signOut(
          updatedSession.access_token,
          'others'
        );
        otherSessionsRevoked =
          !revokeResult.error || isAlreadyRevokedSignOutError(revokeResult.error);
      } catch {
        otherSessionsRevoked = false;
      }
      recoveryIntentUsers.current.clear();
      setRecoveryReady(false);
      return {
        ok: true,
        message: otherSessionsRevoked
          ? 'Your password was updated and other sessions were revoked.'
          : 'Your password was updated. Spottr could not confirm that every other session was revoked; review your signed-in devices.',
      };
    } catch (error) {
      return toActionError(error, 'Your password could not be updated.');
    } finally {
      authMutationGate.finish(authOperation);
      setIsBusy(false);
    }
  }, [recoveryReady, sessionHydration]);

  const signOut = useCallback(async (): Promise<ActionResult> => {
    const client = supabase;
    if (!client) return { ok: true };

    const expectedUserId = sessionHydration.current().userId;
    if (!expectedUserId) {
      return { ok: true };
    }

    const authOperation = authMutationGate.begin('sign-out', expectedUserId);
    if (!authOperation) return authMutationConflict();

    recoveryIntentUsers.current.clear();
    setRecoveryReady(false);
    setIsBusy(true);
    try {
      const sessionResult = await client.auth.getSession();
      const revokingSession = sessionResult.data.session;
      if (
        sessionResult.error ||
        !revokingSession ||
        revokingSession.user.id !== expectedUserId ||
        !sessionHydration.isCurrentUser(expectedUserId)
      ) {
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'The active session changed while sign-out was finishing. Check the current account.',
        };
      }
      const notificationRevocation = await confirmNotificationRevocation(expectedUserId, false);
      if (!notificationRevocation.ok) return notificationRevocation;
      const revokeResult = await client.auth.admin.signOut(
        revokingSession.access_token,
        'local'
      );
      if (revokeResult.error && !isAlreadyRevokedSignOutError(revokeResult.error)) {
        throw revokeResult.error;
      }
      const clearRequest = sessionHydration.current();
      const clearResult = clearRequest.userId === expectedUserId
        ? await clearLocalAuthSessionForUser(expectedUserId)
        : 'different-user';
      if (clearResult === 'unknown') {
        const failedClosed = await failClosedSessionReconciliation(
          'Spottr could not verify the local session being signed out. Sign in again to continue.',
          clearRequest,
          expectedUserId
        );
        if (!failedClosed) {
          const signedOutCurrentSession = await reconcileSessionAfterRevocation(expectedUserId);
          return {
            ok: true,
            message: signedOutCurrentSession
              ? 'Signed out securely.'
              : 'The prior account was signed out. The newly active account was left untouched.',
          };
        }
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'The local session identity could not be verified safely.',
        };
      }
      const signedOutCurrentSession = await reconcileSessionAfterRevocation(expectedUserId);
      return {
        ok: true,
        message: signedOutCurrentSession
          ? 'Signed out securely.'
          : 'The prior account was signed out. The newly active account was left untouched.',
      };
    } catch (error) {
      return toActionError(error, 'Spottr could not sign out cleanly.');
    } finally {
      authMutationGate.finish(authOperation);
      if (mounted.current) setIsBusy(false);
    }
  }, [
    failClosedSessionReconciliation,
    reconcileSessionAfterRevocation,
    sessionHydration,
  ]);

  const signOutAllSessions = useCallback(async (): Promise<
    ActionResult<{ signedOutCurrentSession: boolean }>
  > => {
    const client = supabase;
    if (!client) {
      return {
        ok: false,
        code: 'CONFIG_REQUIRED',
        reason: 'Live session controls are unavailable because Spottr services are not configured.',
      };
    }
    const expectedUserId = account?.id ?? sessionHydration.current().userId;
    if (!expectedUserId || !sessionHydration.isCurrentUser(expectedUserId)) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'Sign in again before revoking account sessions.',
      };
    }

    const authOperation = authMutationGate.begin('sign-out', expectedUserId);
    if (!authOperation) return authMutationConflict();

    recoveryIntentUsers.current.clear();
    setRecoveryReady(false);
    setIsBusy(true);
    try {
      const sessionResult = await client.auth.getSession();
      const revokingSession = sessionResult.data.session;
      if (
        sessionResult.error ||
        !revokingSession ||
        revokingSession.user.id !== expectedUserId ||
        !authMutationGate.isActive(authOperation) ||
        !sessionHydration.isCurrentUser(expectedUserId)
      ) {
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'Your session changed before revocation started. Check the current account.',
        };
      }

      const verifiedUser = await client.auth.getUser(revokingSession.access_token);
      if (
        verifiedUser.error ||
        verifiedUser.data.user?.id !== expectedUserId ||
        !authMutationGate.isActive(authOperation) ||
        !sessionHydration.isCurrentUser(expectedUserId)
      ) {
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'Spottr could not verify the exact session being revoked. Sign in again.',
        };
      }

      const notificationRevocation = await confirmNotificationRevocation(expectedUserId, true);
      if (!notificationRevocation.ok) return notificationRevocation;
      const revokeResult = await client.auth.admin.signOut(
        revokingSession.access_token,
        'global'
      );
      if (revokeResult.error && !isAlreadyRevokedSignOutError(revokeResult.error)) {
        throw revokeResult.error;
      }

      const clearRequest = sessionHydration.current();
      const clearResult = clearRequest.userId === expectedUserId
        ? await clearLocalAuthSessionForUser(expectedUserId)
        : 'different-user';
      if (clearResult === 'unknown') {
        const failedClosed = await failClosedSessionReconciliation(
          'Spottr could not verify the local session after revocation. Sign in again to continue.',
          clearRequest,
          expectedUserId
        );
        if (!failedClosed) {
          const signedOutCurrentSession = await reconcileSessionAfterRevocation(expectedUserId);
          return {
            ok: true,
            data: { signedOutCurrentSession },
            message: signedOutCurrentSession
              ? 'All Spottr sessions for this account were signed out.'
              : 'The prior account sessions were revoked. The newly active account was left signed in.',
          };
        }
        return {
          ok: false,
          code: 'AUTH_REQUIRED',
          reason: 'The local session identity could not be verified safely.',
        };
      }
      const signedOutCurrentSession = await reconcileSessionAfterRevocation(expectedUserId);
      return {
        ok: true,
        data: { signedOutCurrentSession },
        message: signedOutCurrentSession
          ? 'All Spottr sessions for this account were signed out.'
          : 'The prior account sessions were revoked. The newly active account was left signed in.',
      };
    } catch (error) {
      return toActionError(error, 'Your account sessions could not be revoked.');
    } finally {
      authMutationGate.finish(authOperation);
      if (mounted.current) setIsBusy(false);
    }
  }, [
    account?.id,
    failClosedSessionReconciliation,
    reconcileSessionAfterRevocation,
    sessionHydration,
  ]);

  const deleteAccount = useCallback(async (): Promise<ActionResult> => {
    const client = supabase;
    if (!client) {
      return {
        ok: false,
        code: 'CONFIG_REQUIRED',
        reason: 'Account deletion becomes available when the production backend is connected.',
      };
    }
    if (status !== 'authenticated' || !account?.id) {
      return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in again before deleting this account.' };
    }
    if (assuranceLevel !== 'aal2') {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'Verify a current authenticator code in Security before deleting this account.',
      };
    }
    const deletingUserId = account.id;
    if (!sessionHydration.isCurrentUser(deletingUserId)) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'Sign in again before deleting this account.',
      };
    }

    const deletionOperation = authMutationGate.begin('account-delete', deletingUserId);
    if (!deletionOperation) return authMutationConflict();

    const requestKey =
      deletionIdempotencyKey.current ?? `spottr-delete:${deletingUserId}:${Date.now()}`;
    deletionIdempotencyKey.current = requestKey;
    const deletionRequestIsCurrent = () =>
      mounted.current &&
      authMutationGate.isActive(deletionOperation) &&
      sessionHydration.isCurrentUser(deletingUserId) &&
      deletionIdempotencyKey.current === requestKey;
    const sessionChanged = (): ActionResult => ({
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: 'Your session changed before deletion finished. Check the current account before retrying.',
    });
    const clearDeletedLocalSession = async (): Promise<ActionResult | null> => {
      if (!deletionRequestIsCurrent()) return sessionChanged();
      const beforeClear = await client.auth.getSession();
      if (!deletionRequestIsCurrent()) return sessionChanged();
      if (beforeClear.error) throw beforeClear.error;
      const currentUserId = beforeClear.data.session?.user?.id ?? null;
      if (currentUserId && currentUserId !== deletingUserId) return sessionChanged();

      const clearRequest = sessionHydration.current();
      const clearResult = await clearLocalAuthSessionForUser(deletingUserId);
      if (clearResult === 'unknown') {
        const failedClosed = await failClosedSessionReconciliation(
          'Spottr removed the account but could not verify the local session cache. Sign in again to continue.',
          clearRequest,
          deletingUserId
        );
        if (!failedClosed) await reconcileSessionAfterRevocation(deletingUserId);
        return sessionChanged();
      }
      if (clearResult === 'different-user') {
        await reconcileSessionAfterRevocation(deletingUserId);
        return sessionChanged();
      }

      const cleanupRequest = sessionHydration.current();
      try {
        await reconcileSessionAfterRevocation(deletingUserId);
      } catch (error) {
        await failClosedSessionReconciliation(
          'Spottr removed the account but could not finish local session cleanup. Sign in again to continue.',
          cleanupRequest,
          deletingUserId
        );
        throw error;
      }
      return null;
    };
    setIsBusy(true);
    try {
      const deletionSession = await client.auth.getSession();
      const authenticatedDeletionSession = deletionSession.data.session;
      if (
        deletionSession.error ||
        !authenticatedDeletionSession ||
        authenticatedDeletionSession.user.id !== deletingUserId ||
        !deletionRequestIsCurrent()
      ) {
        return sessionChanged();
      }
      const { data, error } = await client.functions.invoke('delete-account', {
        method: 'DELETE',
        timeout: ACCOUNT_DELETION_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${authenticatedDeletionSession.access_token}`,
          'Idempotency-Key': requestKey,
          'X-Spottr-Delete-Confirmation': 'DELETE',
        },
        body: { confirmation: 'DELETE' },
      });
      if (!deletionRequestIsCurrent()) return sessionChanged();
      if (error) throw error;
      const response =
        data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
      const processing = response?.status === 'processing';
      const deleted = response?.status === 'deleted';
      const accountRemoved =
        processing &&
        response?.phase === 'receipt_finalization' &&
        response?.account_removed === true;
      if (accountRemoved) {
        const clearFailure = await clearDeletedLocalSession();
        if (clearFailure) return clearFailure;
        deletionIdempotencyKey.current = null;
        return {
          ok: true,
          message:
            'Your Spottr account was removed. Its final internal deletion receipt is finishing automatically.',
        };
      }
      if (processing) {
        return {
          ok: false,
          code: 'UNKNOWN',
          reason: 'Deletion is still processing. Keep this verified session open and retry shortly.',
        };
      }
      if (!deleted) throw new Error('Account deletion returned an unexpected response.');
      const clearFailure = await clearDeletedLocalSession();
      if (clearFailure) return clearFailure;
      deletionIdempotencyKey.current = null;
      return {
        ok: true,
        message: 'Your Spottr account and private account data were deleted.',
      };
    } catch (error) {
      if (!deletionRequestIsCurrent()) return sessionChanged();
      return toActionError(
        error,
        'Your account could not be deleted. Keep this session open, verify Security, and retry.'
      );
    } finally {
      authMutationGate.finish(deletionOperation);
      if (mounted.current && sessionHydration.isCurrentUser(deletingUserId)) {
        setIsBusy(false);
      }
    }
  }, [
    account,
    assuranceLevel,
    failClosedSessionReconciliation,
    reconcileSessionAfterRevocation,
    sessionHydration,
    status,
  ]);

  const value = useMemo<AuthContextValue>(
    () => ({
      account,
      status,
      isConfigured: isSupabaseConfigured,
      isBusy,
      recoveryReady,
      mfaEnrolled,
      assuranceLevel,
      securityStatus,
      message,
      checkUsername,
      signUp,
      signIn,
      requestPasswordReset,
      updatePassword,
      signOut,
      signOutAllSessions,
      deleteAccount,
      refreshSecurity,
      clearMessage: () => setMessage(null),
    }),
    [
      account,
      assuranceLevel,
      checkUsername,
      deleteAccount,
      isBusy,
      message,
      mfaEnrolled,
      recoveryReady,
      refreshSecurity,
      requestPasswordReset,
      signIn,
      signOut,
      signOutAllSessions,
      signUp,
      status,
      securityStatus,
      updatePassword,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
