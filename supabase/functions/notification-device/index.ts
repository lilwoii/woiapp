import {
  adminClient,
  authenticatedSessionId,
  authenticatedUser,
  corsHeaders,
  HttpError,
  jsonResponse,
  optionsResponse,
  publicError,
  readJson,
} from "../_shared/http.ts";
import { parseNotificationDeviceRequest, protectPushToken } from "./contract.ts";

function requiredSetting(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
  return value;
}

Deno.serve(async (request) => {
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return optionsResponse(request);
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    let command;
    try {
      command = parseNotificationDeviceRequest(await readJson(request, 4096));
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_NOTIFICATION_DEVICE_REQUEST") {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    const { token, user } = await authenticatedUser(
      request,
      command.action === "register",
    );
    const admin = adminClient();

    if (command.action === "revoke_all") {
      const { error } = await admin.rpc("revoke_all_notification_devices_server", {
        target_user_id: user.id,
        target_consent_policy_version: command.consentPolicyVersion,
      });
      if (error) throw error;
      return jsonResponse({ status: "revoked" }, 200, cors);
    }

    if (command.action === "revoke") {
      const { error } = await admin.rpc("revoke_notification_device_server", {
        target_user_id: user.id,
        target_installation_id: command.installationId,
        target_consent_policy_version: command.consentPolicyVersion,
      });
      if (error) throw error;
      return jsonResponse({ status: "revoked" }, 200, cors);
    }

    if (Deno.env.get("SPOTTR_PUSH_DEVICE_REGISTRATION_ENABLED") !== "true") {
      throw new HttpError(503, "PUSH_REGISTRATION_DISABLED");
    }

    const expectedProjectId = requiredSetting("SPOTTR_PUSH_EXPO_PROJECT_ID").toLowerCase();
    if (command.projectId !== expectedProjectId) {
      throw new HttpError(400, "PUSH_PROJECT_MISMATCH");
    }
    const encryptionKey = requiredSetting("SPOTTR_PUSH_TOKEN_ENCRYPTION_KEY");
    const tokenHashKey = requiredSetting("SPOTTR_PUSH_TOKEN_HASH_KEY");
    const keyVersion = Number(requiredSetting("SPOTTR_PUSH_TOKEN_ENCRYPTION_KEY_VERSION"));
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
    }
    const protectedToken = await protectPushToken(
      command.token,
      encryptionKey,
      tokenHashKey,
    );
    const authSessionId = authenticatedSessionId(token);
    const { error } = await admin.rpc("register_notification_device_server", {
      target_user_id: user.id,
      target_auth_session_id: authSessionId,
      target_installation_id: command.installationId,
      target_platform: command.platform,
      target_project_id: command.projectId,
      target_token_hash: protectedToken.tokenHash,
      target_token_ciphertext: protectedToken.tokenCiphertext,
      target_token_nonce: protectedToken.tokenNonce,
      target_encryption_key_version: keyVersion,
      target_timezone: command.timezone,
      target_app_version: command.appVersion,
      target_permission_state: command.permissionState,
      target_consent_policy_version: command.consentPolicyVersion,
      target_consent_source: "native_settings",
    });
    if (error) throw error;
    return jsonResponse({ status: "registered" }, 201, cors);
  } catch (error) {
    return publicError(error, cors);
  }
});
