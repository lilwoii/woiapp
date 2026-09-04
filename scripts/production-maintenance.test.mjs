import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  readMaintenanceConfiguration,
  runProductionMaintenance,
} from './production-maintenance.mjs';

const VALID_ENV = {
  SPOTTR_MAINTENANCE_SUPABASE_URL: 'https://spottr-release.supabase.co',
  SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY: 'service-role-key-that-is-long-enough-for-testing-only',
  SPOTTR_ACCOUNT_DELETE_WORKER_SECRET: 'delete-worker-secret-that-is-long-enough',
  SPOTTR_MEDIA_CLEANUP_SECRET: 'media-cleanup-secret-that-is-long-enough',
  SPOTTR_MAINTENANCE_PUSH_ENABLED: 'false',
  SPOTTR_MAINTENANCE_HEARTBEAT_URL: 'https://heartbeat.example.test/spottr',
};

const PUSH_ENABLED_ENV = {
  ...VALID_ENV,
  SPOTTR_MAINTENANCE_PUSH_ENABLED: 'true',
  SPOTTR_PUSH_DISPATCH_SECRET: 'dispatch-worker-secret-that-is-long-enough',
  SPOTTR_PUSH_RECEIPT_SECRET: 'receipt-worker-secret-that-is-long-enough',
};

const PAYMENTS_ENABLED_ENV = {
  ...VALID_ENV,
  SPOTTR_MAINTENANCE_PAYMENTS_ENABLED: 'true',
  SPOTTR_PAYMENT_REFUND_WORKER_SECRET: 'payment-refund-worker-secret-that-is-long-enough',
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body === null ? '' : JSON.stringify(body),
  };
}

function completeProviderLifecycle() {
  return response({
    sources_marked_stale: 0,
    businesses_archived: 0,
    more_work: false,
    skipped: false,
  });
}

function completeSponsoredReservations() {
  return response({ released: 0, more_work: false, skipped: false });
}

function completeQuoteExpiry() {
  return response({ expired: 0, more_work: false, skipped: false });
}

function completeOrderExpiry() {
  return response({ expired: 0, more_work: false, skipped: false });
}

function completePickupOrderExpiry() {
  return response({ expired: 0, more_work: false });
}

function completePaymentRefunds(overrides = {}) {
  return response({ claimed: 2, succeeded: 1, providerPending: 0, retried: 1, failed: 0, ...overrides });
}

function completePushDispatch(overrides = {}) {
  return response({
    status: 'complete',
    outbox_claimed: 1,
    deliveries_expanded: 2,
    deliveries_claimed: 2,
    accepted: 1,
    unknown: 0,
    retry: 1,
    dead: 0,
    outbox_finalized: 0,
    outbox_finalization_more_work: false,
    unknown_finalized: 0,
    unknown_finalization_more_work: false,
    more_work: false,
    ...overrides,
  });
}

function completePushReceipts(overrides = {}) {
  return response({
    status: 'complete',
    receipts_claimed: 2,
    delivered: 1,
    retry: 0,
    failed: 0,
    invalid: 1,
    receipts_finalized: 0,
    receipt_finalization_more_work: false,
    more_work: false,
    ...overrides,
  });
}

test('maintenance configuration rejects non-HTTPS and non-Supabase origins', () => {
  assert.throws(
    () => readMaintenanceConfiguration({
      ...VALID_ENV,
      SPOTTR_MAINTENANCE_SUPABASE_URL: 'http://spottr-release.supabase.co',
    }),
    /HTTPS/,
  );
  assert.throws(
    () => readMaintenanceConfiguration({
      ...VALID_ENV,
      SPOTTR_MAINTENANCE_SUPABASE_URL: 'https://example.com',
    }),
    /Supabase project origin/,
  );
});

test('maintenance drains bounded deletion work and runs every bounded cleanup', async () => {
  const calls = [];
  const queue = [
    response({ status: 'deleted' }),
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    response(null),
  ];
  const summary = await runProductionMaintenance({
    config: readMaintenanceConfiguration(VALID_ENV),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return queue.shift();
    },
    log: () => {},
  });

  assert.equal(summary.deletionCalls, 2);
  assert.equal(summary.deletionStatus, 'idle');
  assert.equal(summary.quoteExpiry, 'complete');
  assert.equal(summary.orderExpiry, 'complete');
  assert.equal(summary.pickupOrderExpiry, 'complete');
  assert.equal(summary.pushDispatch, 'disabled');
  assert.equal(summary.pushReceipts, 'disabled');
  assert.equal(calls.length, 12);
  assert.match(calls[2].url, /\/functions\/v1\/media-cleanup$/);
  assert.match(calls[3].url, /\/rpc\/cleanup_marketplace_chat_ephemera$/);
  assert.match(calls[4].url, /\/rpc\/cleanup_unavailable_meeting_place_requests$/);
  assert.match(calls[5].url, /\/rpc\/expire_shadow_order_quotes$/);
  assert.deepEqual(JSON.parse(calls[5].init.body), { batch_limit: 200 });
  assert.match(calls[6].url, /\/rpc\/expire_shadow_orders$/);
  assert.deepEqual(JSON.parse(calls[6].init.body), { batch_limit: 100 });
  assert.match(calls[7].url, /\/rpc\/expire_pay_in_person_pickup_orders$/);
  assert.deepEqual(JSON.parse(calls[7].init.body), { batch_size: 200 });
  assert.match(calls[8].url, /\/rpc\/cleanup_public_discovery_leases$/);
  assert.match(calls[9].url, /\/rpc\/reconcile_licensed_provider_lifecycle$/);
  assert.match(calls[10].url, /\/rpc\/reconcile_sponsored_reservations$/);
  assert.equal(calls[11].url, VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${VALID_ENV.SPOTTR_ACCOUNT_DELETE_WORKER_SECRET}`);
  assert.equal(calls[3].init.headers.apikey, VALID_ENV.SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY);
});

test('maintenance runs bounded push dispatch and receipt polling before its heartbeat', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    completePushDispatch(),
    completePushReceipts(),
    response(null),
  ];
  const summary = await runProductionMaintenance({
    config: readMaintenanceConfiguration(PUSH_ENABLED_ENV),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return queue.shift();
    },
    log: () => {},
  });

  assert.equal(summary.pushDispatch, 'complete');
  assert.equal(summary.pushReceipts, 'complete');
  assert.equal(calls.length, 13);
  assert.match(calls[10].url, /\/functions\/v1\/notification-dispatch$/);
  assert.deepEqual(JSON.parse(calls[10].init.body), {
    outboxBatchSize: 20,
    recipientBatchSize: 200,
    deliveryBatchSize: 50,
  });
  assert.equal(
    calls[10].init.headers.Authorization,
    `Bearer ${PUSH_ENABLED_ENV.SPOTTR_PUSH_DISPATCH_SECRET}`,
  );
  assert.match(calls[11].url, /\/functions\/v1\/notification-receipt$/);
  assert.deepEqual(JSON.parse(calls[11].init.body), { batchSize: 100 });
  assert.equal(
    calls[11].init.headers.Authorization,
    `Bearer ${PUSH_ENABLED_ENV.SPOTTR_PUSH_RECEIPT_SECRET}`,
  );
  assert.equal(calls[12].url, VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL);
});

test('maintenance expires prepaid checkouts and drains bounded refund work before heartbeat', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    response({ expired: 0, more_work: false }),
    completePaymentRefunds(),
    response(null),
  ];
  const summary = await runProductionMaintenance({
    config: readMaintenanceConfiguration(PAYMENTS_ENABLED_ENV),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return queue.shift();
    },
    log: () => {},
  });
  assert.equal(summary.prepaidCheckoutExpiry, 'complete');
  assert.equal(summary.paymentRefunds, 'complete');
  assert.match(calls[10].url, /\/rpc\/expire_prepaid_pickup_checkouts$/);
  assert.deepEqual(JSON.parse(calls[10].init.body), { batch_size: 200 });
  assert.match(calls[11].url, /\/functions\/v1\/payment-refund-worker$/);
  assert.equal(calls[11].init.headers.Authorization, `Bearer ${PAYMENTS_ENABLED_ENV.SPOTTR_PAYMENT_REFUND_WORKER_SECRET}`);
  assert.equal(calls[12].url, VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL);
});

test('maintenance withholds heartbeat when push worker counts are inconsistent', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    completePushDispatch({ accepted: 2, retry: 1 }),
  ];

  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(PUSH_ENABLED_ENV),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return queue.shift();
      },
      log: () => {},
    }),
    /inconsistent delivery counts/,
  );
  assert.equal(calls.length, 11);
  assert.equal(
    calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
    false,
  );
});

test('maintenance withholds heartbeat when receipt worker counts are inconsistent', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    completePushDispatch(),
    completePushReceipts({ delivered: 2, invalid: 1 }),
  ];

  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(PUSH_ENABLED_ENV),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return queue.shift();
      },
      log: () => {},
    }),
    /inconsistent receipt counts/,
  );
  assert.equal(calls.length, 12);
  assert.equal(
    calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
    false,
  );
});

test('maintenance rejects a dispatch ambiguity backlog hidden by top-level more_work=false', async () => {
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    completePushDispatch({ unknown_finalization_more_work: true, more_work: false }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(PUSH_ENABLED_ENV),
      fetchImpl: async () => queue.shift(),
      log: () => {},
    }),
    /top-level backlog omitted finalization work/,
  );
});

test('maintenance rejects a dispatch outbox finalizer backlog hidden by top-level more_work=false', async () => {
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    completePushDispatch({ outbox_finalization_more_work: true, more_work: false }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(PUSH_ENABLED_ENV),
      fetchImpl: async () => queue.shift(),
      log: () => {},
    }),
    /top-level backlog omitted finalization work/,
  );
});

test('maintenance rejects a receipt finalizer backlog hidden by top-level more_work=false', async () => {
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    completePushDispatch(),
    completePushReceipts({ receipt_finalization_more_work: true, more_work: false }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(PUSH_ENABLED_ENV),
      fetchImpl: async () => queue.shift(),
      log: () => {},
    }),
    /top-level backlog omitted finalization work/,
  );
});

for (const phase of ['dispatch', 'receipt']) {
  test(`maintenance withholds heartbeat while notification ${phase} has a backlog`, async () => {
    const calls = [];
    const queue = [
      response({ status: 'idle' }),
      response({ status: 'complete' }),
      response({ requests_expired: 0 }),
      response({ requests_cancelled: 0 }),
      completeQuoteExpiry(),
      completeOrderExpiry(),
      completePickupOrderExpiry(),
      response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
      completeProviderLifecycle(),
      completeSponsoredReservations(),
      completePushDispatch({ more_work: phase === 'dispatch' }),
      ...(phase === 'receipt' ? [completePushReceipts({ more_work: true })] : []),
    ];

    await assert.rejects(
      runProductionMaintenance({
        config: readMaintenanceConfiguration(PUSH_ENABLED_ENV),
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return queue.shift();
        },
        log: () => {},
      }),
      new RegExp(`notification-${phase} did not report bounded completion`),
    );
    assert.equal(calls.length, phase === 'dispatch' ? 11 : 12);
    assert.equal(
      calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
      false,
    );
  });
}

test('maintenance accepts a retryable receipt-finalization wait', async () => {
  const queue = [
    response({
      status: 'waiting',
      phase: 'receipt_finalization',
      retry_after_seconds: 60,
    }, 202),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    completeSponsoredReservations(),
    response(null),
  ];
  const summary = await runProductionMaintenance({
    config: readMaintenanceConfiguration(VALID_ENV),
    fetchImpl: async () => queue.shift(),
    log: () => {},
  });

  assert.equal(summary.deletionCalls, 1);
  assert.equal(summary.deletionStatus, 'waiting');
});

for (const terminalStatus of ['more_work', 'deleted']) {
  test(`maintenance withholds heartbeat after ten consecutive ${terminalStatus} responses`, async () => {
    const calls = [];
    const queue = [
      ...Array.from({ length: 10 }, () => response({ status: terminalStatus })),
      response({ status: 'complete' }),
      response({ requests_expired: 0 }),
      response({ requests_cancelled: 0 }),
      completeQuoteExpiry(),
      completeOrderExpiry(),
      completePickupOrderExpiry(),
      response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
      completeProviderLifecycle(),
      completeSponsoredReservations(),
    ];

    await assert.rejects(
      runProductionMaintenance({
        config: readMaintenanceConfiguration(VALID_ENV),
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return queue.shift();
        },
        log: () => {},
      }),
      /exhausted its bounded call cap/,
    );

    assert.equal(calls.length, 19);
    assert.equal(
      calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
      false,
    );
  });
}

test('maintenance withholds heartbeat while discovery cleanup has a backlog', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({
      leases_deleted: 0,
      buckets_deleted: 10_000,
      more_work: true,
      skipped_operations: [],
    }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(VALID_ENV),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return queue.shift();
      },
      log: () => {},
    }),
    /did not report bounded completion/,
  );
  assert.equal(calls.length, 8);
});

test('maintenance withholds heartbeat when a discovery operation was skipped', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({
      leases_deleted: 0,
      buckets_deleted: 0,
      more_work: false,
      skipped_operations: ['map'],
    }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(VALID_ENV),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return queue.shift();
      },
      log: () => {},
    }),
    /did not report bounded completion/,
  );
  assert.equal(calls.length, 8);
});

for (const receipt of [
  { expired: 200, more_work: true, skipped: false },
  { expired: 0, more_work: true, skipped: true },
]) {
  test(`maintenance withholds heartbeat for incomplete quote expiry ${JSON.stringify(receipt)}`, async () => {
    const calls = [];
    const queue = [
      response({ status: 'idle' }),
      response({ status: 'complete' }),
      response({ requests_expired: 0 }),
      response({ requests_cancelled: 0 }),
      response(receipt),
    ];
    await assert.rejects(
      runProductionMaintenance({
        config: readMaintenanceConfiguration(VALID_ENV),
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return queue.shift();
        },
        log: () => {},
      }),
      /expire_shadow_order_quotes did not report bounded completion/,
    );
    assert.equal(calls.length, 5);
    assert.equal(
      calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
      false,
    );
  });
}

for (const receipt of [
  { expired: 100, more_work: true, skipped: false },
  { expired: 0, more_work: true, skipped: true },
]) {
  test(`maintenance withholds heartbeat for incomplete order expiry ${JSON.stringify(receipt)}`, async () => {
    const calls = [];
    const queue = [
      response({ status: 'idle' }),
      response({ status: 'complete' }),
      response({ requests_expired: 0 }),
      response({ requests_cancelled: 0 }),
      completeQuoteExpiry(),
      response(receipt),
    ];
    await assert.rejects(
      runProductionMaintenance({
        config: readMaintenanceConfiguration(VALID_ENV),
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return queue.shift();
        },
        log: () => {},
      }),
      /expire_shadow_orders did not report bounded completion/,
    );
    assert.equal(calls.length, 6);
    assert.equal(
      calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
      false,
    );
  });
}

test('maintenance withholds heartbeat while pay-in-person pickup expiry has a backlog', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    response({ expired: 200, more_work: true }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(VALID_ENV),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return queue.shift();
      },
      log: () => {},
    }),
    /expire_pay_in_person_pickup_orders did not report bounded completion/,
  );
  assert.equal(calls.length, 7);
  assert.equal(
    calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
    false,
  );
});

test('maintenance withholds heartbeat while provider lifecycle work remains', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    response({
      sources_marked_stale: 500,
      businesses_archived: 0,
      more_work: true,
      skipped: false,
    }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(VALID_ENV),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return queue.shift();
      },
      log: () => {},
    }),
    /reconcile_licensed_provider_lifecycle did not report bounded completion/,
  );
  assert.equal(calls.length, 9);
  assert.equal(
    calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
    false,
  );
});

test('maintenance requires an exact push scheduler gate and independent worker secrets', () => {
  assert.throws(
    () => readMaintenanceConfiguration({
      ...VALID_ENV,
      SPOTTR_MAINTENANCE_PUSH_ENABLED: 'yes',
    }),
    /exactly true or false/,
  );
  assert.throws(
    () => readMaintenanceConfiguration({
      ...VALID_ENV,
      SPOTTR_MAINTENANCE_PUSH_ENABLED: 'true',
    }),
    /SPOTTR_PUSH_DISPATCH_SECRET/,
  );
  assert.throws(
    () => readMaintenanceConfiguration({
      ...VALID_ENV,
      SPOTTR_MAINTENANCE_PUSH_ENABLED: 'true',
      SPOTTR_PUSH_DISPATCH_SECRET: PUSH_ENABLED_ENV.SPOTTR_PUSH_DISPATCH_SECRET,
    }),
    /SPOTTR_PUSH_RECEIPT_SECRET/,
  );
  assert.equal(readMaintenanceConfiguration(VALID_ENV).push, null);
  assert.deepEqual(readMaintenanceConfiguration(PUSH_ENABLED_ENV).push, {
    dispatchSecret: PUSH_ENABLED_ENV.SPOTTR_PUSH_DISPATCH_SECRET,
    receiptSecret: PUSH_ENABLED_ENV.SPOTTR_PUSH_RECEIPT_SECRET,
  });
  assert.throws(
    () => readMaintenanceConfiguration({ ...VALID_ENV, SPOTTR_MAINTENANCE_PAYMENTS_ENABLED: 'yes' }),
    /exactly true or false/,
  );
  assert.throws(
    () => readMaintenanceConfiguration({ ...VALID_ENV, SPOTTR_MAINTENANCE_PAYMENTS_ENABLED: 'true' }),
    /SPOTTR_PAYMENT_REFUND_WORKER_SECRET/,
  );
  assert.equal(readMaintenanceConfiguration(VALID_ENV).payments, null);
  assert.deepEqual(readMaintenanceConfiguration(PAYMENTS_ENABLED_ENV).payments, {
    refundSecret: PAYMENTS_ENABLED_ENV.SPOTTR_PAYMENT_REFUND_WORKER_SECRET,
  });
});

test('maintenance withholds heartbeat while sponsored reservations remain', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    completeQuoteExpiry(),
    completeOrderExpiry(),
    completePickupOrderExpiry(),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
    completeProviderLifecycle(),
    response({ released: 500, more_work: true, skipped: false }),
  ];
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(VALID_ENV),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return queue.shift();
      },
      log: () => {},
    }),
    /reconcile_sponsored_reservations did not report bounded completion/,
  );
  assert.equal(calls.length, 10);
  assert.equal(
    calls.some(({ url }) => url === VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL),
    false,
  );
});

test('maintenance errors never include an upstream response body', async () => {
  await assert.rejects(
    runProductionMaintenance({
      config: readMaintenanceConfiguration(VALID_ENV),
      fetchImpl: async () => response({ leaked: 'sensitive-upstream-detail' }, 503),
      log: () => {},
    }),
    (error) => {
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, /sensitive-upstream-detail/);
      return true;
    },
  );
});


const maintenanceWorkflow = await readFile(
  new URL('../.github/workflows/production-maintenance.yml', import.meta.url),
  'utf8',
);

test('privileged maintenance workflow pins actions and scopes production secrets to the run step', () => {
  const stepsOffset = maintenanceWorkflow.indexOf('    steps:');
  assert.ok(stepsOffset > 0);
  assert.doesNotMatch(
    maintenanceWorkflow.slice(0, stepsOffset),
    /SPOTTR_(?:MAINTENANCE|ACCOUNT_DELETE|MEDIA_CLEANUP|PUSH_|PAYMENT_)/u,
  );
  assert.match(maintenanceWorkflow, /uses: actions\/checkout@[0-9a-f]{40} # v6/u);
  assert.match(maintenanceWorkflow, /uses: actions\/setup-node@[0-9a-f]{40} # v6/u);
  assert.doesNotMatch(maintenanceWorkflow, /uses: [^\s]+@(v\d+|main|master)(?:\s|$)/u);
  const maintenanceStep = maintenanceWorkflow.slice(
    maintenanceWorkflow.indexOf('      - name: Run bounded production maintenance'),
  );
  for (const name of [
    'SPOTTR_MAINTENANCE_SUPABASE_URL',
    'SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY',
    'SPOTTR_ACCOUNT_DELETE_WORKER_SECRET',
    'SPOTTR_MEDIA_CLEANUP_SECRET',
    'SPOTTR_MAINTENANCE_HEARTBEAT_URL',
    'SPOTTR_PUSH_DISPATCH_SECRET',
    'SPOTTR_PUSH_RECEIPT_SECRET',
    'SPOTTR_PAYMENT_REFUND_WORKER_SECRET',
  ]) {
    assert.match(
      maintenanceStep,
      new RegExp(`\\n          ${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`),
    );
  }
  assert.match(
    maintenanceStep,
    /\n          SPOTTR_MAINTENANCE_PUSH_ENABLED: \$\{\{ vars\.SPOTTR_MAINTENANCE_PUSH_ENABLED \|\| 'false' \}\}/u,
  );
  assert.match(
    maintenanceStep,
    /\n          SPOTTR_MAINTENANCE_PAYMENTS_ENABLED: \$\{\{ vars\.SPOTTR_MAINTENANCE_PAYMENTS_ENABLED \|\| 'false' \}\}/u,
  );
});
