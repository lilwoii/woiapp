import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { HttpError } from "../functions/_shared/http.ts";
import {
  buildGenericExpoMessage,
  decryptPushToken,
  EXPO_RECEIPTS_URL,
  EXPO_SEND_URL,
  fetchExpoReceipts,
  parseDispatchRequest,
  parseEncryptionKeyRing,
  parseReceiptRequest,
  PushProviderError,
  sendExpoMessages,
  validateExpoAccessToken,
} from "../functions/notification-dispatch/contract.ts";
import { protectPushToken } from "../functions/notification-device/contract.ts";

const root = new URL("../", import.meta.url);
const businessId = "70000000-0000-4000-8000-000000000007";
const token = "ExpoPushToken[abcdefghijklmnopqrstuvwx]";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const accessToken = "expo-secure-access-token-1234567890";

async function text(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, root));
}

Deno.test("push worker requests are exact and strictly bounded", () => {
  assertEquals(parseDispatchRequest({}), {
    outboxBatchSize: 20,
    recipientBatchSize: 200,
    deliveryBatchSize: 50,
  });
  assertEquals(parseReceiptRequest({}), { batchSize: 100 });
  for (
    const invalid of [
      { deliveryBatchSize: 101 },
      { outboxBatchSize: 0 },
      { batchSize: 251 },
      { arbitrary: true },
    ]
  ) {
    assertThrows(
      () => "batchSize" in invalid ? parseReceiptRequest(invalid) : parseDispatchRequest(invalid),
      HttpError,
      "INVALID_NOTIFICATION_WORKER_REQUEST",
    );
  }
});

Deno.test("versioned key ring decrypts only the matching AES-GCM token", async () => {
  const protectedToken = await protectPushToken(
    token,
    key,
    key,
    new Uint8Array(12),
  );
  const ring = parseEncryptionKeyRing(JSON.stringify({ 1: key }));
  assertEquals(
    await decryptPushToken({
      token_ciphertext: protectedToken.tokenCiphertext,
      token_nonce: protectedToken.tokenNonce,
      encryption_key_version: 1,
    }, ring),
    token,
  );
  await assertRejects(
    () =>
      decryptPushToken({
        token_ciphertext: protectedToken.tokenCiphertext,
        token_nonce: protectedToken.tokenNonce,
        encryption_key_version: 2,
      }, ring),
    HttpError,
    "PUSH_KEY_VERSION_UNAVAILABLE",
  );
  assertThrows(
    () => parseEncryptionKeyRing(JSON.stringify({ 0: key })),
    HttpError,
    "INVALID_PUSH_KEY_RING",
  );
});

Deno.test("lock-screen payload is generic and tap data is canonical", () => {
  const message = buildGenericExpoMessage(token, {
    business_id: businessId,
    source_event_id: 42,
    notification_kind: "owner_update",
  });
  assertEquals(message.title, "Spottr");
  assertEquals(message.body, "A place you follow has a new update.");
  assertEquals(message.data, { route: `/place/${businessId}`, eventId: "42" });
  const serialized = JSON.stringify(message);
  assert(!serialized.includes("owner body"));
  assert(!serialized.includes("user_id"));
  assert(!serialized.includes("device_id"));
});

Deno.test("Expo dispatch uses the fixed endpoint, enhanced auth, and ordered tickets", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { status: "ok", id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
            { status: "error", details: { error: "DeviceNotRegistered" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  const base = buildGenericExpoMessage(token, {
    business_id: businessId,
    source_event_id: 42,
    notification_kind: "owner_update",
  });
  const outcomes = await sendExpoMessages([base, base], accessToken, fakeFetch);
  assertEquals(outcomes[0], {
    state: "accepted",
    ticketId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  });
  assertEquals(outcomes[1], { state: "invalid", code: "DeviceNotRegistered" });
  assertEquals(calls[0].url, EXPO_SEND_URL);
  assertEquals(
    new Headers(calls[0].init?.headers).get("authorization"),
    `Bearer ${accessToken}`,
  );
  assertEquals(validateExpoAccessToken(accessToken), accessToken);
  assertThrows(
    () => validateExpoAccessToken("short"),
    HttpError,
    "INVALID_EXPO_ACCESS_TOKEN",
  );
});

Deno.test("ambiguous send is never converted into a blind retry", async () => {
  const failingFetch = (() => Promise.reject(new TypeError("network timeout"))) as typeof fetch;
  const message = buildGenericExpoMessage(token, {
    business_id: businessId,
    source_event_id: 42,
    notification_kind: "owner_update",
  });
  await assertRejects(
    () => sendExpoMessages([message], accessToken, failingFetch),
    PushProviderError,
    "ExpoNetworkAmbiguous",
  );
  try {
    await sendExpoMessages([message], accessToken, failingFetch);
  } catch (error) {
    assert(error instanceof PushProviderError);
    assertEquals(error.resolution, "unknown");
  }
});

Deno.test("receipt polling never resends and retires invalid provider tokens", async () => {
  const ids = [
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
    "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",
  ];
  const calls: string[] = [];
  const fakeFetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            [ids[0]]: { status: "ok" },
            [ids[1]]: {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  const outcomes = await fetchExpoReceipts(ids, accessToken, fakeFetch);
  assertEquals(calls, [EXPO_RECEIPTS_URL]);
  assertEquals(outcomes.get(ids[0]), { state: "delivered" });
  assertEquals(outcomes.get(ids[1]), {
    state: "invalid",
    code: "DeviceNotRegistered",
  });
  assertEquals(outcomes.get(ids[2]), { state: "missing" });
});

Deno.test("dispatch storage, RPCs, functions, and runtime switches stay private and off", async () => {
  const migration = await text(
    "migrations/20260918000000_push_notification_dispatch.sql",
  );
  const dispatch = await text("functions/notification-dispatch/index.ts");
  const receipt = await text("functions/notification-receipt/index.ts");
  const config = await text("config.toml");
  const env = await text("functions/.env.example");
  assert(migration.includes("private.notification_receipt_checks"));
  assert(migration.includes("for update of receipt skip locked"));
  assert(migration.includes("now() + interval '15 minutes'"));
  assert(migration.includes("target_provider_code = 'DeviceNotRegistered'"));
  assert(migration.includes("state = 'unknown'"));
  assert(migration.includes("last_provider_code = 'worker_handoff_ambiguous'"));
  assertMatch(
    migration,
    /revoke all privileges on table private\.notification_receipt_checks/,
  );
  for (
    const name of [
      "claim_notification_outbox_server",
      "expand_notification_outbox_server",
      "claim_notification_deliveries_server",
      "mark_notification_delivery_batch_sending_server",
      "record_notification_delivery_result_server",
      "claim_notification_receipts_server",
      "record_notification_receipt_result_server",
    ]
  ) {
    assert(migration.includes(`public.${name}`));
    assertMatch(
      migration,
      new RegExp(`revoke all on function public\\.${name}`),
    );
  }
  assert(
    dispatch.includes('internalBearer(request, "SPOTTR_PUSH_DISPATCH_SECRET")'),
  );
  assert(
    receipt.includes('internalBearer(request, "SPOTTR_PUSH_RECEIPT_SECRET")'),
  );
  assert(dispatch.includes("AbortSignal.timeout(10_000)"));
  assert(receipt.includes("AbortSignal.timeout(10_000)"));
  assert(!dispatch.includes("console.log"));
  assert(!receipt.includes("console.log"));
  assertMatch(
    config,
    /\[functions\.notification-dispatch\]\s+verify_jwt = false/,
  );
  assertMatch(
    config,
    /\[functions\.notification-receipt\]\s+verify_jwt = false/,
  );
  assertMatch(env, /SPOTTR_PUSH_DISPATCH_WORKER_ENABLED=false/);
  assertMatch(env, /SPOTTR_PUSH_RECEIPT_WORKER_ENABLED=false/);
  assertMatch(env, /SPOTTR_PUSH_EXPO_PROVIDER_ENABLED=false/);
});
