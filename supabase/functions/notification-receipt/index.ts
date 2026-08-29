import {
  adminClient,
  HttpError,
  internalBearer,
  jsonResponse,
  publicError,
  readJson,
} from "../_shared/http.ts";
import {
  fetchExpoReceipts,
  parseNotificationFinalization,
  parseReceiptClaims,
  parseReceiptRequest,
  PushProviderError,
  type ReceiptClaim,
  validateExpoAccessToken,
} from "../notification-dispatch/contract.ts";

function requiredSetting(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
  return value;
}

function requireCleanupWorkerGate(): void {
  if (Deno.env.get("SPOTTR_PUSH_RECEIPT_WORKER_ENABLED") !== "true") {
    throw new HttpError(503, "PUSH_RECEIPTS_DISABLED");
  }
}

function providerEnabled(): boolean {
  return Deno.env.get("SPOTTR_PUSH_EXPO_PROVIDER_ENABLED") === "true";
}

async function recordReceipt(
  admin: ReturnType<typeof adminClient>,
  claim: ReceiptClaim,
  state: "delivered" | "retry" | "failed" | "dead",
  code: string | null,
  retryAfterSeconds: number | null = null,
): Promise<void> {
  const { error } = await admin.rpc("record_notification_receipt_result_server", {
    target_receipt_check_id: claim.receipt_check_id,
    target_lease_token: claim.lease_token,
    target_state: state,
    target_provider_code: code,
    target_retry_after_seconds: retryAfterSeconds,
  });
  if (error) throw new HttpError(503, "NOTIFICATION_RECEIPT_STATE_FAILED");
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    internalBearer(request, "SPOTTR_PUSH_RECEIPT_SECRET");
    requireCleanupWorkerGate();
    const command = parseReceiptRequest(await readJson(request, 1024));
    const admin = adminClient();
    const { data: rawFinalization, error: finalizationError } = await admin.rpc(
      "finalize_notification_receipt_expiry_server",
      { target_batch_size: command.batchSize },
    );
    if (finalizationError) {
      throw new HttpError(503, "NOTIFICATION_RECEIPT_FINALIZATION_FAILED");
    }
    const finalization = parseNotificationFinalization(
      rawFinalization,
      command.batchSize,
      "INVALID_NOTIFICATION_RECEIPT_FINALIZATION",
    );

    // Run the database-only sweep before this check, but fail closed while
    // provider polling is unavailable. A 200/complete response here would
    // let the maintenance heartbeat declare healthy while receipts wait.
    if (!providerEnabled()) {
      throw new HttpError(503, "PUSH_PROVIDER_DISABLED");
    }

    const accessToken = validateExpoAccessToken(requiredSetting("SPOTTR_PUSH_EXPO_ACCESS_TOKEN"));
    const { data, error } = await admin.rpc("claim_notification_receipts_after_finalization_server", {
      target_worker_id: crypto.randomUUID(),
      target_batch_size: command.batchSize,
      target_lease_seconds: 120,
    });
    if (error) throw new HttpError(503, "NOTIFICATION_RECEIPT_CLAIM_FAILED");
    const claims = parseReceiptClaims(data ?? [], command.batchSize);

    let delivered = 0;
    let retry = 0;
    let failed = 0;
    let invalid = 0;
    if (claims.length) {
      let outcomes: Awaited<ReturnType<typeof fetchExpoReceipts>> | null = null;
      try {
        outcomes = await fetchExpoReceipts(
          claims.map((claim) => claim.provider_ticket_id),
          accessToken,
          fetch,
          AbortSignal.timeout(10_000),
        );
      } catch (error) {
        const code = error instanceof PushProviderError ? error.code : "ExpoReceiptProviderError";
        for (const claim of claims) {
          await recordReceipt(admin, claim, "retry", code, 300);
          retry += 1;
        }
      }
      if (outcomes) {
        for (const claim of claims) {
          const outcome = outcomes.get(claim.provider_ticket_id);
          if (!outcome || outcome.state === "missing") {
            await recordReceipt(admin, claim, "retry", "ExpoReceiptPending", 300);
            retry += 1;
          } else if (outcome.state === "delivered") {
            await recordReceipt(admin, claim, "delivered", "ExpoDelivered");
            delivered += 1;
          } else if (outcome.state === "invalid") {
            await recordReceipt(admin, claim, "dead", outcome.code);
            invalid += 1;
          } else if (outcome.state === "retry") {
            await recordReceipt(admin, claim, "retry", outcome.code, 300);
            retry += 1;
          } else {
            await recordReceipt(admin, claim, "failed", outcome.code);
            failed += 1;
          }
        }
      }
    }

    return jsonResponse({
      status: "complete",
      receipts_claimed: claims.length,
      delivered,
      retry,
      failed,
      invalid,
      more_work: claims.length === command.batchSize || finalization.moreWork,
      receipts_finalized: finalization.finalized,
      receipt_finalization_more_work: finalization.moreWork,
    });
  } catch (error) {
    return publicError(error);
  }
});
