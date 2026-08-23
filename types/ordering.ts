export type ShadowOrderOption = Readonly<{
  optionVersionId: string;
  name: string;
  priceDeltaMinor: number;
  sortOrder: number;
}>;

export type ShadowOrderOptionGroup = Readonly<{
  optionGroupId: string;
  name: string;
  minimumSelections: number;
  maximumSelections: number;
  sortOrder: number;
  options: readonly ShadowOrderOption[];
}>;

export type ShadowOrderMenuItem = Readonly<{
  itemVersionId: string;
  stableItemId: string;
  name: string;
  description: string;
  unitPriceMinor: number;
  maximumQuantity: number;
  allergenNote: string | null;
  sortOrder: number;
  optionGroups: readonly ShadowOrderOptionGroup[];
}>;

export type ShadowPickupWindow = Readonly<{
  capacitySlotId: string;
  locationId: string;
  mobileStopId: string | null;
  startsAt: string;
  endsAt: string;
  remainingCapacity: number;
}>;

export type ShadowOrderableMenu = Readonly<{
  businessId: string;
  catalogVersionId: string;
  catalogVersion: number;
  currency: string;
  acceptanceMode: 'automatic' | 'manual';
  acceptanceTimeoutSeconds: number;
  termsVersion: string;
  refundPolicyVersion: string;
  quoteTtlSeconds: number;
  items: readonly ShadowOrderMenuItem[];
  pickupWindows: readonly ShadowPickupWindow[];
}>;

export type ShadowOrderLineIntent = Readonly<{
  itemVersionId: string;
  quantity: number;
  optionVersionIds: readonly string[];
}>;

export type ShadowQuoteIntent = Readonly<{
  businessId: string;
  capacitySlotId: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  lines: readonly ShadowOrderLineIntent[];
}>;

export type ShadowQuoteAttempt = Readonly<{
  signature: string;
  idempotencyKey: string;
  intent: ShadowQuoteIntent;
}>;

export type ShadowQuotedOption = Readonly<{
  optionVersionId: string;
  name: string;
  priceDeltaMinor: number;
}>;

export type ShadowQuotedLine = Readonly<{
  itemVersionId: string;
  name: string;
  quantity: number;
  baseUnitPriceMinor: number;
  optionUnitTotalMinor: number;
  unitTotalMinor: number;
  lineSubtotalMinor: number;
  allergenNote: string | null;
  options: readonly ShadowQuotedOption[];
}>;

export type ShadowOrderQuote = Readonly<{
  quotePublicId: string;
  quoteVersion: number;
  businessId: string;
  locationId: string;
  mobileStopId: string | null;
  capacitySlotId: string;
  catalogVersionId: string;
  currency: string;
  itemSubtotalMinor: number;
  shadowDiscountMinor: number;
  totalMinor: 0;
  pickupStartsAt: string;
  pickupEndsAt: string;
  expiresAt: string;
  termsVersion: string;
  refundPolicyVersion: string;
  acceptanceMode: 'automatic' | 'manual';
  isShadow: true;
  lines: readonly ShadowQuotedLine[];
}>;

export type ShadowOrderReceipt = Readonly<{
  quotePublicId: string | null;
  quoteVersion: number | null;
  orderPublicId: string;
  version: number;
  fulfillmentState:
    | 'accepted'
    | 'cancelled'
    | 'completed'
    | 'pending_acceptance'
    | 'preparing'
    | 'ready'
    | 'rejected';
  paymentState: 'not_required';
  isShadow: true;
  businessId: string;
  locationId: string;
  mobileStopId: string | null;
  acceptanceMode: 'automatic' | 'manual';
  itemSubtotalMinor: number;
  shadowDiscountMinor: number;
  totalMinor: 0;
  currency: string;
  pickupStartsAt: string;
  pickupEndsAt: string;
  acceptanceExpiresAt: string;
  termsVersion: string;
  refundPolicyVersion: string;
  lines: readonly ShadowQuotedLine[];
}>;

export type ShadowPlacementAttempt = Readonly<{
  businessId: string;
  quotePublicId: string;
  quoteVersion: number;
  idempotencyKey: string;
}>;

export type ShadowCancellationAttempt = Readonly<{
  businessId: string;
  orderPublicId: string;
  expectedVersion: number;
  reasonCode: 'customer_cancelled_before_acceptance';
  idempotencyKey: string;
}>;
