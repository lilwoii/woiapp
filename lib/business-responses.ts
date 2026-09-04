import { checkProfessionalText } from '@/lib/moderation';
import {
  createAccountBoundSupabaseClient,
  isSupabaseConfigured,
  supabase,
} from '@/lib/supabase';

export const BUSINESS_RESPONSE_MAX_LENGTH = 1000;

export type BusinessResponseModerationState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'removed';

export type BusinessResponseRecord = {
  reviewId: string;
  businessId: string;
  body: string;
  moderationState: BusinessResponseModerationState;
  createdAt: string;
  updatedAt: string;
};

export type BusinessResponseAttempt = {
  reviewId: string;
  body: string;
  idempotencyKey: string;
};

export type BusinessResponseResult<T> =
  | { ok: true; data: T; message?: string }
  | {
      ok: false;
      code:
        | 'AUTH_REQUIRED'
        | 'CONFIG_REQUIRED'
        | 'CONFLICT'
        | 'FORBIDDEN'
        | 'INVALID'
        | 'NETWORK'
        | 'RATE_LIMITED'
        | 'UNKNOWN';
      reason: string;
    };

type ErrorLike = {
  code?: string;
  message?: string;
  status?: number;
};

type UnknownRow = Record<string, unknown>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const moderationStates = new Set<BusinessResponseModerationState>([
  'pending',
  'approved',
  'rejected',
  'removed',
]);
let idempotencySequence = 0;

class BusinessResponseValidationError extends Error {}

function assertUuid(value: string, label: string) {
  if (!uuidPattern.test(value)) {
    throw new BusinessResponseValidationError(`${label} is invalid.`);
  }
}

function isNetworkError(error: unknown) {
  const message = (error as ErrorLike | null)?.message?.toLocaleLowerCase('en-US') ?? '';
  return (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('offline') ||
    message.includes('connection')
  );
}

function toFailure<T>(
  error: unknown,
  fallback: string
): BusinessResponseResult<T> {
  if (error instanceof BusinessResponseValidationError) {
    return { ok: false, code: 'INVALID', reason: error.message };
  }

  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.code === 'CONFIG_REQUIRED') {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Connect Spottr live services before responding to reviews.',
    };
  }
  if (
    candidate?.status === 401 ||
    message.includes('jwt') ||
    message.includes('not authenticated')
  ) {
    return {
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: 'Sign in again before responding to this review.',
    };
  }
  if (
    message.includes('aal2') ||
    message.includes('authenticator verification required')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'Verify a current authenticator code in Security, then try again.',
    };
  }
  if (
    candidate?.status === 403 ||
    candidate?.code === '42501' ||
    message.includes('owner or manager') ||
    message.includes('eligible owner')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'An active owner or manager role is required to respond.',
    };
  }
  if (
    candidate?.status === 429 ||
    message.includes('rate_limited') ||
    message.includes('rate limit')
  ) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      reason: 'Too many response changes were requested. Wait a moment and try again.',
    };
  }
  if (
    message.includes('response_not_editable') ||
    message.includes('idempotency_response_gone')
  ) {
    return {
      ok: false,
      code: 'CONFLICT',
      reason: 'This response changed during review. Refresh Studio before trying again.',
    };
  }
  if (
    candidate?.code === '22023' ||
    candidate?.code === '23514' ||
    message.includes('invalid business response') ||
    message.includes('content_policy_violation') ||
    message.includes('idempotency_key_reused')
  ) {
    return {
      ok: false,
      code: 'INVALID',
      reason: message.includes('idempotency')
        ? 'The response changed during submission. Edit it once, then submit again.'
        : 'Use professional, customer-safe wording and try again.',
    };
  }
  if (candidate?.status === 0 || isNetworkError(error)) {
    return {
      ok: false,
      code: 'NETWORK',
      reason:
        'The result could not be confirmed. Check your connection, then retry without changing the response.',
    };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

function row(value: unknown): UnknownRow {
  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === 'object' ? (first as UnknownRow) : {};
  }
  return value && typeof value === 'object' ? (value as UnknownRow) : {};
}

export function mapBusinessResponseRecord(value: unknown): BusinessResponseRecord {
  const source = row(value);
  const reviewId = typeof source.review_id === 'string' ? source.review_id : '';
  const businessId = typeof source.business_id === 'string' ? source.business_id : '';
  const body = typeof source.body === 'string' ? source.body : '';
  const moderationState =
    typeof source.moderation_state === 'string'
      ? source.moderation_state
      : typeof source.moderation === 'string'
        ? source.moderation
        : '';
  const createdAt = typeof source.created_at === 'string' ? source.created_at : '';
  const updatedAt = typeof source.updated_at === 'string' ? source.updated_at : '';

  if (
    !uuidPattern.test(reviewId) ||
    !uuidPattern.test(businessId) ||
    !body ||
    !moderationStates.has(moderationState as BusinessResponseModerationState) ||
    !createdAt ||
    !updatedAt
  ) {
    throw new Error('Business response service returned an invalid record.');
  }

  return {
    reviewId,
    businessId,
    body,
    moderationState: moderationState as BusinessResponseModerationState,
    createdAt,
    updatedAt,
  };
}

export function normalizeBusinessResponseBody(value: string) {
  const result = checkProfessionalText(value, BUSINESS_RESPONSE_MAX_LENGTH);
  if (!result.ok) {
    throw new BusinessResponseValidationError(result.reason);
  }
  return result.clean;
}

export function createBusinessResponseIdempotencyKey() {
  const cryptoApi = globalThis.crypto;
  let nonce: string | undefined = cryptoApi?.randomUUID?.();
  if (!nonce && cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  idempotencySequence = (idempotencySequence + 1) % Number.MAX_SAFE_INTEGER;
  nonce ??= `${Date.now().toString(36)}-${idempotencySequence.toString(36)}-${Math.round(
    globalThis.performance?.now?.() ?? 0
  ).toString(36)}`;
  return `spottr-response:${nonce}`;
}

export function prepareBusinessResponseAttempt(
  previous: BusinessResponseAttempt | undefined,
  reviewId: string,
  body: string
): BusinessResponseAttempt {
  assertUuid(reviewId, 'This review link');
  const normalizedBody = normalizeBusinessResponseBody(body);
  if (
    previous?.reviewId === reviewId &&
    previous.body === normalizedBody &&
    previous.idempotencyKey.length >= 16
  ) {
    return previous;
  }
  return {
    reviewId,
    body: normalizedBody,
    idempotencyKey: createBusinessResponseIdempotencyKey(),
  };
}

async function authorizedClient(businessId: string, expectedUserId: string) {
  assertUuid(businessId, 'This business link');
  assertUuid(expectedUserId, 'The active account');
  if (!isSupabaseConfigured || !supabase) {
    throw Object.assign(new Error('Live services are not configured.'), {
      code: 'CONFIG_REQUIRED',
    });
  }

  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) {
    throw Object.assign(new Error('The active account changed.'), {
      status: 401,
    });
  }

  const { data: allowed, error: accessError } = await client.rpc('is_business_member', {
    target_business_id: businessId,
    allowed_roles: ['owner', 'manager'],
  });
  if (accessError) throw accessError;
  if (!allowed) {
    throw Object.assign(new Error('Eligible owner or manager role required'), {
      code: '42501',
      status: 403,
    });
  }
  return client;
}

export async function loadBusinessResponseQueue(
  businessId: string,
  expectedUserId: string
): Promise<BusinessResponseResult<BusinessResponseRecord[]>> {
  try {
    const client = await authorizedClient(businessId, expectedUserId);
    const { data, error } = await client
      .from('business_responses')
      .select('review_id,business_id,body,moderation,created_at,updated_at')
      .eq('business_id', businessId);
    if (error) throw error;
    const records = (Array.isArray(data) ? data : []).map(mapBusinessResponseRecord);
    return { ok: true, data: records };
  } catch (error) {
    return toFailure(error, 'Existing business responses could not be loaded.');
  }
}

export async function submitBusinessResponse(
  businessId: string,
  attempt: BusinessResponseAttempt,
  expectedUserId: string
): Promise<BusinessResponseResult<BusinessResponseRecord>> {
  try {
    assertUuid(attempt.reviewId, 'This review link');
    const body = normalizeBusinessResponseBody(attempt.body);
    if (
      attempt.idempotencyKey.length < 16 ||
      attempt.idempotencyKey.length > 128 ||
      /\s/.test(attempt.idempotencyKey)
    ) {
      throw new BusinessResponseValidationError('Create a new response submission and try again.');
    }

    const client = await authorizedClient(businessId, expectedUserId);
    const { data, error } = await client.rpc('submit_business_response', {
      target_review_id: attempt.reviewId,
      response_body: body,
      idempotency_key: attempt.idempotencyKey,
    });
    if (error) throw error;
    const response = mapBusinessResponseRecord(data);
    if (response.businessId !== businessId || response.reviewId !== attempt.reviewId) {
      throw new Error('Business response service returned a mismatched record.');
    }
    return {
      ok: true,
      data: response,
      message:
        response.moderationState === 'approved'
          ? 'Your response is public.'
          : 'Your response is queued for a safety review.',
    };
  } catch (error) {
    return toFailure(error, 'The response could not be submitted.');
  }
}
