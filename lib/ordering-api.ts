import { featureFlags } from '@/lib/features';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';
import type {
  ShadowCancellationAttempt,
  ShadowOrderMenuItem,
  ShadowOrderOption,
  ShadowOrderOptionGroup,
  ShadowOrderQuote,
  ShadowOrderReceipt,
  ShadowOrderableMenu,
  ShadowPickupWindow,
  ShadowPlacementAttempt,
  ShadowQuoteAttempt,
  ShadowQuotedLine,
  ShadowQuotedOption,
  ShadowQuoteIntent,
} from '@/types/ordering';

type UnknownRow = Record<string, unknown>;
type ErrorLike = { code?: string; message?: string; status?: number };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const currencyPattern = /^[A-Z]{3}$/;
let idempotencySequence = 0;

class OrderingResponseError extends Error {}
class OrderingInputError extends Error {}

function objectValue(value: unknown): UnknownRow {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new OrderingResponseError('Expected one ordering record.');
    return objectValue(value[0]);
  }
  if (!value || typeof value !== 'object') {
    throw new OrderingResponseError('Ordering service returned an invalid record.');
  }
  return value as UnknownRow;
}

function arrayValue(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new OrderingResponseError('Ordering service returned an invalid collection.');
  }
  return value;
}

function stringValue(row: UnknownRow, key: string, maximum = 500): string {
  const value = row[key];
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OrderingResponseError(`Ordering response contains an invalid ${key}.`);
  }
  return value;
}

function optionalStringValue(row: UnknownRow, key: string, maximum = 500): string | null {
  if (row[key] === null || row[key] === undefined || row[key] === '') return null;
  return stringValue(row, key, maximum);
}

function uuidValue(row: UnknownRow, key: string): string {
  const value = stringValue(row, key, 36);
  if (!uuidPattern.test(value)) {
    throw new OrderingResponseError(`Ordering response contains an invalid ${key}.`);
  }
  return value;
}

function optionalUuidValue(row: UnknownRow, key: string): string | null {
  if (row[key] === null || row[key] === undefined || row[key] === '') return null;
  return uuidValue(row, key);
}

function integerValue(
  row: UnknownRow,
  key: string,
  minimum: number,
  maximum: number
): number {
  const raw = row[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new OrderingResponseError(`Ordering response contains an invalid ${key}.`);
  }
  return value;
}

function optionalIntegerValue(
  row: UnknownRow,
  key: string,
  minimum: number,
  maximum: number
): number | null {
  if (row[key] === null || row[key] === undefined) return null;
  return integerValue(row, key, minimum, maximum);
}

function isoDateValue(row: UnknownRow, key: string): string {
  const value = stringValue(row, key, 64);
  if (!Number.isFinite(Date.parse(value))) {
    throw new OrderingResponseError(`Ordering response contains an invalid ${key}.`);
  }
  return value;
}

function currencyValue(row: UnknownRow): string {
  const currency = stringValue(row, 'currency', 3);
  if (!currencyPattern.test(currency)) {
    throw new OrderingResponseError('Ordering response contains an invalid currency.');
  }
  return currency;
}

function acceptanceModeValue(row: UnknownRow): 'automatic' | 'manual' {
  const value = stringValue(row, 'acceptance_mode', 9);
  if (value !== 'automatic' && value !== 'manual') {
    throw new OrderingResponseError('Ordering response contains an invalid acceptance mode.');
  }
  return value;
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new OrderingResponseError(`Ordering response contains duplicate ${label}.`);
  }
}

function mapOption(value: unknown): ShadowOrderOption {
  const row = objectValue(value);
  return Object.freeze({
    optionVersionId: uuidValue(row, 'option_version_id'),
    name: stringValue(row, 'name', 80),
    priceDeltaMinor: integerValue(row, 'price_delta_minor', 0, 100_000_000),
    sortOrder: integerValue(row, 'sort_order', -10_000, 10_000),
  });
}

function mapOptionGroup(value: unknown): ShadowOrderOptionGroup | null {
  const row = objectValue(value);
  const options = arrayValue(row.options, 100).map(mapOption);
  assertUnique(options.map((option) => option.optionVersionId), 'menu options');
  const minimumSelections = integerValue(row, 'minimum_selections', 0, 50);
  const maximumSelections = integerValue(row, 'maximum_selections', 1, 50);
  if (minimumSelections > maximumSelections || minimumSelections > options.length) {
    throw new OrderingResponseError('Ordering response contains invalid option requirements.');
  }
  if (!options.length) return null;
  return Object.freeze({
    optionGroupId: uuidValue(row, 'option_group_id'),
    name: stringValue(row, 'name', 80),
    minimumSelections,
    maximumSelections: Math.min(maximumSelections, options.length),
    sortOrder: integerValue(row, 'sort_order', -10_000, 10_000),
    options: Object.freeze(options),
  });
}

function mapMenuItem(value: unknown): ShadowOrderMenuItem {
  const row = objectValue(value);
  const optionGroups = arrayValue(row.option_groups, 50)
    .map(mapOptionGroup)
    .filter((group): group is ShadowOrderOptionGroup => group !== null);
  assertUnique(optionGroups.map((group) => group.optionGroupId), 'option groups');
  return Object.freeze({
    itemVersionId: uuidValue(row, 'item_version_id'),
    stableItemId: uuidValue(row, 'stable_item_id'),
    name: stringValue(row, 'name', 120),
    description:
      typeof row.description === 'string' && row.description.length <= 1_000
        ? row.description
        : '',
    unitPriceMinor: integerValue(row, 'unit_price_minor', 0, 100_000_000),
    maximumQuantity: integerValue(row, 'maximum_quantity', 1, 100),
    allergenNote: optionalStringValue(row, 'allergen_note', 500),
    sortOrder: integerValue(row, 'sort_order', -10_000, 10_000),
    optionGroups: Object.freeze(optionGroups),
  });
}

function mapPickupWindow(value: unknown): ShadowPickupWindow {
  const row = objectValue(value);
  const startsAt = isoDateValue(row, 'starts_at');
  const endsAt = isoDateValue(row, 'ends_at');
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new OrderingResponseError('Ordering response contains an invalid pickup window.');
  }
  return Object.freeze({
    capacitySlotId: uuidValue(row, 'capacity_slot_id'),
    locationId: uuidValue(row, 'location_id'),
    mobileStopId: optionalUuidValue(row, 'mobile_stop_id'),
    startsAt,
    endsAt,
    remainingCapacity: integerValue(row, 'remaining_capacity', 1, 1_000),
  });
}

export function mapShadowOrderableMenu(value: unknown): ShadowOrderableMenu {
  const row = objectValue(value);
  if (row.public_ordering_enabled !== false || row.payment_enabled !== false) {
    throw new OrderingResponseError('Ordering menu is not bound to the zero-money staff pilot.');
  }
  const items = arrayValue(row.items, 500).map(mapMenuItem);
  const pickupWindows = arrayValue(row.pickup_windows, 100).map(mapPickupWindow);
  const acceptanceMode = acceptanceModeValue(row);
  if (acceptanceMode !== 'manual') {
    throw new OrderingResponseError('Ordering menu requires manual merchant acceptance.');
  }
  assertUnique(items.map((item) => item.itemVersionId), 'menu items');
  assertUnique(pickupWindows.map((window) => window.capacitySlotId), 'pickup windows');
  return Object.freeze({
    businessId: uuidValue(row, 'business_id'),
    catalogVersionId: uuidValue(row, 'catalog_version_id'),
    catalogVersion: integerValue(row, 'catalog_version', 1, 2_147_483_647),
    currency: currencyValue(row),
    acceptanceMode,
    acceptanceTimeoutSeconds: integerValue(row, 'acceptance_timeout_seconds', 60, 1_800),
    termsVersion: stringValue(row, 'terms_version', 80),
    refundPolicyVersion: stringValue(row, 'refund_policy_version', 80),
    quoteTtlSeconds: integerValue(row, 'quote_ttl_seconds', 30, 900),
    items: Object.freeze(items),
    pickupWindows: Object.freeze(pickupWindows),
  });
}

function mapQuotedOption(value: unknown): ShadowQuotedOption {
  const row = objectValue(value);
  const name = stringValue(row, 'name', 80);
  if (stringValue(row, 'option_name', 80) !== name) {
    throw new OrderingResponseError('Ordering option aliases are inconsistent.');
  }
  return Object.freeze({
    optionVersionId: uuidValue(row, 'option_version_id'),
    name,
    priceDeltaMinor: integerValue(row, 'price_delta_minor', 0, 100_000_000),
  });
}

function mapQuotedLine(value: unknown): ShadowQuotedLine {
  const row = objectValue(value);
  const options = arrayValue(row.options, 100).map(mapQuotedOption);
  assertUnique(options.map((option) => option.optionVersionId), 'quoted options');
  const quantity = integerValue(row, 'quantity', 1, 100);
  const baseUnitPriceMinor = integerValue(row, 'base_unit_price_minor', 0, 100_000_000);
  const unitPriceMinor = integerValue(row, 'unit_price_minor', 0, 100_000_000);
  const optionUnitTotalMinor = integerValue(row, 'option_unit_total_minor', 0, 100_000_000);
  const unitTotalMinor = integerValue(row, 'unit_total_minor', 0, 200_000_000);
  const lineSubtotalMinor = integerValue(row, 'line_subtotal_minor', 0, 1_000_000_000);
  const computedOptionTotal = options.reduce((total, option) => total + option.priceDeltaMinor, 0);
  if (
    unitPriceMinor !== baseUnitPriceMinor ||
    computedOptionTotal !== optionUnitTotalMinor ||
    baseUnitPriceMinor + optionUnitTotalMinor !== unitTotalMinor ||
    unitTotalMinor * quantity !== lineSubtotalMinor
  ) {
    throw new OrderingResponseError('Ordering quote totals are inconsistent.');
  }
  return Object.freeze({
    itemVersionId: uuidValue(row, 'item_version_id'),
    name: stringValue(row, 'name', 120),
    quantity,
    baseUnitPriceMinor,
    optionUnitTotalMinor,
    unitTotalMinor,
    lineSubtotalMinor,
    allergenNote: optionalStringValue(row, 'allergen_note', 500),
    options: Object.freeze(options),
  });
}

export function mapShadowOrderQuote(value: unknown): ShadowOrderQuote {
  const row = objectValue(value);
  const lines = arrayValue(row.lines, 100).map(mapQuotedLine);
  if (!lines.length) throw new OrderingResponseError('Ordering quote has no items.');
  assertUnique(lines.map((line) => line.itemVersionId), 'quoted items');
  const pickupStartsAt = isoDateValue(row, 'pickup_starts_at');
  const pickupEndsAt = isoDateValue(row, 'pickup_ends_at');
  const expiresAt = isoDateValue(row, 'expires_at');
  const itemSubtotalMinor = integerValue(row, 'item_subtotal_minor', 0, 1_000_000_000);
  const shadowDiscountMinor = integerValue(row, 'shadow_discount_minor', 0, 1_000_000_000);
  const totalMinor = integerValue(row, 'total_minor', 0, 0);
  const acceptanceMode = acceptanceModeValue(row);
  const computedSubtotal = lines.reduce((total, line) => total + line.lineSubtotalMinor, 0);
  if (
    Date.parse(pickupEndsAt) <= Date.parse(pickupStartsAt) ||
    Date.parse(expiresAt) >= Date.parse(pickupStartsAt) ||
    computedSubtotal !== itemSubtotalMinor ||
    shadowDiscountMinor !== itemSubtotalMinor ||
    row.is_shadow !== true ||
    row.payment_state !== 'not_required' ||
    integerValue(row, 'tax_minor', 0, 0) !== 0 ||
    integerValue(row, 'tip_minor', 0, 0) !== 0 ||
    integerValue(row, 'fee_minor', 0, 0) !== 0 ||
    totalMinor !== 0 ||
    acceptanceMode !== 'manual'
  ) {
    throw new OrderingResponseError('Ordering quote violates the zero-money pilot contract.');
  }
  return Object.freeze({
    quotePublicId: uuidValue(row, 'quote_public_id'),
    quoteVersion: integerValue(row, 'quote_version', 1, 2_147_483_647),
    businessId: uuidValue(row, 'business_id'),
    locationId: uuidValue(row, 'location_id'),
    mobileStopId: optionalUuidValue(row, 'mobile_stop_id'),
    capacitySlotId: uuidValue(row, 'capacity_slot_id'),
    catalogVersionId: uuidValue(row, 'catalog_version_id'),
    currency: currencyValue(row),
    itemSubtotalMinor,
    shadowDiscountMinor,
    totalMinor,
    pickupStartsAt,
    pickupEndsAt,
    expiresAt,
    termsVersion: stringValue(row, 'terms_version', 80),
    refundPolicyVersion: stringValue(row, 'refund_policy_version', 80),
    acceptanceMode,
    isShadow: true,
    lines: Object.freeze(lines),
  });
}

export function mapShadowOrderReceipt(value: unknown): ShadowOrderReceipt {
  const row = objectValue(value);
  const lines = arrayValue(row.lines, 100).map(mapQuotedLine);
  if (!lines.length) throw new OrderingResponseError('Ordering receipt has no items.');
  assertUnique(lines.map((line) => line.itemVersionId), 'receipt items');
  const fulfillmentState = stringValue(row, 'fulfillment_state', 24);
  const itemSubtotalMinor = integerValue(row, 'item_subtotal_minor', 0, 1_000_000_000);
  const shadowDiscountMinor = integerValue(row, 'shadow_discount_minor', 0, 1_000_000_000);
  const acceptanceMode = acceptanceModeValue(row);
  const computedSubtotal = lines.reduce((total, line) => total + line.lineSubtotalMinor, 0);
  if (
    ![
      'accepted',
      'cancelled',
      'completed',
      'pending_acceptance',
      'preparing',
      'ready',
      'rejected',
    ].includes(fulfillmentState) ||
    row.payment_state !== 'not_required' ||
    row.is_shadow !== true ||
    integerValue(row, 'tax_minor', 0, 0) !== 0 ||
    integerValue(row, 'tip_minor', 0, 0) !== 0 ||
    integerValue(row, 'fee_minor', 0, 0) !== 0 ||
    integerValue(row, 'total_minor', 0, 0) !== 0 ||
    computedSubtotal !== itemSubtotalMinor ||
    shadowDiscountMinor !== itemSubtotalMinor ||
    acceptanceMode !== 'manual'
  ) {
    throw new OrderingResponseError('Ordering receipt violates the zero-money pilot contract.');
  }
  const pickupStartsAt = isoDateValue(row, 'pickup_starts_at');
  const pickupEndsAt = isoDateValue(row, 'pickup_ends_at');
  const acceptanceExpiresAt = isoDateValue(row, 'acceptance_expires_at');
  if (
    Date.parse(pickupEndsAt) <= Date.parse(pickupStartsAt) ||
    Date.parse(acceptanceExpiresAt) > Date.parse(pickupStartsAt)
  ) {
    throw new OrderingResponseError('Ordering receipt contains an invalid pickup window.');
  }
  return Object.freeze({
    quotePublicId: optionalUuidValue(row, 'quote_public_id'),
    quoteVersion: optionalIntegerValue(row, 'quote_version', 1, 2_147_483_647),
    orderPublicId: uuidValue(row, 'order_public_id'),
    version: integerValue(row, 'version', 1, 2_147_483_647),
    fulfillmentState: fulfillmentState as ShadowOrderReceipt['fulfillmentState'],
    paymentState: 'not_required',
    isShadow: true,
    businessId: uuidValue(row, 'business_id'),
    locationId: uuidValue(row, 'location_id'),
    mobileStopId: optionalUuidValue(row, 'mobile_stop_id'),
    acceptanceMode,
    itemSubtotalMinor,
    shadowDiscountMinor,
    totalMinor: 0,
    currency: currencyValue(row),
    pickupStartsAt,
    pickupEndsAt,
    acceptanceExpiresAt,
    termsVersion: stringValue(row, 'terms_version', 80),
    refundPolicyVersion: stringValue(row, 'refund_policy_version', 80),
    lines: Object.freeze(lines),
  });
}

export function mapPlacedShadowOrderReceipt(
  value: unknown,
  attempt: Pick<ShadowPlacementAttempt, 'businessId' | 'quotePublicId' | 'quoteVersion'>
) {
  const receipt = mapShadowOrderReceipt(value);
  if (
    receipt.businessId !== attempt.businessId ||
    receipt.quotePublicId !== attempt.quotePublicId ||
    receipt.quoteVersion !== attempt.quoteVersion ||
    receipt.fulfillmentState !== 'pending_acceptance'
  ) {
    throw new OrderingResponseError('Ordering receipt is not bound to this quote.');
  }
  return receipt;
}

export function mapCancelledShadowOrderReceipt(
  value: unknown,
  attempt: Pick<ShadowCancellationAttempt, 'businessId' | 'expectedVersion' | 'orderPublicId'>
) {
  const receipt = mapShadowOrderReceipt(value);
  if (
    receipt.businessId !== attempt.businessId ||
    receipt.orderPublicId !== attempt.orderPublicId ||
    receipt.fulfillmentState !== 'cancelled' ||
    receipt.version !== attempt.expectedVersion + 1
  ) {
    throw new OrderingResponseError('Ordering receipt is not bound to this request.');
  }
  return receipt;
}

function newIdempotencyKey(scope: 'cancel' | 'place' | 'quote') {
  const cryptoApi = globalThis.crypto;
  let nonce = cryptoApi?.randomUUID?.();
  if (!nonce && cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  idempotencySequence = (idempotencySequence + 1) % Number.MAX_SAFE_INTEGER;
  nonce ??= `${Date.now().toString(36)}-${idempotencySequence.toString(36)}-${Math.round(
    globalThis.performance?.now?.() ?? 0
  ).toString(36)}`;
  return `spottr:shadow:${scope}:${nonce}`;
}

function assertUuidInput(value: string, label: string) {
  if (!uuidPattern.test(value)) throw new OrderingInputError(`${label} is invalid.`);
}

function normalizeQuoteIntent(intent: ShadowQuoteIntent): ShadowQuoteIntent {
  assertUuidInput(intent.businessId, 'This business link');
  assertUuidInput(intent.capacitySlotId, 'This pickup window');
  if (
    !Number.isFinite(Date.parse(intent.pickupStartsAt)) ||
    !Number.isFinite(Date.parse(intent.pickupEndsAt)) ||
    Date.parse(intent.pickupEndsAt) <= Date.parse(intent.pickupStartsAt)
  ) {
    throw new OrderingInputError('Choose a valid pickup window.');
  }
  if (!intent.lines.length || intent.lines.length > 100) {
    throw new OrderingInputError('Choose at least one menu item.');
  }
  const lines = intent.lines.map((line) => {
    assertUuidInput(line.itemVersionId, 'A menu item');
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100) {
      throw new OrderingInputError('A menu quantity is invalid.');
    }
    const optionVersionIds = [...line.optionVersionIds].sort();
    for (const optionId of optionVersionIds) assertUuidInput(optionId, 'A menu option');
    if (new Set(optionVersionIds).size !== optionVersionIds.length) {
      throw new OrderingInputError('A menu option was selected more than once.');
    }
    return Object.freeze({
      itemVersionId: line.itemVersionId,
      quantity: line.quantity,
      optionVersionIds: Object.freeze(optionVersionIds),
    });
  }).sort((left, right) => left.itemVersionId.localeCompare(right.itemVersionId));
  if (new Set(lines.map((line) => line.itemVersionId)).size !== lines.length) {
    throw new OrderingInputError('A menu item was added more than once.');
  }
  return Object.freeze({
    businessId: intent.businessId,
    capacitySlotId: intent.capacitySlotId,
    pickupStartsAt: intent.pickupStartsAt,
    pickupEndsAt: intent.pickupEndsAt,
    lines: Object.freeze(lines),
  });
}

export function prepareShadowQuoteAttempt(
  previous: ShadowQuoteAttempt | null,
  intent: ShadowQuoteIntent
): ShadowQuoteAttempt {
  const normalized = normalizeQuoteIntent(intent);
  const signature = JSON.stringify(normalized);
  if (previous?.signature === signature) return previous;
  return Object.freeze({
    signature,
    idempotencyKey: newIdempotencyKey('quote'),
    intent: normalized,
  });
}

export function prepareShadowPlacementAttempt(
  previous: ShadowPlacementAttempt | null,
  quote: Pick<ShadowOrderQuote, 'businessId' | 'quotePublicId' | 'quoteVersion'>
): ShadowPlacementAttempt {
  assertUuidInput(quote.businessId, 'This business link');
  assertUuidInput(quote.quotePublicId, 'This quote');
  if (
    !Number.isInteger(quote.quoteVersion) ||
    quote.quoteVersion < 1 ||
    quote.quoteVersion > 2_147_483_646
  ) {
    throw new OrderingInputError('This quote version is invalid.');
  }
  if (
    previous?.businessId === quote.businessId &&
    previous.quotePublicId === quote.quotePublicId &&
    previous.quoteVersion === quote.quoteVersion
  ) return previous;
  return Object.freeze({
    businessId: quote.businessId,
    quotePublicId: quote.quotePublicId,
    quoteVersion: quote.quoteVersion,
    idempotencyKey: newIdempotencyKey('place'),
  });
}

export function prepareShadowCancellationAttempt(
  previous: ShadowCancellationAttempt | null,
  receipt: Pick<ShadowOrderReceipt, 'businessId' | 'orderPublicId' | 'version'>
): ShadowCancellationAttempt {
  assertUuidInput(receipt.businessId, 'This business link');
  assertUuidInput(receipt.orderPublicId, 'This order');
  if (
    !Number.isInteger(receipt.version) ||
    receipt.version < 1 ||
    receipt.version > 2_147_483_646
  ) {
    throw new OrderingInputError('This order version is invalid.');
  }
  if (
    previous?.businessId === receipt.businessId &&
    previous.orderPublicId === receipt.orderPublicId &&
    previous.expectedVersion === receipt.version
  ) return previous;
  return Object.freeze({
    businessId: receipt.businessId,
    orderPublicId: receipt.orderPublicId,
    expectedVersion: receipt.version,
    reasonCode: 'customer_cancelled_before_acceptance',
    idempotencyKey: newIdempotencyKey('cancel'),
  });
}

function isNetworkError(error: unknown) {
  const message = (error as ErrorLike | null)?.message?.toLocaleLowerCase('en-US') ?? '';
  return message.includes('network') || message.includes('fetch') || message.includes('offline');
}

export function orderingFailure(error: unknown, fallback: string): ActionResult<never> {
  if (error instanceof OrderingInputError) {
    return { ok: false, code: 'INVALID', reason: error.message };
  }
  if (error instanceof OrderingResponseError) {
    return { ok: false, code: 'UNKNOWN', reason: 'Spottr received an invalid ordering response.' };
  }
  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  const hasBusinessCode = (...codes: string[]) =>
    codes.some((code) => message.includes(code.toLocaleLowerCase('en-US')));
  if (candidate?.code === 'CONFIG_REQUIRED') {
    return { ok: false, code: 'CONFIG_REQUIRED', reason: 'Secure pickup ordering is not configured.' };
  }
  if (candidate?.status === 401 || message.includes('auth_required') || message.includes('jwt')) {
    return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in again before using the pickup pilot.' };
  }
  if (
    candidate?.status === 403 ||
    candidate?.code === '42501' ||
    message.includes('staff_required') ||
    message.includes('aal2')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: message.includes('aal2')
        ? 'Verify a current authenticator code in Security, then try again.'
        : 'This zero-money pickup pilot is limited to authorized Spottr staff.',
    };
  }
  if (candidate?.status === 429 || message.includes('rate_limit')) {
    return { ok: false, code: 'RATE_LIMITED', reason: 'Too many ordering requests. Wait a moment, then retry.' };
  }
  if (candidate?.code === 'P0002' || hasBusinessCode('ORDER_QUOTE_NOT_FOUND', 'ORDER_NOT_FOUND')) {
    return { ok: false, code: 'NOT_FOUND', reason: 'This pickup order is no longer available.' };
  }
  if (
    candidate?.code === '22023' ||
    candidate?.code === '22003' ||
    hasBusinessCode(
      'INVALID_ORDER_',
      'DUPLICATE_ORDER_ITEM',
      'ORDER_OPTION_SELECTIONS_INVALID',
      'ORDER_MENU_TOO_LARGE',
      'ORDER_QUOTE_TOO_LARGE',
      'ORDER_RECEIPT_TOO_LARGE',
      'ORDER_OPTION_TOTAL_TOO_LARGE',
      'ORDER_TOTAL_TOO_LARGE'
    )
  ) {
    return { ok: false, code: 'INVALID', reason: 'Review the pickup order and try again.' };
  }
  if (
    candidate?.status === 409 ||
    candidate?.code === '23505' ||
    candidate?.code === '40001' ||
    message.includes('expired') ||
    message.includes('conflict') ||
    message.includes('unavailable') ||
    message.includes('consumed') ||
    message.includes('changed') ||
    hasBusinessCode(
      'ORDER_QUOTE_NOT_OPEN',
      'ORDER_NOT_CANCELLABLE',
      'ORDERING_NOT_AVAILABLE',
      'BUSINESS_NOT_ELIGIBLE',
      'ORDERABLE_CATALOG_REQUIRED',
      'ORDER_ITEM_UNAVAILABLE',
      'ORDER_OPTION_UNAVAILABLE',
      'ORDER_QUOTE_SNAPSHOT_INVALID',
      'ORDER_QUOTE_BINDING_INVALID',
      'ORDER_QUOTE_ZERO_MONEY_INVALID',
      'ORDER_QUOTE_STATE_CONFLICT',
      'CAPACITY_RESERVATION_MISSING',
      'SHADOW_MANUAL_ACCEPTANCE_REQUIRED'
    )
  ) {
    return {
      ok: false,
      code: 'CONFLICT',
      reason: 'Menu availability or pickup capacity changed. Review a fresh quote before continuing.',
    };
  }
  if (candidate?.status === 0 || isNetworkError(error)) {
    return {
      ok: false,
      code: 'NETWORK',
      reason: 'The result could not be confirmed. Reconnect and retry without changing the order.',
    };
  }
  if (message.includes('invalid_')) {
    return { ok: false, code: 'INVALID', reason: 'Review the pickup order and try again.' };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

async function authorizedPilotClient() {
  if (!featureFlags.pickupOrdering || !isSupabaseConfigured || !supabase) {
    throw Object.assign(new Error('Secure pickup ordering is not configured.'), {
      code: 'CONFIG_REQUIRED',
    });
  }
  const [{ data, error }, assurance] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (error || !data.user) {
    throw Object.assign(error ?? new Error('AUTH_REQUIRED'), { status: 401 });
  }
  if (assurance.error) throw assurance.error;
  if (assurance.data.currentLevel !== 'aal2') {
    throw Object.assign(new Error('AAL2_REQUIRED'), { status: 403 });
  }
  return supabase;
}

function assertKey(value: string) {
  if (value.length < 16 || value.length > 128 || /\s/.test(value)) {
    throw new OrderingInputError('Create a fresh secure ordering request.');
  }
}

export async function loadShadowOrderableMenu(
  businessId: string
): Promise<ActionResult<ShadowOrderableMenu>> {
  try {
    assertUuidInput(businessId, 'This business link');
    const client = await authorizedPilotClient();
    const { data, error } = await client.rpc('get_shadow_orderable_menu', {
      target_business_id: businessId,
    });
    if (error) throw error;
    const menu = mapShadowOrderableMenu(data);
    if (menu.businessId !== businessId) throw new OrderingResponseError('Mismatched business.');
    return { ok: true, data: menu };
  } catch (error) {
    return orderingFailure(error, 'The secure pickup menu could not be loaded.');
  }
}

export async function requestShadowOrderQuote(
  attempt: ShadowQuoteAttempt
): Promise<ActionResult<ShadowOrderQuote>> {
  try {
    const normalized = normalizeQuoteIntent(attempt.intent);
    if (attempt.signature !== JSON.stringify(normalized)) {
      throw new OrderingInputError('The pickup order changed. Request a fresh quote.');
    }
    assertKey(attempt.idempotencyKey);
    const client = await authorizedPilotClient();
    const { data, error } = await client.rpc('quote_shadow_order', {
      target_business_id: normalized.businessId,
      target_capacity_slot_id: normalized.capacitySlotId,
      target_pickup_starts_at: normalized.pickupStartsAt,
      target_pickup_ends_at: normalized.pickupEndsAt,
      target_lines: normalized.lines.map((line) => ({
        item_version_id: line.itemVersionId,
        quantity: line.quantity,
        option_version_ids: line.optionVersionIds,
      })),
      idempotency_key: attempt.idempotencyKey,
    });
    if (error) throw error;
    const quote = mapShadowOrderQuote(data);
    if (
      quote.businessId !== normalized.businessId ||
      quote.capacitySlotId !== normalized.capacitySlotId ||
      Date.parse(quote.pickupStartsAt) !== Date.parse(normalized.pickupStartsAt) ||
      Date.parse(quote.pickupEndsAt) !== Date.parse(normalized.pickupEndsAt)
    ) {
      throw new OrderingResponseError('Ordering quote is not bound to this request.');
    }
    return { ok: true, data: quote };
  } catch (error) {
    return orderingFailure(error, 'A secure pickup quote could not be created.');
  }
}

export async function placeShadowOrder(
  attempt: ShadowPlacementAttempt
): Promise<ActionResult<ShadowOrderReceipt>> {
  try {
    assertUuidInput(attempt.businessId, 'This business link');
    assertUuidInput(attempt.quotePublicId, 'This quote');
    if (
      !Number.isInteger(attempt.quoteVersion) ||
      attempt.quoteVersion < 1 ||
      attempt.quoteVersion > 2_147_483_646
    ) {
      throw new OrderingInputError('This quote version is invalid.');
    }
    assertKey(attempt.idempotencyKey);
    const client = await authorizedPilotClient();
    const { data, error } = await client.rpc('place_shadow_order', {
      target_quote_public_id: attempt.quotePublicId,
      expected_quote_version: attempt.quoteVersion,
      idempotency_key: attempt.idempotencyKey,
    });
    if (error) throw error;
    const receipt = mapPlacedShadowOrderReceipt(data, attempt);
    return { ok: true, data: receipt };
  } catch (error) {
    return orderingFailure(error, 'The pickup pilot order could not be placed.');
  }
}

export async function cancelShadowOrder(
  attempt: ShadowCancellationAttempt
): Promise<ActionResult<ShadowOrderReceipt>> {
  try {
    assertUuidInput(attempt.businessId, 'This business link');
    assertUuidInput(attempt.orderPublicId, 'This order');
    if (
      !Number.isInteger(attempt.expectedVersion) ||
      attempt.expectedVersion < 1 ||
      attempt.expectedVersion > 2_147_483_646
    ) {
      throw new OrderingInputError('This order version is invalid.');
    }
    if (attempt.reasonCode !== 'customer_cancelled_before_acceptance') {
      throw new OrderingInputError('Choose a valid cancellation reason.');
    }
    assertKey(attempt.idempotencyKey);
    const client = await authorizedPilotClient();
    const { data, error } = await client.rpc('cancel_shadow_order', {
      target_order_public_id: attempt.orderPublicId,
      expected_version: attempt.expectedVersion,
      reason_code: attempt.reasonCode,
      idempotency_key: attempt.idempotencyKey,
    });
    if (error) throw error;
    const receipt = mapCancelledShadowOrderReceipt(data, attempt);
    return { ok: true, data: receipt };
  } catch (error) {
    return orderingFailure(error, 'The pickup pilot order could not be cancelled.');
  }
}
