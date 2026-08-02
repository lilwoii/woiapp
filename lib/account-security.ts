import { toActionError } from '@/lib/errors';
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
  return { ok: true as const, client };
}

export async function getMfaOverview(): Promise<ActionResult<MfaOverview>> {
  const authenticated = await requireAuthenticatedClient();
  if (!authenticated.ok) return authenticated.result;

  try {
    const [factorsResult, assuranceResult] = await Promise.all([
      authenticated.client.auth.mfa.listFactors(),
      authenticated.client.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    if (factorsResult.error) throw factorsResult.error;
    if (assuranceResult.error) throw assuranceResult.error;
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
  const authenticated = await requireAuthenticatedClient();
  if (!authenticated.ok) return authenticated.result;

  try {
    const factorsResult = await authenticated.client.auth.mfa.listFactors();
    if (factorsResult.error) throw factorsResult.error;
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
      const { error } = await authenticated.client.auth.mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
    }

    const { data, error } = await authenticated.client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Spottr authenticator',
      issuer: 'Spottr',
    });
    if (error) throw error;
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
  }
}

export async function verifyTotp(
  factorId: string,
  code: string
): Promise<ActionResult<MfaOverview>> {
  const authenticated = await requireAuthenticatedClient();
  if (!authenticated.ok) return authenticated.result;
  if (!/^\d{6}$/.test(code.trim())) {
    return { ok: false, code: 'INVALID', reason: 'Enter the six-digit authenticator code.' };
  }

  try {
    const { error } = await authenticated.client.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    if (error) throw error;
    const overview = await getMfaOverview();
    if (!overview.ok) return overview;
    return {
      ok: true,
      data: overview.data,
      message: 'Authenticator protection is active.',
    };
  } catch (error) {
    return toActionError(error, 'That authenticator code could not be verified.');
  }
}

export async function removeTotp(factorId: string): Promise<ActionResult<MfaOverview>> {
  const authenticated = await requireAuthenticatedClient();
  if (!authenticated.ok) return authenticated.result;

  try {
    const { error } = await authenticated.client.auth.mfa.unenroll({ factorId });
    if (error) throw error;
    const overview = await getMfaOverview();
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
  }
}

export async function signOutAllSessions(): Promise<ActionResult> {
  const authenticated = await requireAuthenticatedClient();
  if (!authenticated.ok) return authenticated.result;

  try {
    const { error } = await authenticated.client.auth.signOut({ scope: 'global' });
    if (error) throw error;
    return { ok: true, message: 'All Spottr sessions were signed out.' };
  } catch (error) {
    return toActionError(error, 'Your other sessions could not be signed out.');
  }
}
