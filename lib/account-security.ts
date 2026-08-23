import { toActionError } from '@/lib/errors';
import { authMutationGate } from '@/lib/auth-session';
import { supabase } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';

export type AssuranceLevel = 'aal1' | 'aal2' | null;

export type MfaOverview = {
  currentLevel: AssuranceLevel;
  enrolled: boolean;
  factorId?: string;
};

export type TotpEnrollment = {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
};

async function requireAuthenticatedClient() {
  const client = supabase;
  if (!client) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        code: 'CONFIG_REQUIRED' as const,
        reason: 'Live account security is unavailable because Spottr services are not configured.',
      },
    };
  }

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        code: 'AUTH_REQUIRED' as const,
        reason: 'Sign in again to manage account security.',
      },
    };
  }
  return { ok: true as const, client, userId: data.user.id };
}

function authMutationConflict(): Extract<ActionResult, { ok: false }> {
  return {
    ok: false,
    code: 'CONFLICT',
    reason: 'Another account security action is still finishing. Wait a moment and try again.',
  };
}

async function sessionStillBelongsTo(
  client: NonNullable<typeof supabase>,
  expectedUserId: string
): Promise<boolean> {
  const { data, error } = await client.auth.getSession();
  return !error && data.session?.user?.id === expectedUserId;
}

function sessionChanged(): Extract<ActionResult, { ok: false }> {
  return {
    ok: false,
    code: 'AUTH_REQUIRED',
    reason: 'Your session changed. Sign in again before managing account security.',
  };
}

export async function getMfaOverview(
  expectedUserId?: string
): Promise<ActionResult<MfaOverview>> {
  const authenticated = await requireAuthenticatedClient();
  if (!authenticated.ok) return authenticated.result;
  if (expectedUserId && authenticated.userId !== expectedUserId) return sessionChanged();

  try {
    const [factorsResult, assuranceResult] = await Promise.all([
      authenticated.client.auth.mfa.listFactors(),
      authenticated.client.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    if (factorsResult.error) throw factorsResult.error;
    if (assuranceResult.error) throw assuranceResult.error;
    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    const factor = factorsResult.data.totp[0];
    return {
      ok: true,
      data: {
        currentLevel: assuranceResult.data.currentLevel,
        enrolled: Boolean(factor),
        factorId: factor?.id,
      },
    };
  } catch (error) {
    return toActionError(error, 'Account security status could not be loaded.');
  }
}

export async function beginTotpEnrollment(): Promise<ActionResult<TotpEnrollment>> {
  const authOperation = authMutationGate.begin('mfa-change');
  if (!authOperation) return authMutationConflict();

  try {
    const authenticated = await requireAuthenticatedClient();
    if (!authenticated.ok) return authenticated.result;
    const factorsResult = await authenticated.client.auth.mfa.listFactors();
    if (factorsResult.error) throw factorsResult.error;
    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    if (factorsResult.data.totp.length) {
      return {
        ok: false,
        code: 'CONFLICT',
        reason: 'An authenticator is already connected to this account.',
      };
    }

    // Remove abandoned, unverified TOTP enrollments before issuing a fresh secret.
    const abandonedFactors = factorsResult.data.all.filter(
      (factor) => factor.factor_type === 'totp' && factor.status === 'unverified'
    );
    for (const factor of abandonedFactors) {
      if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
        return sessionChanged();
      }
      const { error } = await authenticated.client.auth.mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
    }

    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    const { data, error } = await authenticated.client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Spottr authenticator',
      issuer: 'Spottr',
    });
    if (error) throw error;
    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    return {
      ok: true,
      data: {
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
        uri: data.totp.uri,
      },
    };
  } catch (error) {
    return toActionError(error, 'An authenticator could not be connected.');
  } finally {
    authMutationGate.finish(authOperation);
  }
}

export async function verifyTotp(
  factorId: string,
  code: string
): Promise<ActionResult<MfaOverview>> {
  if (!/^\d{6}$/.test(code.trim())) {
    return { ok: false, code: 'INVALID', reason: 'Enter the six-digit authenticator code.' };
  }

  const authOperation = authMutationGate.begin('mfa-change');
  if (!authOperation) return authMutationConflict();

  try {
    const authenticated = await requireAuthenticatedClient();
    if (!authenticated.ok) return authenticated.result;
    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    const { error } = await authenticated.client.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    if (error) throw error;
    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    const overview = await getMfaOverview(authenticated.userId);
    if (!overview.ok) return overview;
    return {
      ok: true,
      data: overview.data,
      message: 'Authenticator protection is active.',
    };
  } catch (error) {
    return toActionError(error, 'That authenticator code could not be verified.');
  } finally {
    authMutationGate.finish(authOperation);
  }
}

export async function removeTotp(factorId: string): Promise<ActionResult<MfaOverview>> {
  const authOperation = authMutationGate.begin('mfa-change');
  if (!authOperation) return authMutationConflict();

  try {
    const authenticated = await requireAuthenticatedClient();
    if (!authenticated.ok) return authenticated.result;
    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    const { error } = await authenticated.client.auth.mfa.unenroll({ factorId });
    if (error) throw error;
    if (!(await sessionStillBelongsTo(authenticated.client, authenticated.userId))) {
      return sessionChanged();
    }
    const overview = await getMfaOverview(authenticated.userId);
    if (!overview.ok) return overview;
    return {
      ok: true,
      data: overview.data,
      message: 'Authenticator protection was removed.',
    };
  } catch (error) {
    return toActionError(
      error,
      'Authenticator protection could not be removed. Verify a current code first.'
    );
  } finally {
    authMutationGate.finish(authOperation);
  }
}

// Session-wide revocation lives in AuthContext so auth and Realtime state reconcile together.
