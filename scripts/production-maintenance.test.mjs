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
  SPOTTR_MAINTENANCE_HEARTBEAT_URL: 'https://heartbeat.example.test/spottr',
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body === null ? '' : JSON.stringify(body),
  };
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

test('maintenance drains bounded deletion work and runs every privacy cleanup', async () => {
  const calls = [];
  const queue = [
    response({ status: 'deleted' }),
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
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
  assert.equal(calls.length, 7);
  assert.match(calls[2].url, /\/functions\/v1\/media-cleanup$/);
  assert.match(calls[3].url, /\/rpc\/cleanup_marketplace_chat_ephemera$/);
  assert.match(calls[4].url, /\/rpc\/cleanup_unavailable_meeting_place_requests$/);
  assert.match(calls[5].url, /\/rpc\/cleanup_public_discovery_leases$/);
  assert.equal(calls[6].url, VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${VALID_ENV.SPOTTR_ACCOUNT_DELETE_WORKER_SECRET}`);
  assert.equal(calls[3].init.headers.apikey, VALID_ENV.SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY);
});

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
    response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
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
      response({ leases_deleted: 0, buckets_deleted: 0, more_work: false, skipped_operations: [] }),
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

    assert.equal(calls.length, 14);
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
  assert.equal(calls.length, 5);
});

test('maintenance withholds heartbeat when a discovery operation was skipped', async () => {
  const calls = [];
  const queue = [
    response({ status: 'idle' }),
    response({ status: 'complete' }),
    response({ requests_expired: 0 }),
    response({ requests_cancelled: 0 }),
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
  assert.equal(calls.length, 5);
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
    /SPOTTR_MAINTENANCE_|SPOTTR_ACCOUNT_DELETE_|SPOTTR_MEDIA_CLEANUP_/u,
  );
  assert.match(maintenanceWorkflow, /uses: actions\/checkout@[0-9a-f]{40} # v6/u);
  assert.match(maintenanceWorkflow, /uses: actions\/setup-node@[0-9a-f]{40} # v6/u);
  assert.doesNotMatch(maintenanceWorkflow, /uses: [^\s]+@(v\d+|main|master)(?:\s|$)/u);
  const maintenanceStep = maintenanceWorkflow.slice(
    maintenanceWorkflow.indexOf('      - name: Run bounded deletion'),
  );
  for (const name of [
    'SPOTTR_MAINTENANCE_SUPABASE_URL',
    'SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY',
    'SPOTTR_ACCOUNT_DELETE_WORKER_SECRET',
    'SPOTTR_MEDIA_CLEANUP_SECRET',
    'SPOTTR_MAINTENANCE_HEARTBEAT_URL',
  ]) {
    assert.match(
      maintenanceStep,
      new RegExp(`\\n          ${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`),
    );
  }
});
