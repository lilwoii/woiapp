import { Platform } from 'react-native';

import { createAccountBoundSupabaseClient, isSupabaseConfigured, supabase } from '@/lib/supabase';

type ErrorLike = { code?: string; message?: string; status?: number };
type Row = Record<string, unknown>;

export type PrepaidResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 'AUTH_REQUIRED' | 'CONFIG_REQUIRED' | 'CONFLICT' | 'INVALID' | 'NETWORK' | 'UNAVAILABLE' | 'UNKNOWN'; reason: string };

export type PrepaidCheckout = Readonly<{
  checkoutPublicId: string;
  checkoutUrl: string;
  expiresAt: string;
}>;

export type PrepaidCheckoutStatus = Readonly<{
  checkoutPublicId: string;
  state: 'prepared' | 'open' | 'completed' | 'expired' | 'failed' | 'refund_pending' | 'refunded';
  order: unknown | null;
  expiresAt: string;
  updatedAt: string;
}>;

export type MerchantPaymentStatus = Readonly<{
  businessId: string;
  onboardingStarted: boolean;
  country: string | null;
  defaultCurrency: string | null;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  acceptPrepaid: boolean;
  requirementsDueCount: number;
  updatedAt: string | null;
}>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let sequence = 0;

class PrepaidResponseError extends Error {}
class PrepaidInputError extends Error {}

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PrepaidResponseError('The secure checkout response was invalid.');
  return value as Row;
}

function string(row: Row, key: string, maximum: number): string {
  const value = row[key];
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PrepaidResponseError(`The checkout ${key} field was invalid.`);
  }
  return value;
}

function uuid(row: Row, key: string): string {
  const value = string(row, key, 36);
  if (!uuidPattern.test(value)) throw new PrepaidResponseError(`The checkout ${key} field was invalid.`);
  return value;
}

function iso(row: Row, key: string): string {
  const value = string(row, key, 40);
  if (!Number.isFinite(Date.parse(value))) throw new PrepaidResponseError(`The checkout ${key} field was invalid.`);
  return value;
}

function boolean(row: Row, key: string): boolean {
  if (typeof row[key] !== 'boolean') throw new PrepaidResponseError(`The payment ${key} field was invalid.`);
  return row[key] as boolean;
}

function integer(row: Row, key: string, maximum = 1000): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new PrepaidResponseError(`The payment ${key} field was invalid.`);
  }
  return value as number;
}

export function mapPrepaidCheckout(value: unknown): PrepaidCheckout {
  const row = object(value);
  const checkoutUrl = string(row, 'checkoutUrl', 2048);
  let parsed: URL;
  try { parsed = new URL(checkoutUrl); } catch { throw new PrepaidResponseError('The checkout address was invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'checkout.stripe.com' || parsed.username || parsed.password) {
    throw new PrepaidResponseError('The checkout address was invalid.');
  }
  const expiresAt = iso(row, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.now()) throw new PrepaidResponseError('The checkout session already expired.');
  return Object.freeze({ checkoutPublicId: uuid(row, 'checkoutPublicId'), checkoutUrl: parsed.toString(), expiresAt });
}

export function mapPrepaidCheckoutStatus(value: unknown): PrepaidCheckoutStatus {
  const row = object(value);
  const allowed = new Set(['prepared', 'open', 'completed', 'expired', 'failed', 'refund_pending', 'refunded']);
  const state = string(row, 'state', 24);
  if (!allowed.has(state) || (state === 'completed' && (!row.order || typeof row.order !== 'object'))) {
    throw new PrepaidResponseError('The checkout status was invalid.');
  }
  return Object.freeze({
    checkoutPublicId: uuid(row, 'checkout_public_id'),
    state: state as PrepaidCheckoutStatus['state'],
    order: row.order ?? null,
    expiresAt: iso(row, 'expires_at'),
    updatedAt: iso(row, 'updated_at'),
  });
}

export function mapMerchantPaymentStatus(value: unknown): MerchantPaymentStatus {
  const row = object(value);
  const country = row.country === null ? null : string(row, 'country', 2);
  const defaultCurrency = row.default_currency === null ? null : string(row, 'default_currency', 3);
  if ((country && !/^[A-Z]{2}$/.test(country)) || (defaultCurrency && !/^[A-Z]{3}$/.test(defaultCurrency))) {
    throw new PrepaidResponseError('The payment account region was invalid.');
  }
  const detailsSubmitted = boolean(row, 'details_submitted');
  const chargesEnabled = boolean(row, 'charges_enabled');
  const payoutsEnabled = boolean(row, 'payouts_enabled');
  const acceptPrepaid = boolean(row, 'accept_prepaid');
  if (acceptPrepaid && (!detailsSubmitted || !chargesEnabled || !payoutsEnabled)) {
    throw new PrepaidResponseError('The payment account readiness was inconsistent.');
  }
  return Object.freeze({
    businessId: uuid(row, 'business_id'),
    onboardingStarted: boolean(row, 'onboarding_started'),
    country,
    defaultCurrency,
    detailsSubmitted,
    chargesEnabled,
    payoutsEnabled,
    acceptPrepaid,
    requirementsDueCount: integer(row, 'requirements_due_count'),
    updatedAt: row.updated_at === null ? null : iso(row, 'updated_at'),
  });
}

export function createPrepaidCheckoutIdempotencyKey() {
  const cryptoApi = globalThis.crypto;
  let nonce: string | undefined = cryptoApi?.randomUUID?.();
  if (!nonce && cryptoApi?.getRandomValues) {
    nonce = Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  nonce ??= `${Date.now().toString(36)}-${sequence.toString(36)}`;
  return `spottr:prepaid:checkout:${nonce}`;
}

async function client(expectedUserId: string) {
  if (!isSupabaseConfigured || !supabase) throw Object.assign(new Error('Live services are not configured.'), { code: 'CONFIG_REQUIRED' });
  if (!uuidPattern.test(expectedUserId)) throw new PrepaidInputError('The active account is invalid.');
  const bound = await createAccountBoundSupabaseClient(expectedUserId);
  if (!bound) throw Object.assign(new Error('The active account changed.'), { status: 401 });
  return bound;
}

function failure<T>(error: unknown, fallback: string): PrepaidResult<T> {
  if (error instanceof PrepaidInputError || error instanceof PrepaidResponseError) return { ok: false, code: 'INVALID', reason: error.message };
  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.code === 'CONFIG_REQUIRED') return { ok: false, code: 'CONFIG_REQUIRED', reason: 'Connect Spottr live services before using secure checkout.' };
  if (candidate?.status === 401 || message.includes('jwt') || message.includes('session')) return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in again before using secure checkout.' };
  if (candidate?.status === 409 || message.includes('conflict')) return { ok: false, code: 'CONFLICT', reason: 'This checkout changed. Reload it before continuing.' };
  if (candidate?.status === 0 || message.includes('network') || message.includes('fetch')) return { ok: false, code: 'NETWORK', reason: 'Secure checkout could not be reached. Check your connection and try again.' };
  if (candidate?.status === 400 || candidate?.status === 422 || message.includes('invalid')) return { ok: false, code: 'INVALID', reason: 'Reload the current menu and pickup time before checking out.' };
  if (candidate?.status === 503 || message.includes('disabled') || message.includes('unavailable') || message.includes('not ready')) return { ok: false, code: 'UNAVAILABLE', reason: 'Secure card and wallet checkout is not available for this business right now.' };
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

export async function createPrepaidPickupCheckout(input: {
  businessId: string;
  locationId: string;
  requestedPickupAt: string;
  lines: readonly { menuItemId: string; quantity: number }[];
  customerNote: string;
}, expectedUserId: string, requestIdempotencyKey = createPrepaidCheckoutIdempotencyKey()): Promise<PrepaidResult<PrepaidCheckout>> {
  try {
    if (!uuidPattern.test(input.businessId) || !uuidPattern.test(input.locationId) || input.lines.length < 1 || input.lines.length > 20) {
      throw new PrepaidInputError('Choose a valid business, location, and order.');
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(requestIdempotencyKey)) {
      throw new PrepaidInputError('The secure checkout retry key was invalid.');
    }
    const bound = await client(expectedUserId);
    const { data, error } = await bound.functions.invoke('payment-checkout', {
      body: {
        action: 'create', businessId: input.businessId.toLowerCase(), locationId: input.locationId.toLowerCase(),
        requestedPickupAt: input.requestedPickupAt,
        lines: input.lines.map((line) => ({ menuItemId: line.menuItemId.toLowerCase(), quantity: line.quantity })),
        customerNote: input.customerNote.trim() || null,
        clientPlatform: Platform.OS === 'web' ? 'web' : 'mobile',
      },
      headers: { 'idempotency-key': requestIdempotencyKey },
    });
    if (error) throw error;
    return { ok: true, data: mapPrepaidCheckout(data) };
  } catch (error) { return failure(error, 'Secure checkout could not be started.'); }
}

export async function loadPrepaidCheckoutStatus(checkoutPublicId: string, expectedUserId: string): Promise<PrepaidResult<PrepaidCheckoutStatus>> {
  try {
    if (!uuidPattern.test(checkoutPublicId)) throw new PrepaidInputError('The checkout link is invalid.');
    const bound = await client(expectedUserId);
    const { data, error } = await bound.functions.invoke('payment-checkout', {
      body: { action: 'status', checkoutPublicId: checkoutPublicId.toLowerCase() },
    });
    if (error) throw error;
    return { ok: true, data: mapPrepaidCheckoutStatus(data) };
  } catch (error) { return failure(error, 'Checkout status could not be confirmed.'); }
}

export async function loadMerchantPaymentStatus(businessId: string, expectedUserId: string): Promise<PrepaidResult<MerchantPaymentStatus>> {
  return paymentConnect({ action: 'status', businessId }, expectedUserId);
}

export async function startMerchantPaymentOnboarding(businessId: string, country: string, expectedUserId: string): Promise<PrepaidResult<{ onboardingUrl: string }>> {
  const result = await paymentConnectRaw({ action: 'start', businessId, country }, expectedUserId);
  if (!result.ok) return result;
  try {
    const row = object(result.data);
    const onboardingUrl = string(row, 'onboardingUrl', 2048);
    const parsed = new URL(onboardingUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'connect.stripe.com') throw new PrepaidResponseError('The onboarding address was invalid.');
    return { ok: true, data: { onboardingUrl: parsed.toString() } };
  } catch (error) { return failure(error, 'Secure onboarding could not be started.'); }
}

export async function setMerchantPrepaidAcceptance(businessId: string, accepted: boolean, expectedUserId: string): Promise<PrepaidResult<MerchantPaymentStatus>> {
  return paymentConnect({ action: 'set_acceptance', businessId, accepted }, expectedUserId);
}

async function paymentConnect(command: Row, expectedUserId: string): Promise<PrepaidResult<MerchantPaymentStatus>> {
  const result = await paymentConnectRaw(command, expectedUserId);
  if (!result.ok) return result;
  try { return { ok: true, data: mapMerchantPaymentStatus(result.data) }; }
  catch (error) { return failure(error, 'Payment account status could not be confirmed.'); }
}

async function paymentConnectRaw(command: Row, expectedUserId: string): Promise<PrepaidResult<unknown>> {
  try {
    if (typeof command.businessId !== 'string' || !uuidPattern.test(command.businessId)) throw new PrepaidInputError('The business link is invalid.');
    const bound = await client(expectedUserId);
    const body = { ...command, businessId: command.businessId.toLowerCase() };
    const { data, error } = await bound.functions.invoke('payment-connect', { body });
    if (error) throw error;
    return { ok: true, data };
  } catch (error) { return failure(error, 'Payment account request could not be completed.'); }
}
