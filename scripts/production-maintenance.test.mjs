import assert from 'node:assert/strict';
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
  assert.equal(calls.length, 6);
  assert.match(calls[2].url, /\/functions\/v1\/media-cleanup$/);
  assert.match(calls[3].url, /\/rpc\/cleanup_marketplace_chat_ephemera$/);
  assert.match(calls[4].url, /\/rpc\/cleanup_unavailable_meeting_place_requests$/);
  assert.equal(calls[5].url, VALID_ENV.SPOTTR_MAINTENANCE_HEARTBEAT_URL);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${VALID_ENV.SPOTTR_ACCOUNT_DELETE_WORKER_SECRET}`);
  assert.equal(calls[3].init.headers.apikey, VALID_ENV.SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY);
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
