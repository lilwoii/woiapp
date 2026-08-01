export const MAX_QUOTE_LINES = 100;

export type OrderingInvariantCode =
  | 'BUSINESS_NOT_ACCEPTING'
  | 'CAPACITY_UNAVAILABLE'
  | 'CURRENCY_MISMATCH'
  | 'IDEMPOTENCY_INVALID'
  | 'INVENTORY_UNAVAILABLE'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_MENU_SNAPSHOT'
  | 'INVALID_MINOR_UNIT'
  | 'INVALID_TRANSITION'
  | 'ITEM_UNAVAILABLE'
  | 'MONEY_OVERFLOW'
  | 'OPTION_UNAVAILABLE'
  | 'PICKUP_WINDOW_INVALID'
  | 'REFUND_INVALID'
  | 'TRANSITION_NOT_AUTHORIZED';

type InvariantContextValue = boolean | number | string | null;

export class OrderingInvariantError extends Error {
  readonly code: OrderingInvariantCode;
  readonly context: Readonly<Record<string, InvariantContextValue>>;

  constructor(
    code: OrderingInvariantCode,
    message: string,
    context: Record<string, InvariantContextValue> = {}
  ) {
    super(message);
    this.name = 'OrderingInvariantError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export type AvailabilityState = 'available' | 'hidden' | 'sold_out';
export type AcceptanceMode = 'automatic' | 'manual';

export type MenuOptionVersionSnapshot = {
  readonly optionId: string;
  readonly optionVersionId: string;
  readonly name: string;
  readonly priceDeltaMinor: number;
  readonly orderable: boolean;
};

export type MenuOptionGroupVersionSnapshot = {
  readonly optionGroupId: string;
  readonly optionGroupVersionId: string;
  readonly name: string;
  readonly minimumSelections: number;
  readonly maximumSelections: number;
  readonly options: readonly MenuOptionVersionSnapshot[];
};

export type MenuItemVersionSnapshot = {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly catalogVersionId: string;
  readonly name: string;
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly maximumQuantity: number;
  readonly orderable: boolean;
  readonly optionGroups: readonly MenuOptionGroupVersionSnapshot[];
};

export type SelectedOptionIntent = {
  readonly optionGroupVersionId: string;
  readonly optionVersionId: string;
};

export type QuoteLineIntent = {
  readonly lineId: string;
  readonly item: MenuItemVersionSnapshot;
  readonly quantity: number;
  readonly selectedOptions: readonly SelectedOptionIntent[];
};

export type ItemAvailabilitySnapshot = {
  readonly itemVersionId: string;
  readonly state: AvailabilityState;
  readonly onHandQuantity: number | null;
  readonly reservedQuantity: number;
  readonly revision: number;
};

export type OptionAvailabilitySnapshot = {
  readonly optionVersionId: string;
  readonly state: AvailabilityState;
  readonly revision: number;
};

export type OrderingAvailabilitySnapshot = {
  readonly businessId: string;
  readonly locationId: string;
  readonly catalogVersionId: string;
  readonly revision: number;
  readonly acceptingOrders: boolean;
  readonly capacity: {
    readonly maximumActiveOrders: number;
    readonly acceptedOrders: number;
    readonly reservedOrders: number;
  };
  readonly items: readonly ItemAvailabilitySnapshot[];
  readonly options: readonly OptionAvailabilitySnapshot[];
};

export type MobileStopWindow = {
  readonly stopId: string;
  readonly locationId: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly safetyBufferMinutes: number;
};

export type PickupWindowInput = {
  readonly locationId: string;
  readonly timeZone: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly minimumLeadMinutes: number;
  readonly maximumAdvanceMinutes: number;
  readonly orderCutoffAtMs: number | null;
  readonly mobileStop?: MobileStopWindow;
};

export type ValidatedPickupWindow = Readonly<{
  locationId: string;
  timeZone: string;
  startsAtMs: number;
  endsAtMs: number;
  orderCutoffAtMs: number | null;
  mobileStop: MobileStopWindow | null;
}>;

export type MoneyComponentInput = {
  readonly code: string;
  readonly label: string;
  readonly amountMinor: number;
};

export type DiscountComponentInput = MoneyComponentInput & {
  readonly fundedBy: 'merchant' | 'spottr';
};

export type TaxInput = {
  /** Opaque reference returned by the approved external/configured tax authority. */
  readonly calculationReference: string;
  readonly source: string;
  readonly lines: readonly MoneyComponentInput[];
};

export type BuildPickupQuoteInput = {
  readonly quoteId: string;
  readonly quoteVersion: number;
  readonly businessId: string;
  readonly catalogVersionId: string;
  readonly pricingVersionId: string;
  readonly termsVersion: string;
  readonly refundPolicyVersion: string;
  readonly currency: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly acceptanceMode: AcceptanceMode;
  readonly pickupWindow: PickupWindowInput;
  readonly availability: OrderingAvailabilitySnapshot;
  readonly lines: readonly QuoteLineIntent[];
  readonly discounts: readonly DiscountComponentInput[];
  /** Tax amounts are supplied by an approved authority; this module never derives tax. */
  readonly tax: TaxInput;
  readonly gratuityMinor: number;
  readonly consumerFees: readonly MoneyComponentInput[];
};

export type QuotedOptionSnapshot = Readonly<{
  optionId: string;
  optionVersionId: string;
  optionGroupId: string;
  optionGroupVersionId: string;
  name: string;
  priceDeltaMinor: number;
}>;

export type QuotedLineSnapshot = Readonly<{
  lineId: string;
  itemId: string;
  itemVersionId: string;
  catalogVersionId: string;
  name: string;
  currency: string;
  quantity: number;
  baseUnitPriceMinor: number;
  selectedOptions: readonly QuotedOptionSnapshot[];
  optionUnitTotalMinor: number;
  unitTotalMinor: number;
  lineSubtotalMinor: number;
}>;

export type PickupQuote = Readonly<{
  quoteId: string;
  quoteVersion: number;
  businessId: string;
  catalogVersionId: string;
  availabilityRevision: number;
  pricingVersionId: string;
  termsVersion: string;
  refundPolicyVersion: string;
  currency: string;
  createdAtMs: number;
  expiresAtMs: number;
  acceptanceMode: AcceptanceMode;
  pickupWindow: ValidatedPickupWindow;
  lines: readonly QuotedLineSnapshot[];
  discounts: readonly DiscountComponentInput[];
  tax: Readonly<TaxInput>;
  consumerFees: readonly MoneyComponentInput[];
  totals: Readonly<{
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    gratuityMinor: number;
    consumerFeeMinor: number;
    totalMinor: number;
  }>;
}>;

export type FulfillmentState =
  | 'accepted'
  | 'cancelled'
  | 'completed'
  | 'pending_acceptance'
  | 'preparing'
  | 'ready'
  | 'rejected';

export type PaymentState =
  | 'authorized'
  | 'captured'
  | 'created'
  | 'disputed'
  | 'failed'
  | 'partially_refunded'
  | 'refunded'
  | 'requires_action'
  | 'voided';

export type RefundState =
  | 'approved'
  | 'cancelled'
  | 'failed'
  | 'requested'
  | 'submitted'
  | 'succeeded';

export type TransitionActor =
  | 'customer'
  | 'merchant'
  | 'payment_provider'
  | 'support'
  | 'system';

export type StateTransition<State extends string> = Readonly<{
  previousState: State;
  nextState: State;
  actor: TransitionActor;
  occurredAtMs: number;
  reasonCode: string | null;
}>;

export type RefundAllocationInput = {
  readonly itemsMinor: number;
  readonly taxMinor: number;
  readonly gratuityMinor: number;
  readonly consumerFeesMinor: number;
};

export type RefundPlan = Readonly<{
  amountMinor: number;
  allocation: Readonly<RefundAllocationInput>;
  previouslyRefundedMinor: number;
  cumulativeRefundedMinor: number;
  remainingAfterRefundMinor: number;
  projectedPaymentState: 'partially_refunded' | 'refunded';
}>;

export type CheckoutIntentFingerprintInput = {
  readonly actorPublicId: string;
  readonly quoteId: string;
  readonly quoteVersion: number;
  readonly businessId: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly locationId: string;
  readonly pickupStartsAtMs: number;
  readonly pickupEndsAtMs: number;
  readonly paymentMethodKind: string;
  readonly termsVersion: string;
  readonly refundPolicyVersion: string;
};

export type Sha256HexDigest = (canonicalIntent: string) => Promise<string> | string;

function invariant(
  code: OrderingInvariantCode,
  message: string,
  context: Record<string, InvariantContextValue> = {}
): never {
  throw new OrderingInvariantError(code, message, context);
}

function identifier(value: unknown, label: string, maximumLength = 160): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invariant('INVALID_IDENTIFIER', `${label} is invalid`, { label });
  }
  return value;
}

function displayText(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > maximumLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    invariant('INVALID_MENU_SNAPSHOT', `${label} is invalid`, { label });
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invariant('INVALID_MENU_SNAPSHOT', `${label} must be a non-negative integer`, {
      label,
    });
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) {
    invariant('INVALID_MENU_SNAPSHOT', `${label} must be positive`, { label });
  }
  return parsed;
}

function minorUnit(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invariant('INVALID_MINOR_UNIT', `${label} must be a non-negative safe integer`, {
      label,
    });
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invariant('PICKUP_WINDOW_INVALID', `${label} must be an epoch-millisecond integer`, {
      label,
    });
  }
  return value as number;
}

function currencyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    invariant('CURRENCY_MISMATCH', 'Currency must be a three-letter uppercase code');
  }
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    invariant('MONEY_OVERFLOW', `${label} exceeds safe integer precision`, { label });
  }
  return result;
}

function checkedSubtract(left: number, right: number, label: string): number {
  const result = left - right;
  if (!Number.isSafeInteger(result) || result < 0) {
    invariant('INVALID_MINOR_UNIT', `${label} cannot be negative`, { label });
  }
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    invariant('MONEY_OVERFLOW', `${label} exceeds safe integer precision`, { label });
  }
  return result;
}

function sumMinor(values: readonly number[], label: string): number {
  return values.reduce((total, value) => checkedAdd(total, value, label), 0);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function normalizeComponents<T extends MoneyComponentInput>(
  components: readonly T[],
  label: string
): T[] {
  if (!Array.isArray(components) || components.length > 50) {
    invariant('INVALID_MINOR_UNIT', `${label} must contain at most 50 lines`, { label });
  }
  const seen = new Set<string>();
  return components.map((component) => {
    const code = identifier(component.code, `${label} code`, 80);
    if (seen.has(code)) {
      invariant('INVALID_MINOR_UNIT', `${label} contains a duplicate code`, { code });
    }
    seen.add(code);
    displayText(component.label, `${label} label`, 120);
    minorUnit(component.amountMinor, `${label} amount`);
    return { ...component };
  });
}

function availabilityState(value: unknown, label: string): AvailabilityState {
  if (value !== 'available' && value !== 'hidden' && value !== 'sold_out') {
    invariant('INVALID_MENU_SNAPSHOT', `${label} has an invalid availability state`, {
      label,
    });
  }
  return value;
}

export function validatePickupWindow(
  input: PickupWindowInput,
  nowMs: number
): ValidatedPickupWindow {
  const now = timestamp(nowMs, 'Current time');
  const locationId = identifier(input.locationId, 'Pickup location');
  const timeZone = identifier(input.timeZone, 'Pickup timezone', 80);
  const startsAtMs = timestamp(input.startsAtMs, 'Pickup start');
  const endsAtMs = timestamp(input.endsAtMs, 'Pickup end');
  const minimumLeadMinutes = nonNegativeInteger(
    input.minimumLeadMinutes,
    'Minimum pickup lead minutes'
  );
  const maximumAdvanceMinutes = nonNegativeInteger(
    input.maximumAdvanceMinutes,
    'Maximum pickup advance minutes'
  );

  if (endsAtMs <= startsAtMs || maximumAdvanceMinutes < minimumLeadMinutes) {
    invariant('PICKUP_WINDOW_INVALID', 'Pickup window bounds are invalid');
  }

  const minimumStart = checkedAdd(
    now,
    checkedMultiply(minimumLeadMinutes, 60_000, 'Pickup lead duration'),
    'Minimum pickup start'
  );
  const maximumEnd = checkedAdd(
    now,
    checkedMultiply(maximumAdvanceMinutes, 60_000, 'Pickup advance duration'),
    'Maximum pickup end'
  );
  if (startsAtMs < minimumStart || endsAtMs > maximumEnd) {
    invariant('PICKUP_WINDOW_INVALID', 'Pickup window is outside allowed lead time');
  }

  let orderCutoffAtMs: number | null = null;
  if (input.orderCutoffAtMs !== null) {
    orderCutoffAtMs = timestamp(input.orderCutoffAtMs, 'Order cutoff');
    if (orderCutoffAtMs > startsAtMs || now > orderCutoffAtMs) {
      invariant('PICKUP_WINDOW_INVALID', 'The pickup order cutoff has passed or is invalid');
    }
  }

  let mobileStop: MobileStopWindow | null = null;
  if (input.mobileStop) {
    const stopId = identifier(input.mobileStop.stopId, 'Mobile stop');
    const stopLocationId = identifier(
      input.mobileStop.locationId,
      'Mobile stop location'
    );
    const stopStartsAtMs = timestamp(input.mobileStop.startsAtMs, 'Mobile stop start');
    const stopEndsAtMs = timestamp(input.mobileStop.endsAtMs, 'Mobile stop end');
    const safetyBufferMinutes = nonNegativeInteger(
      input.mobileStop.safetyBufferMinutes,
      'Mobile stop safety buffer'
    );
    const bufferMs = checkedMultiply(
      safetyBufferMinutes,
      60_000,
      'Mobile stop safety buffer'
    );
    const safeStopEnd = stopEndsAtMs - bufferMs;

    if (
      stopEndsAtMs <= stopStartsAtMs ||
      safeStopEnd < stopStartsAtMs ||
      stopLocationId !== locationId ||
      startsAtMs < stopStartsAtMs ||
      endsAtMs > safeStopEnd
    ) {
      invariant(
        'PICKUP_WINDOW_INVALID',
        'Pickup window is not contained within the mobile stop safety window',
        { stopId }
      );
    }
    mobileStop = {
      stopId,
      locationId: stopLocationId,
      startsAtMs: stopStartsAtMs,
      endsAtMs: stopEndsAtMs,
      safetyBufferMinutes,
    };
  }

  return deepFreeze({
    locationId,
    timeZone,
    startsAtMs,
    endsAtMs,
    orderCutoffAtMs,
    mobileStop,
  });
}

function uniqueMap<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  label: string
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    const entryKey = identifier(key(entry), label);
    if (result.has(entryKey)) {
      invariant('INVALID_MENU_SNAPSHOT', `${label} is duplicated`, { id: entryKey });
    }
    result.set(entryKey, entry);
  }
  return result;
}

function validateAvailabilityBinding(
  input: BuildPickupQuoteInput,
  pickupWindow: ValidatedPickupWindow
) {
  const availability = input.availability;
  if (
    identifier(availability.businessId, 'Availability business') !== input.businessId ||
    identifier(availability.locationId, 'Availability location') !==
      pickupWindow.locationId ||
    identifier(availability.catalogVersionId, 'Availability catalog') !==
      input.catalogVersionId
  ) {
    invariant('INVALID_MENU_SNAPSHOT', 'Availability snapshot does not match the quote');
  }
  positiveInteger(availability.revision, 'Availability revision');
  if (!availability.acceptingOrders) {
    invariant('BUSINESS_NOT_ACCEPTING', 'The business is not accepting pickup orders');
  }

  const maximum = nonNegativeInteger(
    availability.capacity.maximumActiveOrders,
    'Maximum active orders'
  );
  const accepted = nonNegativeInteger(
    availability.capacity.acceptedOrders,
    'Accepted order count'
  );
  const reserved = nonNegativeInteger(
    availability.capacity.reservedOrders,
    'Reserved order count'
  );
  if (accepted > maximum || reserved > maximum || accepted + reserved >= maximum) {
    invariant('CAPACITY_UNAVAILABLE', 'No pickup-order capacity remains');
  }
}

function normalizeQuoteLines(
  input: BuildPickupQuoteInput
): { lines: QuotedLineSnapshot[]; subtotalMinor: number } {
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > MAX_QUOTE_LINES) {
    invariant('INVALID_MENU_SNAPSHOT', `A quote must contain 1-${MAX_QUOTE_LINES} lines`);
  }

  const itemAvailability = uniqueMap(
    input.availability.items,
    (entry) => entry.itemVersionId,
    'Item availability version'
  );
  const optionAvailability = uniqueMap(
    input.availability.options,
    (entry) => entry.optionVersionId,
    'Option availability version'
  );
  const lineIds = new Set<string>();
  const requestedItemQuantities = new Map<string, number>();

  const lines = input.lines.map((line): QuotedLineSnapshot => {
    const lineId = identifier(line.lineId, 'Cart line');
    if (lineIds.has(lineId)) {
      invariant('INVALID_MENU_SNAPSHOT', 'Cart line identifiers must be unique', { lineId });
    }
    lineIds.add(lineId);

    const item = line.item;
    const itemId = identifier(item.itemId, 'Menu item');
    const itemVersionId = identifier(item.itemVersionId, 'Menu item version');
    const catalogVersionId = identifier(item.catalogVersionId, 'Catalog version');
    if (catalogVersionId !== input.catalogVersionId) {
      invariant('INVALID_MENU_SNAPSHOT', 'Menu item belongs to a different catalog version', {
        itemVersionId,
      });
    }
    displayText(item.name, 'Menu item name', 120);
    const itemCurrency = currencyCode(item.currency);
    if (itemCurrency !== input.currency) {
      invariant('CURRENCY_MISMATCH', 'All menu items must match the quote currency', {
        itemVersionId,
      });
    }
    const baseUnitPriceMinor = minorUnit(item.unitPriceMinor, 'Menu item unit price');
    const maximumQuantity = positiveInteger(item.maximumQuantity, 'Maximum item quantity');
    const quantity = positiveInteger(line.quantity, 'Cart item quantity');
    if (quantity > maximumQuantity || !item.orderable) {
      invariant('ITEM_UNAVAILABLE', 'Menu item is not orderable in the requested quantity', {
        itemVersionId,
      });
    }

    const currentItem = itemAvailability.get(itemVersionId);
    if (!currentItem) {
      invariant('ITEM_UNAVAILABLE', 'Menu item has no current availability snapshot', {
        itemVersionId,
      });
    }
    availabilityState(currentItem.state, 'Menu item');
    positiveInteger(currentItem.revision, 'Menu item availability revision');
    nonNegativeInteger(currentItem.reservedQuantity, 'Reserved item quantity');
    if (currentItem.state !== 'available') {
      invariant('ITEM_UNAVAILABLE', 'Menu item is unavailable', { itemVersionId });
    }
    if (currentItem.onHandQuantity !== null) {
      const onHand = nonNegativeInteger(currentItem.onHandQuantity, 'On-hand item quantity');
      if (currentItem.reservedQuantity > onHand) {
        invariant('INVALID_MENU_SNAPSHOT', 'Reserved inventory exceeds on-hand inventory', {
          itemVersionId,
        });
      }
    }

    const groupVersions = uniqueMap<MenuOptionGroupVersionSnapshot>(
      item.optionGroups,
      (group) => group.optionGroupVersionId,
      'Option group version'
    );
    const selectionsByGroup = new Map<string, SelectedOptionIntent[]>();
    const selectedPairs = new Set<string>();
    for (const selection of line.selectedOptions) {
      const groupVersionId = identifier(
        selection.optionGroupVersionId,
        'Selected option group version'
      );
      const optionVersionId = identifier(
        selection.optionVersionId,
        'Selected option version'
      );
      if (!groupVersions.has(groupVersionId)) {
        invariant('INVALID_MENU_SNAPSHOT', 'Selected option group is not on the item', {
          groupVersionId,
        });
      }
      const pair = `${groupVersionId}\u0000${optionVersionId}`;
      if (selectedPairs.has(pair)) {
        invariant('INVALID_MENU_SNAPSHOT', 'The same modifier cannot be selected twice', {
          optionVersionId,
        });
      }
      selectedPairs.add(pair);
      const selections = selectionsByGroup.get(groupVersionId) ?? [];
      selections.push(selection);
      selectionsByGroup.set(groupVersionId, selections);
    }

    const selectedOptions: QuotedOptionSnapshot[] = [];
    for (const group of groupVersions.values()) {
      const optionGroupId = identifier(group.optionGroupId, 'Option group');
      const optionGroupVersionId = identifier(
        group.optionGroupVersionId,
        'Option group version'
      );
      displayText(group.name, 'Option group name', 120);
      const minimum = nonNegativeInteger(group.minimumSelections, 'Minimum modifier selections');
      const maximum = nonNegativeInteger(group.maximumSelections, 'Maximum modifier selections');
      const options = uniqueMap<MenuOptionVersionSnapshot>(
        group.options,
        (option) => option.optionVersionId,
        'Option version'
      );
      if (minimum > maximum || maximum > options.size) {
        invariant('INVALID_MENU_SNAPSHOT', 'Modifier selection bounds are invalid', {
          optionGroupVersionId,
        });
      }
      const selections = selectionsByGroup.get(optionGroupVersionId) ?? [];
      if (selections.length < minimum || selections.length > maximum) {
        invariant('OPTION_UNAVAILABLE', 'Required modifier selections are incomplete', {
          optionGroupVersionId,
        });
      }

      for (const selection of selections) {
        const option = options.get(selection.optionVersionId);
        if (!option || !option.orderable) {
          invariant('OPTION_UNAVAILABLE', 'Selected modifier is not orderable', {
            optionVersionId: selection.optionVersionId,
          });
        }
        const currentOption = optionAvailability.get(option.optionVersionId);
        if (!currentOption) {
          invariant('OPTION_UNAVAILABLE', 'Selected modifier has no availability snapshot', {
            optionVersionId: option.optionVersionId,
          });
        }
        availabilityState(currentOption.state, 'Menu option');
        positiveInteger(currentOption.revision, 'Menu option availability revision');
        if (currentOption.state !== 'available') {
          invariant('OPTION_UNAVAILABLE', 'Selected modifier is unavailable', {
            optionVersionId: option.optionVersionId,
          });
        }
        const optionId = identifier(option.optionId, 'Menu option');
        displayText(option.name, 'Menu option name', 120);
        const priceDeltaMinor = minorUnit(option.priceDeltaMinor, 'Modifier price delta');
        selectedOptions.push({
          optionId,
          optionVersionId: option.optionVersionId,
          optionGroupId,
          optionGroupVersionId,
          name: option.name,
          priceDeltaMinor,
        });
      }
    }

    const requested = checkedAdd(
      requestedItemQuantities.get(itemVersionId) ?? 0,
      quantity,
      'Requested item quantity'
    );
    requestedItemQuantities.set(itemVersionId, requested);
    const optionUnitTotalMinor = sumMinor(
      selectedOptions.map((option) => option.priceDeltaMinor),
      'Modifier unit total'
    );
    const unitTotalMinor = checkedAdd(
      baseUnitPriceMinor,
      optionUnitTotalMinor,
      'Item unit total'
    );
    const lineSubtotalMinor = checkedMultiply(quantity, unitTotalMinor, 'Item line subtotal');

    return {
      lineId,
      itemId,
      itemVersionId,
      catalogVersionId,
      name: item.name,
      currency: itemCurrency,
      quantity,
      baseUnitPriceMinor,
      selectedOptions,
      optionUnitTotalMinor,
      unitTotalMinor,
      lineSubtotalMinor,
    };
  });

  for (const [itemVersionId, requestedQuantity] of requestedItemQuantities) {
    const current = itemAvailability.get(itemVersionId)!;
    if (current.onHandQuantity !== null) {
      const remaining = checkedSubtract(
        current.onHandQuantity,
        current.reservedQuantity,
        'Remaining item inventory'
      );
      if (requestedQuantity > remaining) {
        invariant('INVENTORY_UNAVAILABLE', 'Insufficient item inventory remains', {
          itemVersionId,
          requestedQuantity,
          remainingQuantity: remaining,
        });
      }
    }
  }

  return {
    lines,
    subtotalMinor: sumMinor(
      lines.map((line) => line.lineSubtotalMinor),
      'Quote subtotal'
    ),
  };
}

export function buildPickupQuote(input: BuildPickupQuoteInput): PickupQuote {
  const quoteId = identifier(input.quoteId, 'Quote');
  const quoteVersion = positiveInteger(input.quoteVersion, 'Quote version');
  const businessId = identifier(input.businessId, 'Business');
  const catalogVersionId = identifier(input.catalogVersionId, 'Catalog version');
  const pricingVersionId = identifier(input.pricingVersionId, 'Pricing version');
  const termsVersion = identifier(input.termsVersion, 'Terms version', 80);
  const refundPolicyVersion = identifier(
    input.refundPolicyVersion,
    'Refund policy version',
    80
  );
  const currency = currencyCode(input.currency);
  const createdAtMs = timestamp(input.createdAtMs, 'Quote creation time');
  const expiresAtMs = timestamp(input.expiresAtMs, 'Quote expiry time');
  if (input.acceptanceMode !== 'automatic' && input.acceptanceMode !== 'manual') {
    invariant('INVALID_MENU_SNAPSHOT', 'Merchant acceptance mode is invalid');
  }

  const pickupWindow = validatePickupWindow(input.pickupWindow, createdAtMs);
  if (expiresAtMs <= createdAtMs || expiresAtMs > pickupWindow.startsAtMs) {
    invariant('PICKUP_WINDOW_INVALID', 'Quote expiry must precede pickup');
  }
  validateAvailabilityBinding(
    { ...input, businessId, catalogVersionId, currency },
    pickupWindow
  );

  const normalized = normalizeQuoteLines({
    ...input,
    businessId,
    catalogVersionId,
    currency,
  });
  const discounts = normalizeComponents(input.discounts, 'Discount');
  for (const discount of discounts) {
    if (discount.fundedBy !== 'merchant' && discount.fundedBy !== 'spottr') {
      invariant('INVALID_MINOR_UNIT', 'Discount funding source is invalid', {
        code: discount.code,
      });
    }
  }
  const discountMinor = sumMinor(
    discounts.map((discount) => discount.amountMinor),
    'Discount total'
  );
  if (discountMinor > normalized.subtotalMinor) {
    invariant('INVALID_MINOR_UNIT', 'Discounts cannot exceed the item subtotal');
  }

  const taxCalculationReference = identifier(
    input.tax.calculationReference,
    'Tax calculation reference'
  );
  const taxSource = identifier(input.tax.source, 'Tax calculation source', 80);
  const taxLines = normalizeComponents(input.tax.lines, 'Tax');
  const taxMinor = sumMinor(
    taxLines.map((line) => line.amountMinor),
    'Tax total'
  );
  const gratuityMinor = minorUnit(input.gratuityMinor, 'Gratuity');
  const consumerFees = normalizeComponents(input.consumerFees, 'Consumer fee');
  const consumerFeeMinor = sumMinor(
    consumerFees.map((fee) => fee.amountMinor),
    'Consumer fee total'
  );

  const afterDiscount = checkedSubtract(
    normalized.subtotalMinor,
    discountMinor,
    'Subtotal after discount'
  );
  const totalMinor = [taxMinor, gratuityMinor, consumerFeeMinor].reduce(
    (total, amount) => checkedAdd(total, amount, 'Quote total'),
    afterDiscount
  );

  return deepFreeze({
    quoteId,
    quoteVersion,
    businessId,
    catalogVersionId,
    availabilityRevision: input.availability.revision,
    pricingVersionId,
    termsVersion,
    refundPolicyVersion,
    currency,
    createdAtMs,
    expiresAtMs,
    acceptanceMode: input.acceptanceMode,
    pickupWindow,
    lines: normalized.lines,
    discounts,
    tax: {
      calculationReference: taxCalculationReference,
      source: taxSource,
      lines: taxLines,
    },
    consumerFees,
    totals: {
      subtotalMinor: normalized.subtotalMinor,
      discountMinor,
      taxMinor,
      gratuityMinor,
      consumerFeeMinor,
      totalMinor,
    },
  });
}

const fulfillmentRules: Record<
  FulfillmentState,
  Partial<Record<FulfillmentState, readonly TransitionActor[]>>
> = {
  pending_acceptance: {
    accepted: ['merchant', 'system'],
    cancelled: ['customer', 'support', 'system'],
    rejected: ['merchant', 'system'],
  },
  accepted: {
    cancelled: ['merchant', 'support', 'system'],
    preparing: ['merchant'],
  },
  preparing: {
    cancelled: ['merchant', 'support', 'system'],
    ready: ['merchant'],
  },
  ready: {
    cancelled: ['merchant', 'support', 'system'],
    completed: ['merchant', 'system'],
  },
  cancelled: {},
  completed: {},
  rejected: {},
};

const paymentRules: Record<
  PaymentState,
  Partial<Record<PaymentState, readonly TransitionActor[]>>
> = {
  created: {
    authorized: ['payment_provider', 'system'],
    failed: ['payment_provider', 'system'],
    requires_action: ['payment_provider', 'system'],
  },
  requires_action: {
    authorized: ['payment_provider', 'system'],
    failed: ['payment_provider', 'system'],
    voided: ['payment_provider', 'system'],
  },
  authorized: {
    captured: ['payment_provider', 'system'],
    failed: ['payment_provider', 'system'],
    voided: ['payment_provider', 'system'],
  },
  captured: {
    disputed: ['payment_provider'],
    partially_refunded: ['payment_provider', 'system'],
    refunded: ['payment_provider', 'system'],
  },
  partially_refunded: {
    disputed: ['payment_provider'],
    refunded: ['payment_provider', 'system'],
  },
  disputed: {},
  failed: {},
  refunded: {},
  voided: {},
};

const refundRules: Record<
  RefundState,
  Partial<Record<RefundState, readonly TransitionActor[]>>
> = {
  requested: {
    approved: ['merchant', 'support', 'system'],
    cancelled: ['merchant', 'support', 'system'],
  },
  approved: {
    cancelled: ['support', 'system'],
    submitted: ['system'],
  },
  submitted: {
    failed: ['payment_provider', 'system'],
    succeeded: ['payment_provider', 'system'],
  },
  failed: {
    cancelled: ['support', 'system'],
    submitted: ['system'],
  },
  cancelled: {},
  succeeded: {},
};

function transition<State extends string>(
  rules: Record<State, Partial<Record<State, readonly TransitionActor[]>>>,
  currentState: State,
  nextState: State,
  actor: TransitionActor,
  occurredAtMs: number,
  reasonCode: string | null
): StateTransition<State> {
  if (!Object.prototype.hasOwnProperty.call(rules, currentState)) {
    invariant('INVALID_TRANSITION', 'Current state is invalid', { currentState });
  }
  const allowedActors = rules[currentState][nextState];
  if (!allowedActors) {
    invariant('INVALID_TRANSITION', 'State transition is not allowed', {
      currentState,
      nextState,
    });
  }
  if (!allowedActors.includes(actor)) {
    invariant('TRANSITION_NOT_AUTHORIZED', 'Actor cannot perform this state transition', {
      actor,
      currentState,
      nextState,
    });
  }
  const occurredAt = timestamp(occurredAtMs, 'Transition time');
  return deepFreeze({
    previousState: currentState,
    nextState,
    actor,
    occurredAtMs: occurredAt,
    reasonCode: reasonCode === null ? null : identifier(reasonCode, 'Transition reason', 80),
  });
}

export function transitionFulfillmentState(input: {
  currentState: FulfillmentState;
  nextState: FulfillmentState;
  actor: TransitionActor;
  occurredAtMs: number;
  reasonCode?: string | null;
  policyAuthorized?: boolean;
}): StateTransition<FulfillmentState> {
  const reasonCode = input.reasonCode ?? null;
  if (
    (input.nextState === 'cancelled' || input.nextState === 'rejected') &&
    reasonCode === null
  ) {
    invariant('INVALID_TRANSITION', 'Cancellation and rejection require a reason code');
  }
  if (
    input.nextState === 'cancelled' &&
    input.currentState !== 'pending_acceptance' &&
    input.policyAuthorized !== true
  ) {
    invariant(
      'TRANSITION_NOT_AUTHORIZED',
      'Cancelling an accepted order requires policy authorization'
    );
  }
  return transition(
    fulfillmentRules,
    input.currentState,
    input.nextState,
    input.actor,
    input.occurredAtMs,
    reasonCode
  );
}

export function transitionPaymentState(input: {
  currentState: PaymentState;
  nextState: PaymentState;
  actor: TransitionActor;
  occurredAtMs: number;
  reasonCode?: string | null;
}): StateTransition<PaymentState> {
  const reasonCode = input.reasonCode ?? null;
  if (
    ['disputed', 'failed', 'partially_refunded', 'refunded', 'voided'].includes(
      input.nextState
    ) &&
    reasonCode === null
  ) {
    invariant('INVALID_TRANSITION', 'This payment transition requires a reason code');
  }
  return transition(
    paymentRules,
    input.currentState,
    input.nextState,
    input.actor,
    input.occurredAtMs,
    reasonCode
  );
}

export function transitionRefundState(input: {
  currentState: RefundState;
  nextState: RefundState;
  actor: TransitionActor;
  occurredAtMs: number;
  reasonCode?: string | null;
}): StateTransition<RefundState> {
  const reasonCode = input.reasonCode ?? null;
  if ((input.nextState === 'cancelled' || input.nextState === 'failed') && !reasonCode) {
    invariant('INVALID_TRANSITION', 'Cancelled and failed refunds require a reason code');
  }
  return transition(
    refundRules,
    input.currentState,
    input.nextState,
    input.actor,
    input.occurredAtMs,
    reasonCode
  );
}

export function planRefund(input: {
  capturedTotalMinor: number;
  previouslyRefundedMinor: number;
  paymentState: PaymentState;
  amountMinor: number;
  allocation: RefundAllocationInput;
}): RefundPlan {
  const capturedTotalMinor = minorUnit(input.capturedTotalMinor, 'Captured total');
  const previouslyRefundedMinor = minorUnit(
    input.previouslyRefundedMinor,
    'Previously refunded total'
  );
  const amountMinor = minorUnit(input.amountMinor, 'Refund amount');
  if (capturedTotalMinor < 1 || amountMinor < 1 || previouslyRefundedMinor >= capturedTotalMinor) {
    invariant('REFUND_INVALID', 'Refund totals are invalid');
  }
  if (
    (previouslyRefundedMinor === 0 && input.paymentState !== 'captured') ||
    (previouslyRefundedMinor > 0 && input.paymentState !== 'partially_refunded')
  ) {
    invariant('REFUND_INVALID', 'Payment state does not match prior refunds', {
      paymentState: input.paymentState,
    });
  }

  const allocation = {
    itemsMinor: minorUnit(input.allocation.itemsMinor, 'Refund item allocation'),
    taxMinor: minorUnit(input.allocation.taxMinor, 'Refund tax allocation'),
    gratuityMinor: minorUnit(input.allocation.gratuityMinor, 'Refund gratuity allocation'),
    consumerFeesMinor: minorUnit(
      input.allocation.consumerFeesMinor,
      'Refund consumer-fee allocation'
    ),
  };
  const allocationTotal = sumMinor(
    [
      allocation.itemsMinor,
      allocation.taxMinor,
      allocation.gratuityMinor,
      allocation.consumerFeesMinor,
    ],
    'Refund allocation total'
  );
  if (allocationTotal !== amountMinor) {
    invariant('REFUND_INVALID', 'Refund allocations must equal the refund amount');
  }

  const remainingBeforeRefund = checkedSubtract(
    capturedTotalMinor,
    previouslyRefundedMinor,
    'Remaining refundable amount'
  );
  if (amountMinor > remainingBeforeRefund) {
    invariant('REFUND_INVALID', 'Refund exceeds the remaining captured amount');
  }
  const cumulativeRefundedMinor = checkedAdd(
    previouslyRefundedMinor,
    amountMinor,
    'Cumulative refund amount'
  );
  const remainingAfterRefundMinor = checkedSubtract(
    capturedTotalMinor,
    cumulativeRefundedMinor,
    'Amount after refund'
  );

  return deepFreeze({
    amountMinor,
    allocation,
    previouslyRefundedMinor,
    cumulativeRefundedMinor,
    remainingAfterRefundMinor,
    projectedPaymentState:
      remainingAfterRefundMinor === 0 ? 'refunded' : 'partially_refunded',
  });
}

export function canonicalizeCheckoutIntent(input: CheckoutIntentFingerprintInput): string {
  const actorPublicId = identifier(input.actorPublicId, 'Checkout actor');
  const quoteId = identifier(input.quoteId, 'Checkout quote');
  const quoteVersion = positiveInteger(input.quoteVersion, 'Checkout quote version');
  const businessId = identifier(input.businessId, 'Checkout business');
  const totalMinor = minorUnit(input.totalMinor, 'Checkout total');
  const currency = currencyCode(input.currency);
  const locationId = identifier(input.locationId, 'Checkout location');
  const pickupStartsAtMs = timestamp(input.pickupStartsAtMs, 'Checkout pickup start');
  const pickupEndsAtMs = timestamp(input.pickupEndsAtMs, 'Checkout pickup end');
  if (pickupEndsAtMs <= pickupStartsAtMs) {
    invariant('IDEMPOTENCY_INVALID', 'Checkout pickup window is invalid');
  }
  const paymentMethodKind = identifier(
    input.paymentMethodKind,
    'Checkout payment method',
    40
  );
  const termsVersion = identifier(input.termsVersion, 'Checkout terms version', 80);
  const refundPolicyVersion = identifier(
    input.refundPolicyVersion,
    'Checkout refund policy version',
    80
  );

  // A tuple makes field order explicit and prevents object-property order from
  // changing an otherwise identical intent fingerprint.
  return JSON.stringify([
    'spottr.checkout.intent.v1',
    actorPublicId,
    quoteId,
    quoteVersion,
    businessId,
    totalMinor,
    currency,
    locationId,
    pickupStartsAtMs,
    pickupEndsAtMs,
    paymentMethodKind,
    termsVersion,
    refundPolicyVersion,
  ]);
}

export async function createCheckoutIntentFingerprint(
  input: CheckoutIntentFingerprintInput,
  sha256HexDigest: Sha256HexDigest
): Promise<string> {
  if (typeof sha256HexDigest !== 'function') {
    invariant('IDEMPOTENCY_INVALID', 'A trusted SHA-256 digest implementation is required');
  }
  const digest = await sha256HexDigest(canonicalizeCheckoutIntent(input));
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/i.test(digest)) {
    invariant('IDEMPOTENCY_INVALID', 'SHA-256 digest must be exactly 64 hexadecimal characters');
  }
  return `spottr:place_order:v1:${digest.toLowerCase()}`;
}
