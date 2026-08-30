import {
  createAccountBoundSupabaseClient,
  isSupabaseConfigured,
  supabase,
} from '@/lib/supabase';

export type PickupPaymentOptionKind = 'pay_in_person' | 'card' | 'apple_pay';

export type PickupPaymentOption = Readonly<{
  kind: PickupPaymentOptionKind;
  label: string;
  configurationAllowed: boolean;
  chargeEnabled: false;
  unavailableReason: string | null;
}>;

export type BusinessPickupOrderingPreferences = Readonly<{
  businessId: string;
  eligibleKind: boolean;
  merchantOptedIn: boolean;
  acceptedPaymentOptions: readonly ('pay_in_person')[];
  customerOrderingEnabled: false;
  onlinePaymentProcessingEnabled: false;
  listingState: 'draft' | 'pending' | 'published' | 'suspended' | 'archived';
  verificationState: 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';
  paymentOptions: readonly PickupPaymentOption[];
}>;

type ResultCode =
  | 'AUTH_REQUIRED'
  | 'CONFIG_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID'
  | 'NETWORK'
  | 'UNKNOWN';

export type BusinessPickupOrderingResult<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; code: ResultCode; reason: string };

type UnknownRow = Record<string, unknown>;
type ErrorLike = { code?: string; message?: string; status?: number };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const listingStates = new Set([
  'draft',
  'pending',
  'published',
  'suspended',
  'archived',
] as const);
const verificationStates = new Set([
  'unverified',
  'pending',
  'verified',
  'rejected',
  'expired',
] as const);
const expectedOptionKinds: readonly PickupPaymentOptionKind[] = [
  'pay_in_person',
  'card',
  'apple_pay',
];

class PickupOrderingResponseError extends Error {}
class PickupOrderingValidationError extends Error {}

function objectValue(value: unknown): UnknownRow {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new PickupOrderingResponseError('Expected one pickup-ordering record.');
    }
    return objectValue(value[0]);
  }
  if (!value || typeof value !== 'object') {
    throw new PickupOrderingResponseError('Pickup-ordering settings were invalid.');
  }
  return value as UnknownRow;
}
function booleanValue(row: UnknownRow, key: string): boolean {
  if (typeof row[key] !== 'boolean') {
    throw new PickupOrderingResponseError(`Pickup-ordering ${key} was invalid.`);
  }
  return row[key];
}

function stringValue(row: UnknownRow, key: string, maximum: number): string {
  const value = row[key];
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PickupOrderingResponseError(`Pickup-ordering ${key} was invalid.`);
  }
  return value;
}

function mapPaymentOption(value: unknown): PickupPaymentOption {
  const row = objectValue(value);
  const kind = stringValue(row, 'kind', 40) as PickupPaymentOptionKind;
  if (!expectedOptionKinds.includes(kind)) {
    throw new PickupOrderingResponseError('Pickup-ordering payment kind was invalid.');
  }
  const configurationAllowed = booleanValue(row, 'configuration_allowed');
  const chargeEnabled = booleanValue(row, 'charge_enabled');
  const unavailableReason = row.unavailable_reason;
  if (chargeEnabled) {
    throw new PickupOrderingResponseError('Online payment processing is not launch-enabled.');
  }
  if (kind === 'pay_in_person') {
    if (!configurationAllowed || unavailableReason !== null) {
      throw new PickupOrderingResponseError('Pay-in-person capability was inconsistent.');
    }
  } else if (
    configurationAllowed ||
    typeof unavailableReason !== 'string' ||
    unavailableReason.trim().length < 1 ||
    unavailableReason.length > 500
  ) {
    throw new PickupOrderingResponseError('Online payment capability was inconsistent.');
  }
  return Object.freeze({
    kind,
    label: stringValue(row, 'label', 80),
    configurationAllowed,
    chargeEnabled: false,
    unavailableReason: unavailableReason as string | null,
  });
}

export function mapBusinessPickupOrderingPreferences(
  value: unknown
): BusinessPickupOrderingPreferences {
  const row = objectValue(value);
  const businessId = stringValue(row, 'business_id', 36);
  if (!uuidPattern.test(businessId)) {
    throw new PickupOrderingResponseError('Pickup-ordering business ID was invalid.');
  }
  const eligibleKind = booleanValue(row, 'eligible_kind');
  const merchantOptedIn = booleanValue(row, 'merchant_opted_in');
  if (!eligibleKind && merchantOptedIn) {
    throw new PickupOrderingResponseError('An ineligible category cannot opt in.');
  }
  if (
    booleanValue(row, 'customer_ordering_enabled') ||
    booleanValue(row, 'online_payment_processing_enabled')
  ) {
    throw new PickupOrderingResponseError(
      'Pickup ordering response attempted to enable an unavailable launch capability.'
    );
  }

  if (!Array.isArray(row.accepted_payment_options)) {
    throw new PickupOrderingResponseError('Accepted pickup payment options were invalid.');
  }
  const acceptedPaymentOptions = row.accepted_payment_options;
  if (
    (merchantOptedIn &&
      (acceptedPaymentOptions.length !== 1 || acceptedPaymentOptions[0] !== 'pay_in_person')) ||
    (!merchantOptedIn && acceptedPaymentOptions.length !== 0)
  ) {
    throw new PickupOrderingResponseError(
      'Accepted pickup payment options exceeded the launch slice.'
    );
  }

  const listingState = stringValue(row, 'listing_state', 20);
  const verificationState = stringValue(row, 'verification_state', 20);
  if (
    !listingStates.has(listingState as BusinessPickupOrderingPreferences['listingState']) ||
    !verificationStates.has(
      verificationState as BusinessPickupOrderingPreferences['verificationState']
    )
  ) {
    throw new PickupOrderingResponseError('Pickup-ordering business state was invalid.');
  }

  if (!Array.isArray(row.payment_options) || row.payment_options.length !== 3) {
    throw new PickupOrderingResponseError('Pickup payment capability list was invalid.');
  }
  const paymentOptions = row.payment_options.map(mapPaymentOption);
  if (
    paymentOptions.some((option, index) => option.kind !== expectedOptionKinds[index]) ||
    new Set(paymentOptions.map((option) => option.kind)).size !== expectedOptionKinds.length
  ) {
    throw new PickupOrderingResponseError('Pickup payment capability order was invalid.');
  }

  return Object.freeze({
    businessId,
    eligibleKind,
    merchantOptedIn,
    acceptedPaymentOptions: Object.freeze(
      acceptedPaymentOptions.slice() as ('pay_in_person')[]
    ),
    customerOrderingEnabled: false,
    onlinePaymentProcessingEnabled: false,
    listingState: listingState as BusinessPickupOrderingPreferences['listingState'],
    verificationState:
      verificationState as BusinessPickupOrderingPreferences['verificationState'],
    paymentOptions: Object.freeze(paymentOptions),
  });
}

function assertUuid(value: string, label: string) {
  if (!uuidPattern.test(value)) {
    throw new PickupOrderingValidationError(`${label} is invalid.`);
  }
}

function networkError(error: unknown) {
  const message = (error as ErrorLike | null)?.message?.toLocaleLowerCase('en-US') ?? '';
  return (
    (error as ErrorLike | null)?.status === 0 ||
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('offline') ||
    message.includes('connection')
  );
}

function failure<T>(
  error: unknown,
  fallback: string
): BusinessPickupOrderingResult<T> {
  if (error instanceof PickupOrderingValidationError) {
    return { ok: false, code: 'INVALID', reason: error.message };
  }
  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.code === 'CONFIG_REQUIRED') {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Connect Spottr live services before changing pickup preferences.',
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
      reason: 'Sign in again before changing pickup preferences.',
    };
  }
  if (
    candidate?.status === 403 ||
    candidate?.code === '42501' ||
    message.includes('owner or manager') ||
    message.includes('aal2')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'A verified owner or manager session is required.',
    };
  }
  if (message.includes('online_payment_processing_unavailable')) {
    return {
      ok: false,
      code: 'INVALID',
      reason: 'Card and Apple Pay remain unavailable in Spottr.',
    };
  }
  if (message.includes('pickup_ordering_kind_not_eligible')) {
    return {
      ok: false,
      code: 'INVALID',
      reason: 'Pickup ordering is currently limited to restaurants and food trucks.',
    };
  }
  if (message.includes('verified_published_business_required')) {
    return {
      ok: false,
      code: 'INVALID',
      reason: 'Publish and verify this listing before opting in to pickup ordering.',
    };
  }
  if (
    candidate?.code === '22023' ||
    candidate?.code === '23514' ||
    error instanceof PickupOrderingResponseError ||
    message.includes('invalid_pickup')
  ) {
    return {
      ok: false,
      code: 'INVALID',
      reason: 'Reload the verified pickup options before saving.',
    };
  }
  if (networkError(error)) {
    return {
      ok: false,
      code: 'NETWORK',
      reason: 'Spottr could not confirm this preference. Check your connection and reload.',
    };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

async function secureClient(expectedUserId: string) {
  if (!isSupabaseConfigured || !supabase) {
    throw Object.assign(new Error('Live services are not configured.'), {
      code: 'CONFIG_REQUIRED',
    });
  }
  assertUuid(expectedUserId, 'The active account');
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) {
    throw Object.assign(new Error('The active account changed.'), { status: 401 });
  }
  return client;
}

export async function loadBusinessPickupOrderingPreferences(
  businessId: string,
  expectedUserId: string
): Promise<BusinessPickupOrderingResult<BusinessPickupOrderingPreferences>> {
  try {
    assertUuid(businessId, 'This business link');
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc(
      'get_business_pickup_ordering_preferences',
      { target_business_id: businessId }
    );
    if (error) throw error;
    return { ok: true, data: mapBusinessPickupOrderingPreferences(data) };
  } catch (error) {
    return failure(error, 'Pickup-ordering preferences could not be loaded.');
  }
}

export async function saveBusinessPickupOrderingPreferences(
  businessId: string,
  optedIn: boolean,
  expectedUserId: string
): Promise<BusinessPickupOrderingResult<BusinessPickupOrderingPreferences>> {
  try {
    assertUuid(businessId, 'This business link');
    if (typeof optedIn !== 'boolean') {
      throw new PickupOrderingValidationError('Choose a valid pickup-ordering preference.');
    }
    const client = await secureClient(expectedUserId);
    const { data, error } = await client.rpc(
      'set_business_pickup_ordering_preferences',
      {
        target_business_id: businessId,
        pickup_ordering_opt_in: optedIn,
        accepted_payment_options: optedIn ? ['pay_in_person'] : [],
      }
    );
    if (error) throw error;
    const preferences = mapBusinessPickupOrderingPreferences(data);
    if (preferences.businessId !== businessId || preferences.merchantOptedIn !== optedIn) {
      throw new PickupOrderingResponseError(
        'Pickup-ordering response was not bound to the saved preference.'
      );
    }
    return {
      ok: true,
      data: preferences,
      message: optedIn
        ? 'Pickup opt-in saved. Customer checkout remains off until Spottr separately enables the launch.'
        : 'Pickup opt-in removed. Customer checkout remains off.',
    };
  } catch (error) {
    return failure(error, 'Pickup-ordering preferences could not be saved.');
  }
}
