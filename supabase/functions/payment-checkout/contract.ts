export const PAYMENT_CHECKOUT_MAX_BYTES = 12_288;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class PaymentCheckoutContractError extends Error {
  constructor(readonly code: string) { super(code); }
}

type CheckoutLine = Readonly<{ menuItemId: string; quantity: number }>;

export type PaymentCheckoutCommand =
  | Readonly<{
      action: 'create';
      businessId: string;
      locationId: string;
      requestedPickupAt: string;
      lines: readonly CheckoutLine[];
      customerNote: string | null;
      clientPlatform: 'web' | 'mobile';
    }>
  | Readonly<{ action: 'status'; checkoutPublicId: string }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  }
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !uuidPattern.test(value)) {
    throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  }
  return value;
}

export function parsePaymentCheckoutCommand(value: unknown): PaymentCheckoutCommand {
  const row = object(value);
  if (row.action === 'status') {
    exactKeys(row, ['action', 'checkoutPublicId']);
    return Object.freeze({ action: 'status', checkoutPublicId: uuid(row.checkoutPublicId) });
  }
  if (row.action !== 'create') {
    throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  }
  exactKeys(row, [
    'action', 'businessId', 'locationId', 'requestedPickupAt', 'lines', 'customerNote', 'clientPlatform',
  ]);
  if (!Array.isArray(row.lines) || row.lines.length < 1 || row.lines.length > 20) {
    throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  }
  const seen = new Set<string>();
  const lines = row.lines.map((candidate) => {
    const line = object(candidate);
    exactKeys(line, ['menuItemId', 'quantity']);
    const menuItemId = uuid(line.menuItemId);
    if (seen.has(menuItemId) || !Number.isSafeInteger(line.quantity) || (line.quantity as number) < 1 || (line.quantity as number) > 20) {
      throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
    }
    seen.add(menuItemId);
    return Object.freeze({ menuItemId, quantity: line.quantity as number });
  });
  if (
    typeof row.requestedPickupAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.requestedPickupAt) ||
    !Number.isFinite(Date.parse(row.requestedPickupAt))
  ) throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  if (
    row.customerNote !== null &&
    (typeof row.customerNote !== 'string' || row.customerNote !== row.customerNote.trim() || row.customerNote.length < 1 || row.customerNote.length > 240 || /[\u0000-\u001f\u007f]/.test(row.customerNote))
  ) throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  if (row.clientPlatform !== 'web' && row.clientPlatform !== 'mobile') {
    throw new PaymentCheckoutContractError('INVALID_PAYMENT_CHECKOUT_REQUEST');
  }
  return Object.freeze({
    action: 'create',
    businessId: uuid(row.businessId),
    locationId: uuid(row.locationId),
    requestedPickupAt: row.requestedPickupAt,
    lines: Object.freeze(lines),
    customerNote: row.customerNote as string | null,
    clientPlatform: row.clientPlatform,
  });
}
