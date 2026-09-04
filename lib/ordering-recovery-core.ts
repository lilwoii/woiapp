import type { ShadowCancellationAttempt, ShadowPlacementAttempt } from '@/types/ordering';

type RecoveryAdapter = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  runExclusive: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

export type ShadowOrderingRecoveryOperation =
  | Readonly<{ kind: 'cancel'; attempt: ShadowCancellationAttempt }>
  | Readonly<{ kind: 'place'; attempt: ShadowPlacementAttempt }>;

export type ShadowOrderingRecoveryRecord = Readonly<{
  schemaVersion: 1;
  accountId: string;
  businessId: string;
  updatedAt: string;
  operation: ShadowOrderingRecoveryOperation;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumRecordLength = 2_048;

export class OrderingRecoveryError extends Error {}

function recoveryKey(accountId: string, businessId: string) {
  if (!uuidPattern.test(accountId) || !uuidPattern.test(businessId)) {
    throw new OrderingRecoveryError('The secure ordering recovery scope is invalid.');
  }
  return `spottr_shadow_order_recovery_v1_${accountId}_${businessId}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  return value as Record<string, unknown>;
}

function stringValue(row: Record<string, unknown>, key: string, maximum: number) {
  const value = row[key];
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    value !== value.trim() ||
    (/\s/.test(value) && key === 'idempotencyKey')
  ) {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  return value;
}

function uuidValue(row: Record<string, unknown>, key: string) {
  const value = stringValue(row, key, 36);
  if (!uuidPattern.test(value)) {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  return value;
}

function idempotencyKeyValue(row: Record<string, unknown>) {
  const value = stringValue(row, 'idempotencyKey', 128);
  if (value.length < 16) {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  return value;
}

export function parseShadowOrderingRecovery(
  serialized: string,
  expectedAccountId: string,
  expectedBusinessId: string
): ShadowOrderingRecoveryRecord {
  recoveryKey(expectedAccountId, expectedBusinessId);
  if (!serialized || serialized.length > maximumRecordLength) {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  const row = recordValue(parsed);
  if (row.schemaVersion !== 1) {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  const accountId = uuidValue(row, 'accountId');
  const businessId = uuidValue(row, 'businessId');
  const updatedAt = stringValue(row, 'updatedAt', 64);
  if (
    accountId !== expectedAccountId ||
    businessId !== expectedBusinessId ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  const operationRow = recordValue(row.operation);
  const kind = stringValue(operationRow, 'kind', 6);
  const attemptRow = recordValue(operationRow.attempt);
  const idempotencyKey = idempotencyKeyValue(attemptRow);
  let operation: ShadowOrderingRecoveryOperation;
  if (kind === 'place') {
    const operationBusinessId = uuidValue(attemptRow, 'businessId');
    const quotePublicId = uuidValue(attemptRow, 'quotePublicId');
    const quoteVersion = attemptRow.quoteVersion;
    if (
      operationBusinessId !== businessId ||
      typeof quoteVersion !== 'number' ||
      !Number.isSafeInteger(quoteVersion) ||
      quoteVersion < 1 ||
      quoteVersion > 2_147_483_646
    ) {
      throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
    }
    operation = Object.freeze({
      kind,
      attempt: Object.freeze({
        businessId: operationBusinessId,
        quotePublicId,
        quoteVersion,
        idempotencyKey,
      }),
    });
  } else if (kind === 'cancel') {
    const operationBusinessId = uuidValue(attemptRow, 'businessId');
    const orderPublicId = uuidValue(attemptRow, 'orderPublicId');
    const expectedVersion = attemptRow.expectedVersion;
    if (
      operationBusinessId !== businessId ||
      typeof expectedVersion !== 'number' ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion > 2_147_483_646 ||
      attemptRow.reasonCode !== 'customer_cancelled_before_acceptance'
    ) {
      throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
    }
    operation = Object.freeze({
      kind,
      attempt: Object.freeze({
        businessId: operationBusinessId,
        orderPublicId,
        expectedVersion,
        reasonCode: 'customer_cancelled_before_acceptance',
        idempotencyKey,
      }),
    });
  } else {
    throw new OrderingRecoveryError('Stored ordering recovery data is invalid.');
  }
  return Object.freeze({ schemaVersion: 1, accountId, businessId, updatedAt, operation });
}

export function createShadowOrderingRecoveryStore(adapter: RecoveryAdapter) {
  return Object.freeze({
    async load(accountId: string, businessId: string) {
      const serialized = await adapter.getItem(recoveryKey(accountId, businessId));
      return serialized
        ? parseShadowOrderingRecovery(serialized, accountId, businessId)
        : null;
    },

    async save(
      accountId: string,
      businessId: string,
      operation: ShadowOrderingRecoveryOperation
    ) {
      const key = recoveryKey(accountId, businessId);
      const serialized = JSON.stringify({
        schemaVersion: 1,
        accountId,
        businessId,
        updatedAt: new Date().toISOString(),
        operation,
      });
      const record = parseShadowOrderingRecovery(serialized, accountId, businessId);
      return adapter.runExclusive(key, async () => {
        const existingSerialized = await adapter.getItem(key);
        if (existingSerialized) {
          const existing = parseShadowOrderingRecovery(
            existingSerialized,
            accountId,
            businessId
          );
          if (
            existing.operation.attempt.idempotencyKey !==
              record.operation.attempt.idempotencyKey ||
            JSON.stringify(existing.operation) !== JSON.stringify(record.operation)
          ) {
            throw new OrderingRecoveryError(
              'A different ordering operation still needs secure recovery.'
            );
          }
          return existing;
        }
        await adapter.setItem(key, JSON.stringify(record));
        return record;
      });
    },

    async clearIfMatches(
      accountId: string,
      businessId: string,
      expectedIdempotencyKey: string
    ) {
      const key = recoveryKey(accountId, businessId);
      await adapter.runExclusive(key, async () => {
        const serialized = await adapter.getItem(key);
        if (!serialized) return;
        const record = parseShadowOrderingRecovery(serialized, accountId, businessId);
        if (record.operation.attempt.idempotencyKey === expectedIdempotencyKey) {
          await adapter.removeItem(key);
        }
      });
    },
  });
}
