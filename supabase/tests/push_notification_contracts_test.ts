import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1";

import {
  parseNotificationDeviceRequest,
  protectPushToken,
  PUSH_CONSENT_POLICY_VERSION,
} from "../functions/notification-device/contract.ts";

const root = new URL("../", import.meta.url);

async function text(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, root));
}

const installationId = "8a7ba30d-91c2-4ec8-a492-55e4a0cdb004";
const projectId = "162152fc-7f83-4f89-83c2-1bd081f2be03";
const token = "ExpoPushToken[abcdefghijklmnopqrstuvwx]";

Deno.test("notification device input is exact, provider-bound, and timezone validated", () => {
  const parsed = parseNotificationDeviceRequest({
    action: "register",
    installationId,
    platform: "ios",
    projectId,
    token,
    timezone: "America/Los_Angeles",
    appVersion: "0.2.0",
    permissionState: "granted",
    consentPolicyVersion: PUSH_CONSENT_POLICY_VERSION,
  });
  assertEquals(parsed.action, "register");
  assertEquals(
    parseNotificationDeviceRequest({
      action: "revoke_all",
      consentPolicyVersion: PUSH_CONSENT_POLICY_VERSION,
    }).action,
    "revoke_all",
  );
  for (
    const invalid of [
      {
        action: "register",
        installationId,
        platform: "web",
        projectId,
        token,
        timezone: "UTC",
        appVersion: "1",
        permissionState: "granted",
        consentPolicyVersion: PUSH_CONSENT_POLICY_VERSION,
      },
      {
        action: "register",
        installationId,
        platform: "android",
        projectId,
        token,
        timezone: "UTC",
        appVersion: "1",
        permissionState: "provisional",
        consentPolicyVersion: PUSH_CONSENT_POLICY_VERSION,
      },
      {
        action: "register",
        installationId,
        platform: "ios",
        projectId,
        token: "raw-token",
        timezone: "UTC",
        appVersion: "1",
        permissionState: "granted",
        consentPolicyVersion: PUSH_CONSENT_POLICY_VERSION,
      },
      {
        action: "register",
        installationId,
        platform: "ios",
        projectId,
        token,
        timezone: "Not/AZone",
        appVersion: "1",
        permissionState: "granted",
        consentPolicyVersion: PUSH_CONSENT_POLICY_VERSION,
      },
      {
        action: "revoke",
        installationId,
        revokeConsent: true,
        consentPolicyVersion: PUSH_CONSENT_POLICY_VERSION,
        userId: projectId,
      },
    ]
  ) {
    assertRejects(
      async () => parseNotificationDeviceRequest(invalid),
      Error,
      "INVALID_NOTIFICATION_DEVICE_REQUEST",
    );
  }
});

Deno.test("push tokens are hashed and AES-GCM encrypted before persistence", async () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const protectedToken = await protectPushToken(
    token,
    key,
    key,
    new Uint8Array(12),
  );
  assertMatch(protectedToken.tokenHash, /^[0-9a-f]{64}$/);
  assertMatch(protectedToken.tokenCiphertext, /^[A-Za-z0-9_-]+$/);
  assertEquals(protectedToken.tokenNonce, "AAAAAAAAAAAAAAAA");
  assert(!protectedToken.tokenCiphertext.includes(token));
  const contract = await text("functions/notification-device/contract.ts");
  assert(contract.includes('{ name: "HMAC", hash: "SHA-256" }'));
  assert(!contract.includes('crypto.subtle.digest("SHA-256", plaintext)'));
  await assertRejects(
    () => protectPushToken(token, "too-short", key),
    Error,
    "INVALID_ENCRYPTION_KEY",
  );
});

Deno.test("notification storage is private, cascading, deduplicated, and disabled by default", async () => {
  const migration = await text(
    "migrations/20260917000000_push_notification_foundation.sql",
  );
  const sessionBinding = await text(
    "migrations/20260919000000_notification_session_binding.sql",
  );
  const followLifecycle = await text(
    "migrations/20260920000000_notification_follow_lifecycle.sql",
  );
  for (
    const table of [
      "notification_consents",
      "notification_devices",
      "notification_outbox",
      "notification_deliveries",
    ]
  ) {
    assert(migration.includes(`private.${table}`));
  }
  assertMatch(
    migration,
    /notification_devices[\s\S]*user_id uuid not null references auth\.users\(id\) on delete cascade/,
  );
  assertMatch(
    migration,
    /notification_deliveries[\s\S]*unique \(device_id, source_event_id\)/,
  );
  assert(migration.includes("notification_deliveries_device_user_fkey"));
  assert(migration.includes("notification_deliveries_outbox_identity_fkey"));
  assertMatch(
    migration,
    /notification_devices_active_token_idx[\s\S]*where revoked_at is null/,
  );
  assertMatch(
    sessionBinding,
    /notification_devices_active_installation_idx[\s\S]*where revoked_at is null/,
  );
  assertMatch(
    sessionBinding,
    /auth_session_id uuid[\s\S]*notification_devices_active_session_required/,
  );
  assertMatch(
    sessionBinding,
    /join auth\.sessions auth_session on auth_session\.id = device\.auth_session_id/,
  );
  assert(sessionBinding.includes("auth_session_ended"));
  assert(sessionBinding.includes("session_binding_required"));
  assertMatch(
    sessionBinding,
    /from auth\.sessions auth_session[\s\S]*for key share;[\s\S]*if not found then/,
  );
  assertMatch(migration, /values \(true, false, false\)/);
  assertMatch(
    migration,
    /revoke all privileges on table[\s\S]*private\.notification_devices[\s\S]*from public, anon, authenticated/,
  );
  assertMatch(
    migration,
    /revoke insert, update, delete on public\.notification_preferences from authenticated/,
  );
  assertMatch(
    migration,
    /for select to authenticated using \(user_id = auth\.uid\(\)\)/,
  );
  assert(migration.includes("'notification_consents'"));
  assert(migration.includes("'notification_devices'"));
  assertMatch(
    followLifecycle,
    /last_provider_code = 'follow_removed'/,
  );
  assertMatch(followLifecycle, /after delete on public\.follows/);
  assertMatch(
    followLifecycle,
    /join public\.follows followed on followed\.user_id = delivery\.user_id/,
  );
  assertMatch(
    followLifecycle,
    /public\.notification_preferences preference,[\s\S]*public\.follows followed/,
  );
  const exportWrapper = migration.slice(
    migration.indexOf(
      "create or replace function public.account_export_payload(target_user_id uuid)",
    ),
  );
  assert(!exportWrapper.includes("token_ciphertext"));
  assert(!exportWrapper.includes("token_hash"));
  assert(!exportWrapper.includes("token_nonce"));
  assert(
    !migration.includes(
      "alter publication supabase_realtime add table private.notification",
    ),
  );
});

Deno.test("event enqueue stores only references and bounded workers use leases", async () => {
  const migration = await text(
    "migrations/20260917000000_push_notification_foundation.sql",
  );
  const enqueue = migration.slice(
    migration.indexOf(
      "create or replace function private.enqueue_notification_event",
    ),
    migration.indexOf(
      "create or replace function private.claim_notification_outbox",
    ),
  );
  assert(enqueue.includes("new.event_type"));
  assert(enqueue.includes("new.id"));
  assert(!enqueue.includes("new.payload ->> 'body'"));
  assert(!enqueue.includes("when 'live_status' then"));
  assert(
    enqueue.includes(
      "'menu_availability' then case when new.payload ->> 'availability' = 'available'",
    ),
  );
  assertMatch(migration, /for update skip locked/);
  assertMatch(migration, /target_batch_size not between 1 and 100/);
  assertMatch(migration, /target_user_batch_size not between 1 and 500/);
  assertMatch(
    migration,
    /target_state not in \('accepted', 'unknown', 'delivered', 'retry', 'failed', 'dead'\)/,
  );
  const deliveryClaim = migration.slice(
    migration.indexOf(
      "create or replace function private.claim_notification_deliveries",
    ),
    migration.indexOf(
      "create or replace function private.record_notification_delivery_result",
    ),
  );
  assert(!deliveryClaim.match(/delivery\.state in \([^)]*'unknown'/));
  assert(
    migration.includes(
      "consent.consent_kind = 'product_updates' and consent.granted",
    ),
  );
  assert(migration.includes("last_provider_code = 'preference_revoked'"));
  assert(migration.includes("last_provider_code = 'consent_revoked'"));
  assert(migration.includes("last_provider_code = 'device_revoked'"));
});

Deno.test("delivery claim and provider handoff revalidate public business eligibility", async () => {
  const migration = await text(
    "migrations/20260926000000_notification_business_eligibility_lifecycle.sql",
  );
  const claimStart = migration.indexOf(
    "create or replace function private.claim_notification_deliveries",
  );
  const handoffStart = migration.indexOf(
    "create or replace function private.mark_notification_delivery_batch_sending",
  );
  const grantsStart = migration.indexOf(
    "revoke all on function private.claim_notification_deliveries",
  );
  const claim = migration.slice(claimStart, handoffStart);
  const handoff = migration.slice(handoffStart, grantsStart);

  assert(claimStart >= 0 && handoffStart > claimStart && grantsStart > handoffStart);
  assert(claim.includes("private.is_business_publicly_eligible(delivery.business_id)"));
  assert(handoff.includes("private.is_business_publicly_eligible(delivery.business_id)"));
  assertMatch(claim, /delivery\.state in \('pending', 'retry'\)/);
  assertMatch(claim, /delivery\.state = 'leased' and delivery\.lease_expires_at <= now\(\)/);
  assertMatch(handoff, /delivery\.state = 'leased'/);
  assert(handoff.includes("affected <> cardinality(target_delivery_ids)"));
  assertMatch(migration, /grant execute on function private\.claim_notification_deliveries[\s\S]+to service_role/);
});

Deno.test("registration is fail-closed and revocation remains available during shutdown", async () => {
  const edge = await text("functions/notification-device/index.ts");
  const http = await text("functions/_shared/http.ts");
  const config = await text("config.toml");
  const env = await text("functions/.env.example");
  const registerGate = edge.indexOf(
    'SPOTTR_PUSH_DEVICE_REGISTRATION_ENABLED") !== "true"',
  );
  assert(registerGate > edge.indexOf('command.action === "revoke"'));
  assertMatch(
    edge,
    /authenticatedUser\(\s*request,\s*command\.action === "register",?\s*\)/,
  );
  assert(edge.includes('requiredSetting("SPOTTR_PUSH_EXPO_PROJECT_ID")'));
  assert(edge.includes('requiredSetting("SPOTTR_PUSH_TOKEN_ENCRYPTION_KEY")'));
  assert(edge.includes('requiredSetting("SPOTTR_PUSH_TOKEN_HASH_KEY")'));
  assert(edge.includes("authenticatedSessionId(token)"));
  assert(edge.includes("target_auth_session_id: authSessionId"));
  assert(http.includes("jwtPayload(token).session_id"));
  assert(!edge.includes("fetch("));
  assert(!edge.includes("console.log"));
  assertMatch(config, /\[functions\.notification-device\]\s+verify_jwt = true/);
  assertMatch(env, /SPOTTR_PUSH_DEVICE_REGISTRATION_ENABLED=false/);
});

Deno.test("native permission is user-triggered and sign-out revokes before the auth session", async () => {
  const native = await text("../lib/push-notifications.native.ts");
  const base = await text("../lib/push-notifications.ts");
  const web = await text("../lib/push-notifications.web.ts");
  const nativeSupabase = await text("../lib/supabase.native.ts");
  const webSupabase = await text("../lib/supabase.ts");
  const auth = await text("../context/auth-context.tsx");
  const deepLinkHandler = auth.slice(
    auth.indexOf("const handleDeepLink"),
    auth.indexOf("const linkSubscription"),
  );
  const authStateHandler = auth.slice(
    auth.indexOf("const handleAuthStateChange"),
    auth.indexOf("const handleDeepLink"),
  );
  const signUpHandler = auth.slice(
    auth.indexOf("const signUp = useCallback"),
    auth.indexOf("const signIn = useCallback"),
  );
  const signInHandler = auth.slice(
    auth.indexOf("const signIn = useCallback"),
    auth.indexOf("const requestPasswordReset"),
  );
  const app = JSON.parse(await text("../app.base.json"));
  assert(native.includes("requestPermissionsAsync"));
  assert(native.includes("getExpoPushTokenAsync({ projectId: easProjectId })"));
  assert(native.includes("SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY"));
  assert(web.includes("Web push is not enabled"));
  assert(native.includes("createAccessTokenBoundSupabaseClient"));
  assert(native.includes("revokePushNotificationDeviceWithAccessToken"));
  assert(native.includes("timeout: DEVICE_REQUEST_TIMEOUT_MS"));
  assert(base.includes("revokePushNotificationDeviceWithAccessToken"));
  assert(web.includes("revokePushNotificationDeviceWithAccessToken"));
  assert(nativeSupabase.includes("createAccessTokenBoundSupabaseClient"));
  assert(nativeSupabase.includes("persistAuthIdentityQuarantine"));
  assert(nativeSupabase.includes("readAuthIdentityQuarantine"));
  assert(nativeSupabase.includes("clearAuthIdentityQuarantine"));
  assert(webSupabase.includes("createAccessTokenBoundSupabaseClient"));
  assert(
    auth.includes(
      "if (!notificationRevocation.ok) return notificationRevocation",
    ),
  );
  assert(
    auth.indexOf("confirmNotificationRevocation(expectedUserId, false)") <
      auth.indexOf("revokingSession.access_token,\n        'local'"),
  );
  assert(
    auth.indexOf("confirmNotificationRevocation(expectedUserId, true)") <
      auth.indexOf("revokingSession.access_token,\n        'global'"),
  );
  assert(
    auth.includes(
      "Sign out of the current account before continuing with another account.",
    ),
  );
  assert(
    deepLinkHandler.indexOf("initialRestoreBarrier.ready") <
      deepLinkHandler.indexOf(
        "const currentSession = await client.auth.getSession();",
      ),
  );
  assert(
    deepLinkHandler.indexOf(
      "const currentSession = await client.auth.getSession();",
    ) < deepLinkHandler.indexOf("client.auth.exchangeCodeForSession(code)"),
  );
  assert(
    deepLinkHandler.includes(
      "Sign out before opening a password-recovery link.",
    ),
  );
  assert(
    authStateHandler.indexOf(
      "isUnexpectedAuthenticatedIdentityReplacement(",
    ) < authStateHandler.indexOf("hydrateSession(authoritativeSession"),
  );
  assert(authStateHandler.includes("priorSession.accessToken"));
  assert(authStateHandler.includes("confirmCapturedNotificationRevocation"));
  assert(authStateHandler.includes("clearLocalAuthSessionForUser"));
  assert(authStateHandler.includes("persistAuthIdentityQuarantine"));
  assert(authStateHandler.includes("rejectedNativeIdentity.current"));
  assert(authStateHandler.includes("blocked an unexpected account change"));
  assert(auth.includes("createInitialAuthRestoreBarrier()"));
  assert(auth.includes("activeRestoreRequest = restoredReservation.token"));
  assert(signUpHandler.includes("prepareExplicitAuthentication()"));
  assert(signUpHandler.includes("client.auth.signUp("));
  assert(
    signUpHandler.indexOf("prepareExplicitAuthentication()") <
      signUpHandler.indexOf("client.auth.signUp("),
  );
  assert(signInHandler.includes("prepareExplicitAuthentication()"));
  assert(signInHandler.includes("client.auth.signInWithPassword("));
  assert(
    signInHandler.indexOf("prepareExplicitAuthentication()") <
      signInHandler.indexOf("client.auth.signInWithPassword("),
  );
  assert(app.expo.plugins.includes("expo-notifications"));
});
