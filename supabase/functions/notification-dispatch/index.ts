import {
  adminClient,
  HttpError,
  internalBearer,
  jsonResponse,
  publicError,
  readJson,
} from "../_shared/http.ts";
import {
  buildGenericExpoMessage,
  decryptPushToken,
  type DeliveryClaim,
  type DispatchOutcome,
  parseDeliveryClaims,
  parseDispatchRequest,
  parseEncryptionKeyRing,
  parseOutboxClaims,
  PushProviderError,
  sendExpoMessages,
  validateExpoAccessToken,
} from "./contract.ts";

function requiredSetting(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
  return value;
}

function requireWorkerGates(): void {
  if (
    Deno.env.get("SPOTTR_PUSH_DISPATCH_WORKER_ENABLED") !== "true" ||
    Deno.env.get("SPOTTR_PUSH_EXPO_PROVIDER_ENABLED") !== "true"
  ) throw new HttpError(503, "PUSH_DISPATCH_DISABLED");
}

type Admin = ReturnType<typeof adminClient>;

async function recordDelivery(
  admin: Admin,
  claim: DeliveryClaim,
  state: "accepted" | "unknown" | "retry" | "failed" | "dead",
  ticketId: string | null,
  code: string | null,
  retryAfterSeconds: number | null = null,
): Promise<void> {
  const { error } = await admin.rpc("record_notification_delivery_result_server", {
    target_delivery_id: claim.delivery_id,
    target_lease_token: claim.lease_token,
    target_state: state,
    target_provider_ticket_id: ticketId,
    target_provider_code: code,
    target_retry_after_seconds: retryAfterSeconds,
  });
  if (error) throw new HttpError(503, "NOTIFICATION_DELIVERY_STATE_FAILED");
}

async function resolveOutcome(
  admin: Admin,
  claim: DeliveryClaim,
  outcome: DispatchOutcome,
): Promise<void> {
  if (outcome.state === "accepted") {
    await recordDelivery(admin, claim, "accepted", outcome.ticketId, "ExpoAccepted");
  } else if (outcome.state === "invalid") {
    await recordDelivery(admin, claim, "dead", null, outcome.code);
  } else if (outcome.retry) {
    await recordDelivery(admin, claim, "retry", null, outcome.code, 60);
  } else {
    await recordDelivery(admin, claim, "dead", null, outcome.code);
  }
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    internalBearer(request, "SPOTTR_PUSH_DISPATCH_SECRET");
    requireWorkerGates();
    const command = parseDispatchRequest(await readJson(request, 2048));
    const accessToken = validateExpoAccessToken(requiredSetting("SPOTTR_PUSH_EXPO_ACCESS_TOKEN"));
    const keyRing = parseEncryptionKeyRing(requiredSetting("SPOTTR_PUSH_TOKEN_ENCRYPTION_KEYS"));
    const admin = adminClient();
    const workerId = crypto.randomUUID();

    const { data: rawOutbox, error: outboxError } = await admin.rpc(
      "claim_notification_outbox_server",
      {
        target_worker_id: workerId,
        target_batch_size: command.outboxBatchSize,
        target_lease_seconds: 120,
      },
    );
    if (outboxError) throw new HttpError(503, "NOTIFICATION_OUTBOX_CLAIM_FAILED");
    const outbox = parseOutboxClaims(rawOutbox ?? [], command.outboxBatchSize);
    let expandedDeliveries = 0;
    for (const claim of outbox) {
      const { data, error } = await admin.rpc("expand_notification_outbox_server", {
        target_outbox_id: claim.outbox_id,
        target_lease_token: claim.lease_token,
        target_user_batch_size: command.recipientBatchSize,
      });
      if (error || !Number.isSafeInteger(data) || Number(data) < 0) {
        throw new HttpError(503, "NOTIFICATION_OUTBOX_EXPANSION_FAILED");
      }
      expandedDeliveries += Number(data);
    }

    const { data: rawDeliveries, error: deliveryError } = await admin.rpc(
      "claim_notification_deliveries_server",
      {
        target_worker_id: workerId,
        target_batch_size: command.deliveryBatchSize,
        target_lease_seconds: 120,
      },
    );
    if (deliveryError) throw new HttpError(503, "NOTIFICATION_DELIVERY_CLAIM_FAILED");
    const deliveries = parseDeliveryClaims(rawDeliveries ?? [], command.deliveryBatchSize);
    const ready: Array<
      { claim: DeliveryClaim; message: ReturnType<typeof buildGenericExpoMessage> }
    > = [];
    let rejectedBeforeSend = 0;

    for (const claim of deliveries) {
      try {
        const token = await decryptPushToken(claim, keyRing);
        ready.push({ claim, message: buildGenericExpoMessage(token, claim) });
      } catch (error) {
        const code = error instanceof HttpError ? error.code : "PushTokenUnavailable";
        const retry = code === "PUSH_KEY_VERSION_UNAVAILABLE" ||
          code === "PUSH_TOKEN_DECRYPTION_FAILED";
        await recordDelivery(
          admin,
          claim,
          retry ? "retry" : "dead",
          null,
          code,
          retry ? 3600 : null,
        );
        rejectedBeforeSend += 1;
      }
    }

    let accepted = 0;
    let unknown = 0;
    let retry = 0;
    let dead = rejectedBeforeSend;
    if (ready.length) {
      const { error: handoffError } = await admin.rpc(
        "mark_notification_delivery_batch_sending_server",
        {
          target_delivery_ids: ready.map(({ claim }) => claim.delivery_id),
          target_lease_tokens: ready.map(({ claim }) => claim.lease_token),
          target_lease_seconds: 120,
        },
      );
      if (handoffError) throw new HttpError(503, "NOTIFICATION_SEND_HANDOFF_FAILED");
      let outcomes: DispatchOutcome[] | null = null;
      try {
        outcomes = await sendExpoMessages(
          ready.map(({ message }) => message),
          accessToken,
          fetch,
          AbortSignal.timeout(10_000),
        );
      } catch (error) {
        const providerError = error instanceof PushProviderError
          ? error
          : new PushProviderError("unknown", "ExpoProviderAmbiguous");
        for (const { claim } of ready) {
          if (providerError.resolution === "retry") {
            await recordDelivery(admin, claim, "retry", null, providerError.code, 60);
            retry += 1;
          } else if (providerError.resolution === "dead") {
            await recordDelivery(admin, claim, "dead", null, providerError.code);
            dead += 1;
          } else {
            await recordDelivery(admin, claim, "unknown", null, providerError.code);
            unknown += 1;
          }
        }
      }
      if (outcomes) {
        for (let index = 0; index < ready.length; index += 1) {
          const outcome = outcomes[index];
          await resolveOutcome(admin, ready[index].claim, outcome);
          if (outcome.state === "accepted") accepted += 1;
          else if (outcome.state === "rejected" && outcome.retry) retry += 1;
          else dead += 1;
        }
      }
    }

    return jsonResponse({
      status: "complete",
      outbox_claimed: outbox.length,
      deliveries_expanded: expandedDeliveries,
      deliveries_claimed: deliveries.length,
      accepted,
      unknown,
      retry,
      dead,
    });
  } catch (error) {
    return publicError(error);
  }
});
