import type { Session, User } from '@supabase/supabase-js';
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

import { toActionError } from '@/lib/errors';
import { appRouteUrl } from '@/lib/links';
import { usernameKey, validateUsername } from '@/lib/moderation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { AccountRole, AccountSummary, ActionResult } from '@/types/marketplace';

type AuthStatus = 'loading' | 'unconfigured' | 'anonymous' | 'authenticated' | 'error';
type SecurityStatus = 'loading' | 'ready' | 'error';

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
  deleteAccount: () => Promise<ActionResult>;
  refreshSecurity: () => Promise<ActionResult>;
  clearMessage: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

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

  const hydrateSession = useCallback(async (session: Session | null) => {
    if (!mounted.current) return;
    if (!session?.user) {
      setAccount(null);
      setStatus('anonymous');
      setMfaEnrolled(false);
      setAssuranceLevel(null);
      setSecurityStatus('ready');
      return;
    }

    const client = supabase;
    const fallback = safeUserAccount(session.user);
    if (!client) {
      setAccount(fallback);
      setStatus('authenticated');
      return;
    }

    const [profileResult, membershipResult, factorsResult, assuranceResult] = await Promise.all([
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
    ]);

    if (!mounted.current) return;

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
  }, []);

  const refreshSecurity = useCallback(async (): Promise<ActionResult> => {
    const client = supabase;
    if (!client) {
      setMfaEnrolled(false);
      setAssuranceLevel(null);
      setSecurityStatus('ready');
      return { ok: true };
    }

    setSecurityStatus('loading');
    try {
      const [factorsResult, assuranceResult] = await Promise.all([
        client.auth.mfa.listFactors(),
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
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
      setSecurityStatus('error');
      return toActionError(error, 'Account security status could not be verified.');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const client = supabase;

    if (!client) {
      return () => {
        mounted.current = false;
      };
    }

    client.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        return hydrateSession(data.session);
      })
      .catch(() => {
        if (!mounted.current) return;
        setStatus('error');
        setMessage('Spottr could not restore your session. You can retry by signing in.');
      });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryReady(true);
      if (event === 'SIGNED_OUT') setRecoveryReady(false);
      void hydrateSession(session);
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
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error && mounted.current) {
        if (isRecovery) setRecoveryReady(false);
        setMessage(
          isRecovery
            ? 'This password-recovery link is invalid or has expired. Request a new one.'
            : 'This verification link is invalid or has expired. Sign in or request a new email.'
        );
      } else if (mounted.current && isRecovery) {
        setRecoveryReady(true);
      }
    };
    const linkSubscription = Linking.addEventListener('url', (event) => {
      void handleDeepLink(event);
    });
    void Linking.getInitialURL().then((url) => {
      if (url) void handleDeepLink({ url });
    });

    return () => {
      mounted.current = false;
      subscription.unsubscribe();
      linkSubscription.remove();
    };
  }, [hydrateSession]);

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

    setIsBusy(true);
    setMessage(null);
    try {
      const { error } = await client.auth.signInWithPassword({
        email: email.trim().toLocaleLowerCase('en-US'),
        password,
      });
      if (error) throw error;
      const [factorsResult, assuranceResult] = await Promise.all([
        client.auth.mfa.listFactors(),
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
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

    setIsBusy(true);
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      const { error: revokeError } = await client.auth.signOut({ scope: 'others' });
      setRecoveryReady(false);
      return {
        ok: true,
        message: revokeError
          ? 'Your password was updated. Spottr could not confirm that every other session was revoked; review your signed-in devices.'
          : 'Your password was updated and other sessions were revoked.',
      };
    } catch (error) {
      return toActionError(error, 'Your password could not be updated.');
    } finally {
      setIsBusy(false);
    }
  }, [recoveryReady]);

  const signOut = useCallback(async (): Promise<ActionResult> => {
    const client = supabase;
    if (!client) return { ok: true };

    setIsBusy(true);
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      setMfaEnrolled(false);
      setAssuranceLevel(null);
      setSecurityStatus('ready');
      return { ok: true };
    } catch (error) {
      return toActionError(error, 'Spottr could not sign out cleanly.');
    } finally {
      setIsBusy(false);
    }
  }, []);

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

    setIsBusy(true);
    try {
      const requestKey =
        deletionIdempotencyKey.current ??
        `spottr-delete:${account.id}:${Date.now()}`;
      deletionIdempotencyKey.current = requestKey;
      const { data, error } = await client.functions.invoke('delete-account', {
        method: 'DELETE',
        headers: {
          'Idempotency-Key': requestKey,
          'X-Spottr-Delete-Confirmation': 'DELETE',
        },
        body: { confirmation: 'DELETE' },
      });
      if (error) throw error;
      deletionIdempotencyKey.current = null;
      await client.auth.signOut({ scope: 'local' });
      const processing =
        data && typeof data === 'object' && data.status === 'processing';
      return {
        ok: true,
        message: processing
          ? 'Your deletion is already processing. This device has been signed out.'
          : 'Your Spottr account and private account data were deleted.',
      };
    } catch (error) {
      return toActionError(
        error,
        'Your account could not be deleted. Keep this session open, verify Security, and retry.'
      );
    } finally {
      setIsBusy(false);
    }
  }, [account, assuranceLevel, status]);

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
