export const PAYMENT_CONNECT_MAX_BYTES = 2048;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class PaymentConnectContractError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type PaymentConnectCommand =
  | Readonly<{ action: 'start'; businessId: string; country: string }>
  | Readonly<{ action: 'status'; businessId: string }>
  | Readonly<{ action: 'set_acceptance'; businessId: string; accepted: boolean }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentConnectContractError('INVALID_PAYMENT_CONNECT_REQUEST');
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PaymentConnectContractError('INVALID_PAYMENT_CONNECT_REQUEST');
  }
}

function businessId(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !uuidPattern.test(value)) {
    throw new PaymentConnectContractError('INVALID_PAYMENT_CONNECT_REQUEST');
  }
  return value;
}

export function parsePaymentConnectCommand(value: unknown): PaymentConnectCommand {
  const row = object(value);
  if (row.action === 'status') {
    exactKeys(row, ['action', 'businessId']);
    return Object.freeze({ action: 'status', businessId: businessId(row.businessId) });
  }
  if (row.action === 'set_acceptance') {
    exactKeys(row, ['action', 'businessId', 'accepted']);
    if (typeof row.accepted !== 'boolean') throw new PaymentConnectContractError('INVALID_PAYMENT_CONNECT_REQUEST');
    return Object.freeze({ action: 'set_acceptance', businessId: businessId(row.businessId), accepted: row.accepted });
  }
  if (row.action === 'start') {
    exactKeys(row, ['action', 'businessId', 'country']);
    if (typeof row.country !== 'string' || !/^[A-Z]{2}$/.test(row.country)) {
      throw new PaymentConnectContractError('INVALID_PAYMENT_CONNECT_REQUEST');
    }
    return Object.freeze({ action: 'start', businessId: businessId(row.businessId), country: row.country });
  }
  throw new PaymentConnectContractError('INVALID_PAYMENT_CONNECT_REQUEST');
}
