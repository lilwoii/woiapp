import {
  createAccountBoundSupabaseClient,
  isSupabaseConfigured,
  supabase,
} from '@/lib/supabase';

export type PickupMenuLocation = Readonly<{
  id: string;
  label: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
}>;

export type PickupMenuItem = Readonly<{
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  dietaryTags: readonly string[];
  allergenNote: string | null;
}>;

export type PickupMenuSection = Readonly<{
  id: string;
  name: string;
  items: readonly PickupMenuItem[];
}>;

export type PayInPersonPickupMenu = Readonly<{
  businessId: string;
  businessName: string;
  paymentMethod: 'pay_in_person';
  paymentLabel: string;
  minimumLeadMinutes: number;
  maximumAdvanceMinutes: number;
  termsVersion: string;
  locations: readonly PickupMenuLocation[];
  sections: readonly PickupMenuSection[];
}>;

export type PickupOrderReceipt = Readonly<{
  orderPublicId: string;
  businessId: string;
  businessName: string;
  locationId: string;
  state:
    | 'pending_acceptance'
    | 'accepted'
    | 'preparing'
    | 'ready'
    | 'completed'
    | 'rejected'
    | 'cancelled'
    | 'expired';
  paymentMethod: 'pay_in_person' | 'card_or_wallet';
  paymentState: 'due_at_pickup' | 'captured' | 'refund_pending' | 'refunded' | 'partially_refunded' | 'disputed';
  currency: string;
  itemSubtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  requestedPickupAt: string;
  acceptanceExpiresAt: string;
  customerNote: string | null;
  termsVersion: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: readonly Readonly<{
    menuItemId: string | null;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    lineSubtotalMinor: number;
    allergenNote: string | null;
  }>[];
}>;

export type PickupOrderResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: 'AUTH_REQUIRED' | 'CONFIG_REQUIRED' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID' | 'NETWORK' | 'UNAVAILABLE' | 'UNKNOWN';
      reason: string;
    };

type UnknownRow = Record<string, unknown>;
type ErrorLike = { code?: string; message?: string; status?: number };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const states = new Set<PickupOrderReceipt['state']>([
  'pending_acceptance', 'accepted', 'preparing', 'ready', 'completed',
  'rejected', 'cancelled', 'expired',
]);
let idempotencySequence = 0;

class PickupResponseError extends Error {}
class PickupInputError extends Error {}

function objectValue(value: unknown): UnknownRow {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new PickupResponseError('The pickup response was invalid.');
  }
  return value as UnknownRow;
}

function stringValue(row: UnknownRow, key: string, maximum: number): string {
  const value = row[key];
  if (
    typeof value !== 'string' || value !== value.trim() || !value ||
    value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new PickupResponseError(`The pickup ${key} field was invalid.`);
  return value;
}

function nullableString(row: UnknownRow, key: string, maximum: number): string | null {
  if (row[key] === null) return null;
  return stringValue(row, key, maximum);
}

function integerValue(row: UnknownRow, key: string, minimum: number, maximum: number) {
  const value = row[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PickupResponseError(`The pickup ${key} field was invalid.`);
  }
  return value as number;
}

function uuidValue(row: UnknownRow, key: string): string {
  const value = stringValue(row, key, 36);
  if (!uuidPattern.test(value)) throw new PickupResponseError(`The pickup ${key} field was invalid.`);
  return value;
}

function isoValue(row: UnknownRow, key: string) {
  const value = stringValue(row, key, 40);
  if (!Number.isFinite(Date.parse(value))) throw new PickupResponseError(`The pickup ${key} field was invalid.`);
  return value;
}

function arrayValue(row: UnknownRow, key: string, maximum: number): unknown[] {
  const value = row[key];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PickupResponseError(`The pickup ${key} field was invalid.`);
  }
  return value;
}

function mapLocation(value: unknown): PickupMenuLocation {
  const row = objectValue(value);
  return Object.freeze({
    id: uuidValue(row, 'id'),
    label: stringValue(row, 'label', 120),
    address: stringValue(row, 'address', 300),
    city: stringValue(row, 'city', 120),
    region: stringValue(row, 'region', 80),
    postalCode: typeof row.postal_code === 'string' ? row.postal_code.slice(0, 24) : '',
  });
}

function mapMenuItem(value: unknown): PickupMenuItem {
  const row = objectValue(value);
  const currency = stringValue(row, 'currency', 3);
  if (!/^[A-Z]{3}$/.test(currency)) throw new PickupResponseError('The pickup currency was invalid.');
  const dietaryTags = arrayValue(row, 'dietary_tags', 12).map((tag) => {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > 60) {
      throw new PickupResponseError('A dietary label was invalid.');
    }
    return tag;
  });
  return Object.freeze({
    id: uuidValue(row, 'id'),
    name: stringValue(row, 'name', 120),
    description: typeof row.description === 'string' ? row.description.slice(0, 1000) : '',
    priceMinor: integerValue(row, 'price_minor', 0, 100_000_000),
    currency,
    dietaryTags: Object.freeze(dietaryTags),
    allergenNote: nullableString(row, 'allergen_note', 500),
  });
}

export function mapPayInPersonPickupMenu(value: unknown): PayInPersonPickupMenu {
  const row = objectValue(value);
  if (row.customer_ordering_enabled !== true || row.payment_method !== 'pay_in_person') {
    throw new PickupResponseError('Pickup ordering was not explicitly enabled.');
  }
  const locations = arrayValue(row, 'locations', 50).map(mapLocation);
  const sections = arrayValue(row, 'sections', 80).map((candidate) => {
    const section = objectValue(candidate);
    const items = arrayValue(section, 'items', 200).map(mapMenuItem);
    if (!items.length) throw new PickupResponseError('A pickup menu section was empty.');
    return Object.freeze({
      id: uuidValue(section, 'id'),
      name: stringValue(section, 'name', 80),
      items: Object.freeze(items),
    });
  });
  if (!locations.length || !sections.length) throw new PickupResponseError('Pickup ordering had no available inventory.');
  return Object.freeze({
    businessId: uuidValue(row, 'business_id'),
    businessName: stringValue(row, 'business_name', 100),
    paymentMethod: 'pay_in_person',
    paymentLabel: stringValue(row, 'payment_label', 80),
    minimumLeadMinutes: integerValue(row, 'minimum_lead_minutes', 10, 1440),
    maximumAdvanceMinutes: integerValue(row, 'maximum_advance_minutes', 60, 20160),
    termsVersion: stringValue(row, 'terms_version', 80),
    locations: Object.freeze(locations),
    sections: Object.freeze(sections),
  });
}

export function mapPickupOrderReceipt(value: unknown): PickupOrderReceipt {
  const row = objectValue(value);
  const state = stringValue(row, 'state', 24) as PickupOrderReceipt['state'];
  const paymentMethod = row.payment_method;
  const paymentState = row.payment_state;
  const onlinePaymentStates = new Set(['captured', 'refund_pending', 'refunded', 'partially_refunded', 'disputed']);
  if (
    !states.has(state) ||
    (paymentMethod !== 'pay_in_person' && paymentMethod !== 'card_or_wallet') ||
    (paymentMethod === 'pay_in_person' && paymentState !== 'due_at_pickup') ||
    (paymentMethod === 'card_or_wallet' && !onlinePaymentStates.has(paymentState as string))
  ) {
    throw new PickupResponseError('The pickup order state was invalid.');
  }
  const currency = stringValue(row, 'currency', 3);
  const lines = arrayValue(row, 'lines', 20).map((candidate) => {
    const line = objectValue(candidate);
    const menuItemId = line.menu_item_id === null ? null : uuidValue(line, 'menu_item_id');
    return Object.freeze({
      menuItemId,
      name: stringValue(line, 'name', 120),
      quantity: integerValue(line, 'quantity', 1, 20),
      unitPriceMinor: integerValue(line, 'unit_price_minor', 0, 100_000_000),
      lineSubtotalMinor: integerValue(line, 'line_subtotal_minor', 0, 100_000_000),
      allergenNote: nullableString(line, 'allergen_note', 500),
    });
  });
  if (!lines.length || !/^[A-Z]{3}$/.test(currency)) throw new PickupResponseError('The pickup receipt was incomplete.');
  const requestedPickupAt = isoValue(row, 'requested_pickup_at');
  const acceptanceExpiresAt = isoValue(row, 'acceptance_expires_at');
  if (Date.parse(acceptanceExpiresAt) >= Date.parse(requestedPickupAt)) {
    throw new PickupResponseError('The pickup acceptance window was invalid.');
  }
  const itemSubtotalMinor = integerValue(row, 'item_subtotal_minor', 0, 100_000_000);
  const taxMinor = integerValue(row, 'tax_minor', 0, 100_000_000);
  const totalMinor = integerValue(row, 'total_minor', 0, 100_000_000);
  if (
    totalMinor !== itemSubtotalMinor + taxMinor ||
    (paymentMethod === 'pay_in_person' && taxMinor !== 0)
  ) throw new PickupResponseError('The pickup payment totals were invalid.');
  return Object.freeze({
    orderPublicId: uuidValue(row, 'order_public_id'),
    businessId: uuidValue(row, 'business_id'),
    businessName: stringValue(row, 'business_name', 100),
    locationId: uuidValue(row, 'location_id'),
    state,
    paymentMethod,
    paymentState: paymentState as PickupOrderReceipt['paymentState'],
    currency,
    itemSubtotalMinor,
    taxMinor,
    totalMinor,
    requestedPickupAt,
    acceptanceExpiresAt,
    customerNote: nullableString(row, 'customer_note', 240),
    termsVersion: stringValue(row, 'terms_version', 80),
    version: integerValue(row, 'version', 1, 2_147_483_647),
    createdAt: isoValue(row, 'created_at'),
    updatedAt: isoValue(row, 'updated_at'),
    lines: Object.freeze(lines),
  });
}

function assertUuid(value: string, label: string) {
  if (!uuidPattern.test(value)) throw new PickupInputError(`${label} is invalid.`);
}

function idempotencyKey(scope: 'create' | 'cancel' | 'transition') {
  const cryptoApi = globalThis.crypto;
  let nonce: string | undefined = cryptoApi?.randomUUID?.();
  if (!nonce && cryptoApi?.getRandomValues) {
    nonce = Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
  }
  idempotencySequence = (idempotencySequence + 1) % Number.MAX_SAFE_INTEGER;
  nonce ??= `${Date.now().toString(36)}-${idempotencySequence.toString(36)}`;
  return `spottr:pickup:${scope}:${nonce}`;
}

function failure<T>(error: unknown, fallback: string): PickupOrderResult<T> {
  if (error instanceof PickupInputError || error instanceof PickupResponseError) {
    return { ok: false, code: 'INVALID', reason: error.message };
  }
  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.code === 'CONFIG_REQUIRED') return { ok: false, code: 'CONFIG_REQUIRED', reason: 'Connect Spottr live services to order pickup.' };
  if (candidate?.status === 401 || message.includes('jwt') || message.includes('active_account_required')) {
    return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to place a pickup order.' };
  }
  if (candidate?.status === 403 || candidate?.code === '42501' || message.includes('aal2') || message.includes('business_membership_required')) {
    return { ok: false, code: 'FORBIDDEN', reason: 'A verified business session is required for this order action.' };
  }
  if (message.includes('version_conflict') || message.includes('not_cancellable') || message.includes('acceptance_expired')) {
    return { ok: false, code: 'CONFLICT', reason: 'This order changed. Refresh before trying again.' };
  }
  if (message.includes('not_available') || message.includes('unavailable') || message.includes('active_pickup_order_limit')) {
    return { ok: false, code: 'UNAVAILABLE', reason: 'Pickup ordering is not available for this selection right now.' };
  }
  if (candidate?.code === '22023' || candidate?.code === '22003' || message.includes('invalid_pickup')) {
    return { ok: false, code: 'INVALID', reason: 'Review the pickup time, items, and note.' };
  }
  if (candidate?.status === 0 || message.includes('network') || message.includes('fetch') || message.includes('offline')) {
    return { ok: false, code: 'NETWORK', reason: 'Spottr could not confirm the order. Reconnect and retry once.' };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

async function secureClient(expectedUserId: string) {
  if (!isSupabaseConfigured || !supabase) throw Object.assign(new Error('Live services are not configured.'), { code: 'CONFIG_REQUIRED' });
  assertUuid(expectedUserId, 'The active account');
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) throw Object.assign(new Error('The active account changed.'), { status: 401 });
  return client;
}

export async function loadPayInPersonPickupMenu(
  businessId: string,
  expectedUserId: string
): Promise<PickupOrderResult<PayInPersonPickupMenu>> {
  try {
    assertUuid(businessId, 'This business link');
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('get_pay_in_person_pickup_menu', { target_business_id: businessId });
    if (error) throw error;
    const menu = mapPayInPersonPickupMenu(data);
    if (menu.businessId !== businessId) throw new PickupResponseError('The pickup menu was not bound to this listing.');
    return { ok: true, data: menu };
  } catch (error) {
    return failure(error, 'The pickup menu could not be loaded.');
  }
}

export async function createPayInPersonPickupOrder(
  input: Readonly<{
    businessId: string;
    locationId: string;
    requestedPickupAt: string;
    lines: readonly Readonly<{ menuItemId: string; quantity: number }>[];
    customerNote: string;
  }>,
  expectedUserId: string
): Promise<PickupOrderResult<PickupOrderReceipt>> {
  try {
    assertUuid(input.businessId, 'This business link');
    assertUuid(input.locationId, 'This pickup location');
    if (!Number.isFinite(Date.parse(input.requestedPickupAt)) || !input.lines.length || input.lines.length > 20) {
      throw new PickupInputError('Choose a valid pickup time and at least one item.');
    }
    const seen = new Set<string>();
    const lines = input.lines.map((line) => {
      assertUuid(line.menuItemId, 'A menu item');
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20 || seen.has(line.menuItemId)) {
        throw new PickupInputError('Each menu item needs a quantity from 1 to 20.');
      }
      seen.add(line.menuItemId);
      return { menu_item_id: line.menuItemId, quantity: line.quantity };
    });
    const note = input.customerNote.trim();
    if (note.length > 240 || /[\u0000-\u001f\u007f]/.test(note)) throw new PickupInputError('Keep the pickup note under 240 characters.');
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('create_pay_in_person_pickup_order', {
      target_business_id: input.businessId,
      target_location_id: input.locationId,
      target_requested_pickup_at: input.requestedPickupAt,
      target_lines: lines,
      target_customer_note: note || null,
      idempotency_key: idempotencyKey('create'),
    });
    if (error) throw error;
    const receipt = mapPickupOrderReceipt(data);
    if (receipt.businessId !== input.businessId || receipt.locationId !== input.locationId) {
      throw new PickupResponseError('The pickup receipt was not bound to this request.');
    }
    return { ok: true, data: receipt };
  } catch (error) {
    return failure(error, 'Spottr could not confirm the pickup order.');
  }
}

export async function cancelPayInPersonPickupOrder(
  receipt: Pick<PickupOrderReceipt, 'orderPublicId' | 'version'>,
  expectedUserId: string
): Promise<PickupOrderResult<PickupOrderReceipt>> {
  try {
    assertUuid(receipt.orderPublicId, 'This order');
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('cancel_pay_in_person_pickup_order', {
      target_order_public_id: receipt.orderPublicId,
      expected_version: receipt.version,
      idempotency_key: idempotencyKey('cancel'),
    });
    if (error) throw error;
    const next = mapPickupOrderReceipt(data);
    if (next.orderPublicId !== receipt.orderPublicId || next.state !== 'cancelled') {
      throw new PickupResponseError('The cancellation result was not bound to this order.');
    }
    return { ok: true, data: next };
  } catch (error) {
    return failure(error, 'Spottr could not confirm the cancellation.');
  }
}

export async function loadBusinessPayInPersonPickupOrders(
  businessId: string,
  expectedUserId: string
): Promise<PickupOrderResult<readonly PickupOrderReceipt[]>> {
  try {
    assertUuid(businessId, 'This business link');
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('get_business_pay_in_person_pickup_orders', {
      target_business_id: businessId,
      result_limit: 25,
    });
    if (error) throw error;
    if (!Array.isArray(data) || data.length > 25) throw new PickupResponseError('The pickup queue was invalid.');
    const orders = data.map(mapPickupOrderReceipt);
    if (orders.some((order) => order.businessId !== businessId)) {
      throw new PickupResponseError('The pickup queue crossed a business boundary.');
    }
    return { ok: true, data: Object.freeze(orders) };
  } catch (error) {
    return failure(error, 'The pickup queue could not be loaded.');
  }
}

export async function loadMyPayInPersonPickupOrders(
  expectedUserId: string
): Promise<PickupOrderResult<readonly PickupOrderReceipt[]>> {
  try {
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('get_my_pay_in_person_pickup_orders', {
      result_limit: 50,
    });
    if (error) throw error;
    if (!Array.isArray(data) || data.length > 50) throw new PickupResponseError('Your pickup order history was invalid.');
    return { ok: true, data: Object.freeze(data.map(mapPickupOrderReceipt)) };
  } catch (error) {
    return failure(error, 'Your pickup orders could not be loaded.');
  }
}

export async function transitionPayInPersonPickupOrder(
  input: Readonly<{
    businessId: string;
    orderPublicId: string;
    expectedVersion: number;
    nextState: 'accepted' | 'preparing' | 'ready' | 'completed' | 'rejected' | 'cancelled';
  }>,
  expectedUserId: string
): Promise<PickupOrderResult<PickupOrderReceipt>> {
  try {
    assertUuid(input.businessId, 'This business link');
    assertUuid(input.orderPublicId, 'This order');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new PickupInputError('Refresh this order before changing it.');
    }
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc('transition_pay_in_person_pickup_order', {
      target_order_public_id: input.orderPublicId,
      expected_version: input.expectedVersion,
      next_state: input.nextState,
      idempotency_key: idempotencyKey('transition'),
    });
    if (error) throw error;
    const receipt = mapPickupOrderReceipt(data);
    if (
      receipt.businessId !== input.businessId ||
      receipt.orderPublicId !== input.orderPublicId ||
      receipt.version !== input.expectedVersion + 1 ||
      receipt.state !== input.nextState
    ) throw new PickupResponseError('The pickup transition was not bound to this request.');
    return { ok: true, data: receipt };
  } catch (error) {
    return failure(error, 'The pickup order could not be updated.');
  }
}
