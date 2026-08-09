import { pathToFileURL } from 'node:url';

const MAX_DELETE_WORKER_CALLS = 10;
const REQUEST_TIMEOUT_MS = 25_000;

function requiredSecret(env, name, minimumLength = 32) {
  const value = env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} is missing or too short.`);
  }
  return value;
}

function requiredHttpsUrl(env, name) {
  const raw = requiredSecret(env, name, 12);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL without a fragment.`);
  }
  return parsed;
}

async function requestJson(fetchImpl, label, url, init) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function edgeHeaders(secret) {
  return {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  };
}

function serviceHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

export function readMaintenanceConfiguration(env = process.env) {
  const supabaseUrl = requiredHttpsUrl(env, 'SPOTTR_MAINTENANCE_SUPABASE_URL');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl.href)) {
    throw new Error('SPOTTR_MAINTENANCE_SUPABASE_URL must be a Supabase project origin.');
  }
  return {
    supabaseOrigin: supabaseUrl.href.replace(/\/$/, ''),
    serviceRoleKey: requiredSecret(env, 'SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY', 40),
    accountDeleteSecret: requiredSecret(env, 'SPOTTR_ACCOUNT_DELETE_WORKER_SECRET'),
    mediaCleanupSecret: requiredSecret(env, 'SPOTTR_MEDIA_CLEANUP_SECRET'),
    heartbeatUrl: requiredHttpsUrl(env, 'SPOTTR_MAINTENANCE_HEARTBEAT_URL').href,
  };
}

export async function runProductionMaintenance({
  config = readMaintenanceConfiguration(),
  fetchImpl = fetch,
  log = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  const functionRoot = `${config.supabaseOrigin}/functions/v1`;
  const restRoot = `${config.supabaseOrigin}/rest/v1/rpc`;
  let deletionCalls = 0;
  let deletionStatus = 'not_started';

  for (; deletionCalls < MAX_DELETE_WORKER_CALLS; deletionCalls += 1) {
    const result = await requestJson(
      fetchImpl,
      'delete-account-worker',
      `${functionRoot}/delete-account-worker`,
      { method: 'POST', headers: edgeHeaders(config.accountDeleteSecret), body: '{}' },
    );
    deletionStatus = typeof result?.status === 'string' ? result.status : 'invalid';
    if (!['idle', 'waiting', 'deleted', 'more_work'].includes(deletionStatus)) {
      throw new Error('delete-account-worker returned an unknown status.');
    }
    if (deletionStatus === 'idle' || deletionStatus === 'waiting') {
      deletionCalls += 1;
      break;
    }
  }

  const mediaResult = await requestJson(
    fetchImpl,
    'media-cleanup',
    `${functionRoot}/media-cleanup`,
    { method: 'POST', headers: edgeHeaders(config.mediaCleanupSecret), body: '{}' },
  );
  if (mediaResult?.status !== 'complete') throw new Error('media-cleanup did not report completion.');

  const databaseHeaders = serviceHeaders(config.serviceRoleKey);
  await requestJson(
    fetchImpl,
    'cleanup_marketplace_chat_ephemera',
    `${restRoot}/cleanup_marketplace_chat_ephemera`,
    { method: 'POST', headers: databaseHeaders, body: '{}' },
  );
  await requestJson(
    fetchImpl,
    'cleanup_unavailable_meeting_place_requests',
    `${restRoot}/cleanup_unavailable_meeting_place_requests`,
    { method: 'POST', headers: databaseHeaders, body: '{}' },
  );

  const heartbeat = await fetchImpl(config.heartbeatUrl, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!heartbeat.ok) throw new Error(`Maintenance heartbeat failed with HTTP ${heartbeat.status}.`);

  const summary = {
    deletionCalls,
    deletionStatus,
    mediaCleanup: 'complete',
    databaseCleanup: 'complete',
    heartbeat: 'complete',
  };
  log(JSON.stringify(summary));
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProductionMaintenance().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
