import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildProviderIngestRequest,
  decodeProviderSecret,
  runProviderIngestCli,
  signaturesEqual,
  submitProviderBatch,
} from './provider-ingest-client.mjs';

const secret = Buffer.alloc(32, 7).toString('base64url');
const endpoint = 'https://spottr-production.supabase.co/functions/v1/provider-ingest';
const payload = {
  schemaVersion: '2026-07-30',
  provider: 'overture',
  batchId: 'batch:20260903:000001',
  generatedAt: '2026-09-03T20:00:00.000Z',
  sync: { mode: 'delta' },
  records: [{ externalId: 'place/1', status: 'inactive', updatedAt: '2026-09-03T19:00:00.000Z' }],
};

function request() {
  return buildProviderIngestRequest({
    body: Buffer.from(JSON.stringify(payload)),
    endpoint,
    keyId: 'primary-2026',
    secret,
    timestamp: 1_788_467_200,
  });
}

test('builds the exact signed provider request without putting the secret in headers', () => {
  const built = request();
  assert.equal(built.endpoint, endpoint);
  assert.equal(built.headers['idempotency-key'], payload.batchId);
  assert.equal(built.headers['x-spottr-provider'], payload.provider);
  assert.match(built.headers['x-spottr-signature'], /^v1=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(built.headers).includes(secret));
  assert.equal(decodeProviderSecret(secret).byteLength, 32);
  assert.equal(signaturesEqual('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(signaturesEqual('a'.repeat(64), 'b'.repeat(64)), false);
});

test('rejects non-Supabase endpoints, custom ports, and malformed secrets', () => {
  for (const badEndpoint of [
    'http://spottr-production.supabase.co/functions/v1/provider-ingest',
    'https://attacker.example/functions/v1/provider-ingest',
    'https://spottr-production.supabase.co:444/functions/v1/provider-ingest',
    'https://spottr-production.supabase.co/functions/v1/provider-ingest?debug=1',
  ]) {
    assert.throws(() => buildProviderIngestRequest({ ...request(), endpoint: badEndpoint, secret }));
  }
  assert.throws(() => decodeProviderSecret('not-a-secret'));
});

test('retries only bounded transient outcomes with the identical signed request', async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    new Response('{"error":"busy"}', { status: 503, headers: { 'retry-after': '1' } }),
    new Response(JSON.stringify({
      accepted_records: 1,
      batch_id: payload.batchId,
      inactive_records: 0,
      status: 'applied',
    }), { status: 200 }),
  ];
  const receipt = await submitProviderBatch(request(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(receipt.status, 'applied');
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0].init.body, calls[1].init.body);
  assert.deepEqual(calls[0].init.headers, calls[1].init.headers);
  assert.deepEqual(sleeps, [1_000]);
});

test('fails closed on permanent errors and malformed or oversized receipts', async () => {
  await assert.rejects(() => submitProviderBatch(request(), {
    fetchImpl: async () => new Response('{"error":"no"}', { status: 401 }),
    sleep: async () => {},
  }), /HTTP 401/);
  await assert.rejects(() => submitProviderBatch(request(), {
    fetchImpl: async () => new Response(JSON.stringify({
      accepted_records: 1,
      batch_id: 'batch:wrong:000001',
      inactive_records: 0,
      status: 'applied',
    })),
  }), /invalid safe receipt/);
  await assert.rejects(() => submitProviderBatch(request(), {
    fetchImpl: async () => new Response('x'.repeat(32_769)),
  }), /oversized response/);
});

test('dry-run validates exact bytes and never sends a request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spottr-provider-ingest-'));
  const batchPath = join(directory, 'batch.json');
  try {
    await writeFile(batchPath, JSON.stringify(payload));
    let fetched = false;
    const result = await runProviderIngestCli(['--batch', batchPath, '--dry-run'], {
      SPOTTR_PROVIDER_INGEST_URL: endpoint,
      SPOTTR_PROVIDER_INGEST_KEY_ID: 'primary-2026',
      SPOTTR_PROVIDER_INGEST_SECRET: secret,
    }, {
      fetchImpl: async () => {
        fetched = true;
        return new Response();
      },
      now: () => 1_788_467_200_000,
    });
    assert.equal(result.status, 'validated');
    assert.equal(result.batch_id, payload.batchId);
    assert.match(result.body_sha256, /^[0-9a-f]{64}$/);
    assert.equal(fetched, false);
    await assert.rejects(() => runProviderIngestCli(
      ['--batch', batchPath, '--dry-run', 'unexpected'],
      {
        SPOTTR_PROVIDER_INGEST_URL: endpoint,
        SPOTTR_PROVIDER_INGEST_KEY_ID: 'primary-2026',
        SPOTTR_PROVIDER_INGEST_SECRET: secret,
      },
    ), /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
