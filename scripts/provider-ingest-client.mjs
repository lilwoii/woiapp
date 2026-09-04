import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 524_288;
const MAX_RESPONSE_BYTES = 32_768;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 5;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const SECRET = /^[A-Za-z0-9_-]{43,172}$/;

function fail(message) {
  throw new Error(message);
}

function exactIngestUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('SPOTTR_PROVIDER_INGEST_URL must be the exact HTTPS provider-ingest endpoint.');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    parsed.search || parsed.hash || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname) ||
    parsed.pathname !== '/functions/v1/provider-ingest'
  ) fail('SPOTTR_PROVIDER_INGEST_URL must be the exact HTTPS provider-ingest endpoint.');
  return parsed.href;
}

export function decodeProviderSecret(value) {
  if (typeof value !== 'string' || !SECRET.test(value)) {
    fail('SPOTTR_PROVIDER_INGEST_SECRET must be an unpadded base64url secret.');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 32 || bytes.length > 128 || bytes.toString('base64url') !== value) {
    fail('SPOTTR_PROVIDER_INGEST_SECRET must decode to 32–128 bytes.');
  }
  return bytes;
}

function parsePayload(bytes) {
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('The provider batch must be valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('The provider batch must be a JSON object.');
  }
  if (typeof payload.provider !== 'string' || !PROVIDER.test(payload.provider)) {
    fail('The provider batch has an invalid provider.');
  }
  if (typeof payload.batchId !== 'string' || !IDEMPOTENCY_KEY.test(payload.batchId)) {
    fail('The provider batch has an invalid batchId.');
  }
  return payload;
}

export function buildProviderIngestRequest({ body, endpoint, keyId, secret, timestamp }) {
  if (!Buffer.isBuffer(body) || body.length < 2 || body.length > MAX_REQUEST_BYTES) {
    fail(`Provider batch size must be 2–${MAX_REQUEST_BYTES} bytes.`);
  }
  const payload = parsePayload(body);
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) fail('The provider signing key ID is invalid.');
  if (!Number.isSafeInteger(timestamp) || timestamp < 1_700_000_000 || timestamp > 9_999_999_999) {
    fail('The provider request timestamp is invalid.');
  }
  const secretBytes = decodeProviderSecret(secret);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = [
    'spottr-provider-ingest-v1',
    'POST',
    payload.provider,
    keyId,
    String(timestamp),
    payload.batchId,
    bodyHash,
  ].join('\n');
  const signature = createHmac('sha256', secretBytes).update(canonical).digest('hex');
  return {
    body,
    bodyHash,
    endpoint: exactIngestUrl(endpoint),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': payload.batchId,
      'x-spottr-key-id': keyId,
      'x-spottr-provider': payload.provider,
      'x-spottr-signature': `v1=${signature}`,
      'x-spottr-timestamp': String(timestamp),
    },
    payload,
  };
}

async function boundedResponseText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail('Provider ingest returned an oversized response.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) fail('Provider ingest returned an oversized response.');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString('utf8');
}

function parseSafeReceipt(text, expectedBatchId) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    fail('Provider ingest returned a malformed response.');
  }
  const keys = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? Object.keys(receipt).sort()
    : [];
  const expectedKeys = ['accepted_records', 'batch_id', 'inactive_records', 'status'];
  if (
    keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
    !['applied', 'replayed'].includes(receipt.status) || receipt.batch_id !== expectedBatchId ||
    !Number.isInteger(receipt.accepted_records) || receipt.accepted_records < 0 ||
    !Number.isInteger(receipt.inactive_records) || receipt.inactive_records < 0 ||
    receipt.accepted_records + receipt.inactive_records < 1 ||
    receipt.accepted_records + receipt.inactive_records > 100
  ) fail('Provider ingest returned an invalid safe receipt.');
  return receipt;
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 30) return retryAfter * 1_000;
  return Math.min(8_000, 500 * (2 ** (attempt - 1)));
}

function retryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export async function submitProviderBatch(request, {
  fetchImpl = fetch,
  maxAttempts = MAX_ATTEMPTS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    fail(`maxAttempts must be 1–${MAX_ATTEMPTS}.`);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(request.endpoint, {
        body: request.body,
        headers: request.headers,
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === maxAttempts) fail('Provider ingest did not confirm the batch. Retry the same file and batchId.');
      await sleep(retryDelay(null, attempt));
      continue;
    }
    const responseText = await boundedResponseText(response);
    if (response.ok) return parseSafeReceipt(responseText, request.payload.batchId);
    if (!retryableStatus(response.status) || attempt === maxAttempts) {
      fail(`Provider ingest rejected the batch with HTTP ${response.status}.`);
    }
    await sleep(retryDelay(response, attempt));
  }
  fail('Provider ingest did not confirm the batch.');
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runProviderIngestCli(args, env, dependencies = {}) {
  const batchFlags = args.filter((argument) => argument === '--batch').length;
  const dryRunFlags = args.filter((argument) => argument === '--dry-run').length;
  const batchIndex = args.indexOf('--batch');
  const batchPath = valueAfter(args, '--batch');
  const dryRun = args.includes('--dry-run');
  const consumed = new Set([
    ...(batchIndex >= 0 ? [batchIndex, batchIndex + 1] : []),
    ...(dryRun ? [args.indexOf('--dry-run')] : []),
  ]);
  if (
    batchFlags !== 1 || dryRunFlags > 1 || !batchPath || batchPath.startsWith('--') ||
    consumed.size !== args.length
  ) {
    fail('Usage: npm run provider:ingest -- --batch PATH.json [--dry-run]');
  }
  const metadata = await stat(batchPath);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_REQUEST_BYTES) {
    fail(`Provider batch size must be 2–${MAX_REQUEST_BYTES} bytes.`);
  }
  const body = await readFile(batchPath);
  const request = buildProviderIngestRequest({
    body,
    endpoint: env.SPOTTR_PROVIDER_INGEST_URL,
    keyId: env.SPOTTR_PROVIDER_INGEST_KEY_ID,
    secret: env.SPOTTR_PROVIDER_INGEST_SECRET,
    timestamp: Math.floor((dependencies.now?.() ?? Date.now()) / 1_000),
  });
  if (dryRun) {
    return { status: 'validated', batch_id: request.payload.batchId, body_sha256: request.bodyHash };
  }
  return submitProviderBatch(request, dependencies);
}

const directInvocation = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (directInvocation) {
  runProviderIngestCli(process.argv.slice(2), process.env)
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Provider ingest failed.'}\n`);
      process.exitCode = 1;
    });
}

export function signaturesEqual(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
