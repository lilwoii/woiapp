import { pathToFileURL } from 'node:url';

const MAX_DELETE_WORKER_CALLS = 10;
const REQUEST_TIMEOUT_MS = 25_000;
const PUSH_DISPATCH_COMMAND = Object.freeze({
  outboxBatchSize: 20,
  recipientBatchSize: 200,
  deliveryBatchSize: 50,
});
const PUSH_RECEIPT_COMMAND = Object.freeze({ batchSize: 100 });

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

function optionalBoolean(env, name) {
  const value = env[name]?.trim() ?? '';
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be exactly true or false.`);
}

function nonNegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} returned an invalid bounded count.`);
  }
  return value;
}

function validatePushDispatchResult(result) {
  if (!result || typeof result !== 'object' || result.status !== 'complete') {
    throw new Error('notification-dispatch did not report completion.');
  }
  const outboxClaimed = nonNegativeInteger(
    result.outbox_claimed,
    'notification-dispatch outbox_claimed',
    PUSH_DISPATCH_COMMAND.outboxBatchSize,
  );
  nonNegativeInteger(
    result.deliveries_expanded,
    'notification-dispatch deliveries_expanded',
    outboxClaimed * PUSH_DISPATCH_COMMAND.recipientBatchSize,
  );
  const deliveriesClaimed = nonNegativeInteger(
    result.deliveries_claimed,
    'notification-dispatch deliveries_claimed',
    PUSH_DISPATCH_COMMAND.deliveryBatchSize,
  );
  const accepted = nonNegativeInteger(
    result.accepted,
    'notification-dispatch accepted',
    deliveriesClaimed,
  );
  const unknown = nonNegativeInteger(
    result.unknown,
    'notification-dispatch unknown',
    deliveriesClaimed,
  );
  const retry = nonNegativeInteger(
    result.retry,
    'notification-dispatch retry',
    deliveriesClaimed,
  );
  const dead = nonNegativeInteger(
    result.dead,
    'notification-dispatch dead',
    deliveriesClaimed,
  );
  nonNegativeInteger(
    result.outbox_finalized,
    'notification-dispatch outbox_finalized',
    PUSH_DISPATCH_COMMAND.outboxBatchSize,
  );
  if (typeof result.outbox_finalization_more_work !== 'boolean') {
    throw new Error('notification-dispatch returned an invalid outbox backlog flag.');
  }
  const unknownFinalized = nonNegativeInteger(
    result.unknown_finalized,
    'notification-dispatch unknown_finalized',
    PUSH_DISPATCH_COMMAND.deliveryBatchSize,
  );
  if (typeof result.unknown_finalization_more_work !== 'boolean') {
    throw new Error('notification-dispatch returned an invalid ambiguity backlog flag.');
  }
  if (result.more_work !== false && typeof result.more_work !== 'boolean') {
    throw new Error('notification-dispatch returned an invalid top-level backlog flag.');
  }
  if (
    result.more_work === false &&
    (result.outbox_finalization_more_work || result.unknown_finalization_more_work)
  ) {
    throw new Error('notification-dispatch top-level backlog omitted finalization work.');
  }
  if (result.more_work !== false) {
    throw new Error('notification-dispatch did not report bounded completion.');
  }
  if (accepted + unknown + retry + dead !== deliveriesClaimed) {
    throw new Error('notification-dispatch returned inconsistent delivery counts.');
  }
  if (unknownFinalized < 0) {
    throw new Error('notification-dispatch returned an invalid ambiguity finalization count.');
  }
}

function validatePushReceiptResult(result) {
  if (!result || typeof result !== 'object' || result.status !== 'complete') {
    throw new Error('notification-receipt did not report completion.');
  }
  const receiptsClaimed = nonNegativeInteger(
    result.receipts_claimed,
    'notification-receipt receipts_claimed',
    PUSH_RECEIPT_COMMAND.batchSize,
  );
  const delivered = nonNegativeInteger(
    result.delivered,
    'notification-receipt delivered',
    receiptsClaimed,
  );
  const retry = nonNegativeInteger(
    result.retry,
    'notification-receipt retry',
    receiptsClaimed,
  );
  const failed = nonNegativeInteger(
    result.failed,
    'notification-receipt failed',
    receiptsClaimed,
  );
  const invalid = nonNegativeInteger(
    result.invalid,
    'notification-receipt invalid',
    receiptsClaimed,
  );
  nonNegativeInteger(
    result.receipts_finalized,
    'notification-receipt receipts_finalized',
    PUSH_RECEIPT_COMMAND.batchSize,
  );
  if (typeof result.receipt_finalization_more_work !== 'boolean') {
    throw new Error('notification-receipt returned an invalid finalization backlog flag.');
  }
  if (result.more_work !== false && typeof result.more_work !== 'boolean') {
    throw new Error('notification-receipt returned an invalid top-level backlog flag.');
  }
  if (result.more_work === false && result.receipt_finalization_more_work) {
    throw new Error('notification-receipt top-level backlog omitted finalization work.');
  }
  if (result.more_work !== false) {
    throw new Error('notification-receipt did not report bounded completion.');
  }
  if (delivered + retry + failed + invalid !== receiptsClaimed) {
    throw new Error('notification-receipt returned inconsistent receipt counts.');
  }
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
  const pushEnabled = optionalBoolean(env, 'SPOTTR_MAINTENANCE_PUSH_ENABLED');
  return {
    supabaseOrigin: supabaseUrl.href.replace(/\/$/, ''),
    serviceRoleKey: requiredSecret(env, 'SPOTTR_MAINTENANCE_SERVICE_ROLE_KEY', 40),
    accountDeleteSecret: requiredSecret(env, 'SPOTTR_ACCOUNT_DELETE_WORKER_SECRET'),
    mediaCleanupSecret: requiredSecret(env, 'SPOTTR_MEDIA_CLEANUP_SECRET'),
    push: pushEnabled
      ? {
        dispatchSecret: requiredSecret(env, 'SPOTTR_PUSH_DISPATCH_SECRET'),
        receiptSecret: requiredSecret(env, 'SPOTTR_PUSH_RECEIPT_SECRET'),
      }
      : null,
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
  let deletionQueueSettled = false;

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
      deletionQueueSettled = true;
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
  const quoteExpiry = await requestJson(
    fetchImpl,
    'expire_shadow_order_quotes',
    `${restRoot}/expire_shadow_order_quotes`,
    { method: 'POST', headers: databaseHeaders, body: JSON.stringify({ batch_limit: 200 }) },
  );
  if (
    !Number.isInteger(quoteExpiry?.expired) ||
    quoteExpiry.expired < 0 ||
    quoteExpiry.more_work !== false ||
    quoteExpiry.skipped !== false
  ) {
    throw new Error('expire_shadow_order_quotes did not report bounded completion.');
  }
  const orderExpiry = await requestJson(
    fetchImpl,
    'expire_shadow_orders',
    `${restRoot}/expire_shadow_orders`,
    { method: 'POST', headers: databaseHeaders, body: JSON.stringify({ batch_limit: 100 }) },
  );
  if (
    !Number.isInteger(orderExpiry?.expired) ||
    orderExpiry.expired < 0 ||
    orderExpiry.more_work !== false ||
    orderExpiry.skipped !== false
  ) {
    throw new Error('expire_shadow_orders did not report bounded completion.');
  }
  const pickupOrderExpiry = await requestJson(
    fetchImpl,
    'expire_pay_in_person_pickup_orders',
    `${restRoot}/expire_pay_in_person_pickup_orders`,
    { method: 'POST', headers: databaseHeaders, body: JSON.stringify({ batch_size: 200 }) },
  );
  if (
    !Number.isInteger(pickupOrderExpiry?.expired) ||
    pickupOrderExpiry.expired < 0 ||
    pickupOrderExpiry.expired > 200 ||
    pickupOrderExpiry.more_work !== false
  ) {
    throw new Error('expire_pay_in_person_pickup_orders did not report bounded completion.');
  }
  const discoveryCleanup = await requestJson(
    fetchImpl,
    'cleanup_public_discovery_leases',
    `${restRoot}/cleanup_public_discovery_leases`,
    { method: 'POST', headers: databaseHeaders, body: '{}' },
  );
  if (
    typeof discoveryCleanup?.leases_deleted !== 'number' ||
    typeof discoveryCleanup?.buckets_deleted !== 'number' ||
    discoveryCleanup.leases_deleted < 0 ||
    discoveryCleanup.buckets_deleted < 0 ||
    discoveryCleanup.more_work !== false ||
    !Array.isArray(discoveryCleanup.skipped_operations) ||
    discoveryCleanup.skipped_operations.length !== 0
  ) {
    throw new Error('cleanup_public_discovery_leases did not report bounded completion.');
  }

  const providerLifecycle = await requestJson(
    fetchImpl,
    'reconcile_licensed_provider_lifecycle',
    `${restRoot}/reconcile_licensed_provider_lifecycle`,
    { method: 'POST', headers: databaseHeaders, body: '{}' },
  );
  if (
    typeof providerLifecycle?.sources_marked_stale !== 'number' ||
    typeof providerLifecycle?.businesses_archived !== 'number' ||
    providerLifecycle.sources_marked_stale < 0 ||
    providerLifecycle.businesses_archived < 0 ||
    providerLifecycle.more_work !== false ||
    providerLifecycle.skipped !== false
  ) {
    throw new Error('reconcile_licensed_provider_lifecycle did not report bounded completion.');
  }

  const sponsoredReservations = await requestJson(
    fetchImpl,
    'reconcile_sponsored_reservations',
    `${restRoot}/reconcile_sponsored_reservations`,
    { method: 'POST', headers: databaseHeaders, body: '{}' },
  );
  if (
    typeof sponsoredReservations?.released !== 'number' ||
    sponsoredReservations.released < 0 ||
    sponsoredReservations.more_work !== false ||
    sponsoredReservations.skipped !== false
  ) {
    throw new Error('reconcile_sponsored_reservations did not report bounded completion.');
  }

  let pushDispatch = 'disabled';
  let pushReceipts = 'disabled';
  if (config.push) {
    const dispatchResult = await requestJson(
      fetchImpl,
      'notification-dispatch',
      `${functionRoot}/notification-dispatch`,
      {
        method: 'POST',
        headers: edgeHeaders(config.push.dispatchSecret),
        body: JSON.stringify(PUSH_DISPATCH_COMMAND),
      },
    );
    validatePushDispatchResult(dispatchResult);
    pushDispatch = 'complete';

    const receiptResult = await requestJson(
      fetchImpl,
      'notification-receipt',
      `${functionRoot}/notification-receipt`,
      {
        method: 'POST',
        headers: edgeHeaders(config.push.receiptSecret),
        body: JSON.stringify(PUSH_RECEIPT_COMMAND),
      },
    );
    validatePushReceiptResult(receiptResult);
    pushReceipts = 'complete';
  }

  // A success heartbeat must mean the bounded deletion pass reached a known
  // resting state. Ten consecutive work responses leave the queue state
  // uncertain, so fail closed after completing the other privacy cleanups.
  if (!deletionQueueSettled) {
    throw new Error('delete-account-worker exhausted its bounded call cap with work still pending.');
  }

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
    quoteExpiry: 'complete',
    orderExpiry: 'complete',
    pickupOrderExpiry: 'complete',
    providerLifecycle: 'complete',
    sponsoredReservations: 'complete',
    pushDispatch,
    pushReceipts,
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
