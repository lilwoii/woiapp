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
  buildGenericNotificationPayload,
  decryptPushToken,
  type DeliveryClaim,
  type DispatchOutcome,
  parseDeliveryClaims,
  parseDispatchRequest,
  parseEncryptionKeyRing,
  parseNotificationFinalization,
  parseOutboxClaims,
  PushProviderError,
  sendExpoMessages,
  validateExpoAccessToken,
} from "./contract.ts";
import {
  parseWebPushSubscription,
  sendWebPushNotification,
  validateWebPushProviderConfig,
  type WebPushOutcome,
  type WebPushProviderConfig,
} from "./web-push.ts";

function requiredSetting(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
  return value;
}

function requireCleanupWorkerGate(): void {
  if (Deno.env.get("SPOTTR_PUSH_DISPATCH_WORKER_ENABLED") !== "true") {
    throw new HttpError(503, "PUSH_DISPATCH_DISABLED");
  }
}

function expoProviderEnabled(): boolean {
  return Deno.env.get("SPOTTR_PUSH_EXPO_PROVIDER_ENABLED") === "true";
}

function webPushProviderEnabled(): boolean {
  return Deno.env.get("SPOTTR_WEB_PUSH_PROVIDER_ENABLED") === "true";
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

async function recordWebPushDelivery(
  admin: Admin,
  claim: DeliveryClaim,
  state: "accepted" | "unknown" | "retry" | "failed" | "dead",
  code: string | null,
  retryAfterSeconds: number | null = null,
): Promise<void> {
  const { error } = await admin.rpc("record_web_push_delivery_result_server", {
    target_delivery_id: claim.delivery_id,
    target_lease_token: claim.lease_token,
    target_state: state,
    target_provider_code: code,
    target_retry_after_seconds: retryAfterSeconds,
  });
  if (error) throw new HttpError(503, "WEB_PUSH_DELIVERY_STATE_FAILED");
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

async function resolveWebPushOutcome(
  admin: Admin,
  claim: DeliveryClaim,
  outcome: WebPushOutcome,
): Promise<"accepted" | "unknown" | "retry" | "dead"> {
  if (outcome.state === "accepted") {
    await recordWebPushDelivery(admin, claim, "accepted", outcome.code);
    return "accepted";
  }
  if (outcome.state === "unknown") {
    await recordWebPushDelivery(admin, claim, "unknown", outcome.code);
    return "unknown";
  }
  if (outcome.state === "invalid") {
    await recordWebPushDelivery(admin, claim, "dead", outcome.code);
    return "dead";
  }
  if (outcome.retry) {
    await recordWebPushDelivery(admin, claim, "retry", outcome.code, 60);
    return "retry";
  }
  await recordWebPushDelivery(admin, claim, "dead", outcome.code);
  return "dead";
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    internalBearer(request, "SPOTTR_PUSH_DISPATCH_SECRET");
    requireCleanupWorkerGate();
    const command = parseDispatchRequest(await readJson(request, 2048));
    const admin = adminClient();

    const { data: rawOutboxFinalization, error: outboxFinalizationError } = await admin.rpc(
      "finalize_notification_outbox_server",
      { target_batch_size: command.outboxBatchSize },
    );
    if (outboxFinalizationError) {
      throw new HttpError(503, "NOTIFICATION_OUTBOX_FINALIZATION_FAILED");
    }
    const outboxFinalization = parseNotificationFinalization(
      rawOutboxFinalization,
      command.outboxBatchSize,
      "INVALID_NOTIFICATION_OUTBOX_FINALIZATION",
    );

    const { data: rawUnknownFinalization, error: unknownFinalizationError } = await admin.rpc(
      "finalize_unknown_notification_deliveries_server",
      { target_batch_size: command.deliveryBatchSize },
    );
    if (unknownFinalizationError) {
      throw new HttpError(503, "NOTIFICATION_UNKNOWN_FINALIZATION_FAILED");
    }
    const unknownFinalization = parseNotificationFinalization(
      rawUnknownFinalization,
      command.deliveryBatchSize,
      "INVALID_NOTIFICATION_UNKNOWN_FINALIZATION",
    );

    // Run the database-only sweep before this check, but fail closed while
    // provider delivery is unavailable. A 200/complete response here would
    // let the maintenance heartbeat declare healthy while outbox work waits.
    const expoEnabled = expoProviderEnabled();
    const webPushEnabled = webPushProviderEnabled();
    if (!expoEnabled && !webPushEnabled) {
      throw new HttpError(503, "PUSH_PROVIDER_DISABLED");
    }

    const accessToken = expoEnabled
      ? validateExpoAccessToken(requiredSetting("SPOTTR_PUSH_EXPO_ACCESS_TOKEN"))
      : null;
    const webPushConfig: WebPushProviderConfig | null = webPushEnabled
      ? validateWebPushProviderConfig({
        subject: requiredSetting("SPOTTR_WEB_PUSH_VAPID_SUBJECT"),
        publicKey: requiredSetting("SPOTTR_WEB_PUSH_VAPID_PUBLIC_KEY"),
        privateKey: requiredSetting("SPOTTR_WEB_PUSH_VAPID_PRIVATE_KEY"),
        allowedOrigins: requiredSetting("SPOTTR_WEB_PUSH_ALLOWED_ORIGINS"),
      })
      : null;
    const keyRing = parseEncryptionKeyRing(requiredSetting("SPOTTR_PUSH_TOKEN_ENCRYPTION_KEYS"));
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
      const expanded = Number(data);
      expandedDeliveries += expanded;
    }

    let expandedOutboxPending = false;
    if (outbox.length) {
      const { data, error } = await admin.rpc("notification_outbox_has_pending_server", {
        target_outbox_ids: outbox.map((claim) => claim.outbox_id),
      });
      if (error || typeof data !== "boolean") {
        throw new HttpError(503, "NOTIFICATION_OUTBOX_STATUS_FAILED");
      }
      expandedOutboxPending = data;
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
    const expoReady: Array<
      { claim: DeliveryClaim; message: ReturnType<typeof buildGenericExpoMessage> }
    > = [];
    const webPushReady: Array<{
      claim: DeliveryClaim;
      payload: ReturnType<typeof buildGenericNotificationPayload>;
      subscription: ReturnType<typeof parseWebPushSubscription>;
    }> = [];
    let accepted = 0;
    let unknown = 0;
    let retry = 0;
    let dead = 0;

    for (const claim of deliveries) {
      try {
        const token = await decryptPushToken(claim, keyRing);
        if (claim.provider === "expo") {
          if (!expoEnabled || !accessToken) {
            await recordDelivery(admin, claim, "retry", null, "ExpoProviderDisabled", 3600);
            retry += 1;
            continue;
          }
          expoReady.push({ claim, message: buildGenericExpoMessage(token, claim) });
        } else {
          if (!webPushEnabled || !webPushConfig) {
            await recordWebPushDelivery(admin, claim, "retry", "WebPushProviderDisabled", 3600);
            retry += 1;
            continue;
          }
          webPushReady.push({
            claim,
            payload: buildGenericNotificationPayload(claim),
            subscription: parseWebPushSubscription(token, webPushConfig.allowedOrigins),
          });
        }
      } catch (error) {
        const code = error instanceof HttpError ? error.code : "PushTokenUnavailable";
        const retryable = code === "PUSH_KEY_VERSION_UNAVAILABLE" ||
          code === "PUSH_TOKEN_DECRYPTION_FAILED";
        if (claim.provider === "web_push") {
          await recordWebPushDelivery(
            admin,
            claim,
            retryable ? "retry" : "dead",
            code,
            retryable ? 3600 : null,
          );
        } else {
          await recordDelivery(
            admin,
            claim,
            retryable ? "retry" : "dead",
            null,
            code,
            retryable ? 3600 : null,
          );
        }
        if (retryable) retry += 1;
        else dead += 1;
      }
    }

    const readyClaims = [...expoReady, ...webPushReady].map(({ claim }) => claim);
    if (readyClaims.length) {
      const { error: handoffError } = await admin.rpc(
        "mark_notification_delivery_batch_sending_server",
        {
          target_delivery_ids: readyClaims.map((claim) => claim.delivery_id),
          target_lease_tokens: readyClaims.map((claim) => claim.lease_token),
          target_lease_seconds: 120,
        },
      );
      if (handoffError) throw new HttpError(503, "NOTIFICATION_SEND_HANDOFF_FAILED");
    }

    if (expoReady.length && accessToken) {
      let outcomes: DispatchOutcome[] | null = null;
      try {
        outcomes = await sendExpoMessages(
          expoReady.map(({ message }) => message),
          accessToken,
          fetch,
          AbortSignal.timeout(10_000),
        );
      } catch (error) {
        const providerError = error instanceof PushProviderError
          ? error
          : new PushProviderError("unknown", "ExpoProviderAmbiguous");
        for (const { claim } of expoReady) {
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
        for (let index = 0; index < expoReady.length; index += 1) {
          const outcome = outcomes[index];
          await resolveOutcome(admin, expoReady[index].claim, outcome);
          if (outcome.state === "accepted") accepted += 1;
          else if (outcome.state === "rejected" && outcome.retry) retry += 1;
          else dead += 1;
        }
      }
    }

    if (webPushReady.length && webPushConfig) {
      const concurrency = 8;
      for (let offset = 0; offset < webPushReady.length; offset += concurrency) {
        const slice = webPushReady.slice(offset, offset + concurrency);
        const outcomes = await Promise.all(slice.map(async (entry) => {
          try {
            return await sendWebPushNotification(
              entry.subscription,
              entry.payload,
              entry.claim.source_event_id,
              webPushConfig,
            );
          } catch {
            return { state: "unknown", code: "WebPushProviderAmbiguous" } as const;
          }
        }));
        for (let index = 0; index < slice.length; index += 1) {
          const state = await resolveWebPushOutcome(admin, slice[index].claim, outcomes[index]);
          if (state === "accepted") accepted += 1;
          else if (state === "unknown") unknown += 1;
          else if (state === "retry") retry += 1;
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
      more_work: outbox.length === command.outboxBatchSize ||
        expandedOutboxPending || deliveries.length === command.deliveryBatchSize ||
        outboxFinalization.moreWork || unknownFinalization.moreWork,
      outbox_finalized: outboxFinalization.finalized,
      outbox_finalization_more_work: outboxFinalization.moreWork,
      unknown_finalized: unknownFinalization.finalized,
      unknown_finalization_more_work: unknownFinalization.moreWork,
    });
  } catch (error) {
    return publicError(error);
  }
});
