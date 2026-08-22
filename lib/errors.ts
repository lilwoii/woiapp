import { ActionResult } from '@/types/marketplace';

type ErrorLike = {
  code?: string;
  message?: string;
  status?: number;
  context?: {
    status?: number;
  };
};

const genericMessage = 'Something went wrong. Please try again.';

export function toActionError(error: unknown, fallback = genericMessage): ActionResult<never> {
  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  const status = candidate?.status ?? candidate?.context?.status;

  if (
    status === 0 ||
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('offline')
  ) {
    return {
      ok: false,
      code: 'NETWORK',
      reason: 'Spottr could not connect. Check your connection and try again.',
    };
  }

  if (
    status === 409 ||
    candidate?.code === '23505' ||
    message.includes('already registered') ||
    message.includes('already exists') ||
    message.includes('duplicate')
  ) {
    return {
      ok: false,
      code: 'CONFLICT',
      reason: 'That information is already in use.',
    };
  }

  if (
    status === 401 ||
    candidate?.code === 'invalid_credentials' ||
    message.includes('invalid login credentials')
  ) {
    return {
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: 'The email or password is incorrect.',
    };
  }

  if (status === 429 || message.includes('rate limit')) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      reason: 'Too many attempts. Wait a moment, then try again.',
    };
  }

  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

export function requireConfigured(configured: boolean): ActionResult<never> | null {
  if (configured) return null;
  return {
    ok: false,
    code: 'CONFIG_REQUIRED',
    reason: 'Live Spottr services are not configured for this build.',
  };
}
