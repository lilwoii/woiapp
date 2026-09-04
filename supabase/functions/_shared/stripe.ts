import { HttpError } from './http.ts';

export const STRIPE_API_VERSION = '2026-02-25.clover';

const STRIPE_API_ORIGIN = 'https://api.stripe.com';
const MAX_PROVIDER_RESPONSE_BYTES = 524_288;

function requiredSecret(name: string, minimumLength = 24): string {
  const value = Deno.env.get(name)?.trim() ?? '';
  if (value.length < minimumLength) throw new HttpError(503, 'PAYMENTS_NOT_CONFIGURED');
  return value;
}

export function paymentsEnabled(): boolean {
  return Deno.env.get('SPOTTR_PREPAID_PICKUP_ENABLED') === 'true';
}

export function requirePaymentsEnabled(): void {
  if (!paymentsEnabled()) throw new HttpError(503, 'PREPAID_PICKUP_DISABLED');
}

export function stripeSecretKey(): string {
  const key = requiredSecret('STRIPE_SECRET_KEY', 32);
  if (!/^sk_(?:test|live)_[A-Za-z0-9]{20,}$/.test(key)) {
    throw new HttpError(503, 'PAYMENTS_NOT_CONFIGURED');
  }
  return key;
}

export function stripeWebhookSecret(): string {
  const secret = requiredSecret('STRIPE_WEBHOOK_SECRET', 32);
  if (!/^whsec_[A-Za-z0-9]{20,}$/.test(secret)) {
    throw new HttpError(503, 'PAYMENTS_NOT_CONFIGURED');
  }
  return secret;
}

export function paymentAppOrigin(): string {
  const candidate = requiredSecret('SPOTTR_APP_ORIGIN', 12);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HttpError(503, 'PAYMENTS_NOT_CONFIGURED');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    parsed.pathname !== '/' || parsed.search || parsed.hash ||
    parsed.hostname === 'localhost' || /^[0-9.]+$/.test(parsed.hostname)
  ) throw new HttpError(503, 'PAYMENTS_NOT_CONFIGURED');
  return parsed.origin;
}

function safeProviderObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return value as Record<string, unknown>;
}

export async function stripeRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: URLSearchParams,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  if (!/^\/v1\/[A-Za-z0-9_./-]+$/.test(path) || path.includes('..')) {
    throw new HttpError(500, 'PAYMENT_PROVIDER_PATH_INVALID');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_ORIGIN}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${stripeSecretKey()}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: method === 'POST' ? body : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpError(503, 'PAYMENT_PROVIDER_UNAVAILABLE');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  const object = safeProviderObject(payload);
  if (!response.ok) {
    const error = safeProviderObject(object.error);
    const providerType = typeof error.type === 'string' ? error.type : '';
    const retryable = response.status === 429 || response.status >= 500 || providerType === 'api_error';
    throw new HttpError(retryable ? 503 : 422, retryable ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REJECTED');
  }
  return object;
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new HttpError(400, 'INVALID_WEBHOOK_SIGNATURE');
  return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!signatureHeader || signatureHeader.length > 2048) {
    throw new HttpError(400, 'INVALID_WEBHOOK_SIGNATURE');
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && /^\d{10}$/.test(value ?? '')) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value ?? '')) signatures.push(value!);
  }
  if (timestamp === null || signatures.length === 0 || Math.abs(nowSeconds - timestamp) > 300) {
    throw new HttpError(400, 'INVALID_WEBHOOK_SIGNATURE');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(stripeWebhookSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`),
  ));
  if (!signatures.some((signature) => constantTimeEqual(expected, fromHex(signature)))) {
    throw new HttpError(400, 'INVALID_WEBHOOK_SIGNATURE');
  }
}

export function stripeId(value: unknown, prefix: 'acct' | 'cs' | 'pi' | 're' | 'evt'): string {
  const suffix = prefix === 'cs' ? '[A-Za-z0-9_]' : '[A-Za-z0-9]';
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_${suffix}{12,128}$`).test(value)) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return value;
}

export function providerBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  return value;
}

export function providerString(value: unknown, maximum = 200): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return value;
}

export function providerInteger(value: unknown, maximum = 100_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new HttpError(502, 'PAYMENT_PROVIDER_INVALID');
  }
  return value as number;
}
