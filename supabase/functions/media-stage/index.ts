import {
  adminClient,
  authenticatedUser,
  corsHeaders,
  HttpError,
  jsonResponse,
  optionsResponse,
  publicError,
  readJson,
} from "../_shared/http.ts";

type MediaPurpose =
  | "profile_avatar"
  | "business_logo"
  | "business_gallery"
  | "review_photo"
  | "chat_photo"
  | "claim_evidence";

type StageBody = {
  action?: unknown;
  purpose?: unknown;
  businessId?: unknown;
  conversationId?: unknown;
  mimeType?: unknown;
  byteSize?: unknown;
  storagePath?: unknown;
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function uploadsEnabled(): boolean {
  return Deno.env.get("SPOTTR_MEDIA_UPLOADS_ENABLED") === "true";
}

function purpose(value: unknown): MediaPurpose {
  if (
    value !== "profile_avatar" &&
    value !== "business_logo" &&
    value !== "business_gallery" &&
    value !== "review_photo" &&
    value !== "chat_photo" &&
    value !== "claim_evidence"
  ) {
    throw new HttpError(400, "INVALID_MEDIA_PURPOSE");
  }
  return value;
}

function conversationId(value: unknown, required: boolean): string | null {
  if (!required && (value === null || value === undefined)) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new HttpError(400, "INVALID_CONVERSATION_ID");
  }
  return value;
}

function businessId(value: unknown, required: boolean): string | null {
  if (!required && (value === null || value === undefined)) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new HttpError(400, "INVALID_BUSINESS_ID");
  }
  return value;
}

Deno.serve(async (request) => {
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return optionsResponse(request);
    if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    if (!uploadsEnabled()) throw new HttpError(503, "MEDIA_UPLOADS_DISABLED");

    const body = await readJson<StageBody>(request);
    const selectedPurpose = purpose(body.purpose);
    const ownerMedia = selectedPurpose !== "review_photo" && selectedPurpose !== "chat_photo";
    const { user, client } = await authenticatedUser(request, ownerMedia);
    const targetBusinessId = businessId(
      body.businessId,
      selectedPurpose !== "profile_avatar",
    );
    const targetConversationId = conversationId(
      body.conversationId,
      selectedPurpose === "chat_photo",
    );

    const requireChatAccess = async (): Promise<void> => {
      if (selectedPurpose !== "chat_photo") return;
      const { data: canStage, error } = await client.rpc(
        "can_stage_marketplace_chat_media",
        {
          target_conversation_public_id: targetConversationId,
          target_business_id: targetBusinessId,
        },
      );
      if (error || canStage !== true) {
        throw new HttpError(403, "CHAT_MEDIA_ACCESS_REQUIRED");
      }
    };

    if (body.action === "stage") {
      if (
        typeof body.mimeType !== "string" ||
        !(body.mimeType in EXTENSION_BY_MIME) ||
        typeof body.byteSize !== "number" ||
        !Number.isSafeInteger(body.byteSize) ||
        body.byteSize < 1 ||
        body.byteSize > 5_242_880
      ) {
        throw new HttpError(400, "INVALID_MEDIA_METADATA");
      }

      const admin = adminClient();
      const { error: rateLimitError } = await admin.rpc("consume_media_stage_slot", {
        target_user_id: user.id,
        media_purpose: selectedPurpose,
      });
      if (rateLimitError) {
        if (rateLimitError.message.includes("RATE_LIMITED")) {
          throw new HttpError(429, "MEDIA_RATE_LIMITED");
        }
        throw rateLimitError;
      }

      if (selectedPurpose === "business_logo" || selectedPurpose === "business_gallery") {
        const { data: isMember, error } = await client.rpc("is_business_member", {
          target_business_id: targetBusinessId,
          allowed_roles: ["owner", "manager"],
        });
        if (error || !isMember) throw new HttpError(403, "BUSINESS_ACCESS_REQUIRED");
      } else if (selectedPurpose === "chat_photo") {
        await requireChatAccess();
      } else if (
        selectedPurpose === "review_photo" ||
        selectedPurpose === "claim_evidence"
      ) {
        const { data, error } = await client
          .from("public_business_directory")
          .select("business_id")
          .eq("business_id", targetBusinessId)
          .maybeSingle();
        if (error || !data) throw new HttpError(400, "BUSINESS_NOT_REVIEWABLE");
      }

      const extension = EXTENSION_BY_MIME[body.mimeType];
      const path = `quarantine/${user.id}/${crypto.randomUUID()}.${extension}`;
      const { data, error } = await admin.storage
        .from("spottr-media")
        .createSignedUploadUrl(path);
      if (error || !data) throw error ?? new Error("Unable to create upload URL");

      return jsonResponse(
        {
          status: "staged",
          upload: {
            bucket: "spottr-media",
            path,
            signed_url: data.signedUrl,
            token: data.token,
            max_bytes: 5_242_880,
            content_type: body.mimeType,
          },
          next: selectedPurpose === "claim_evidence"
            ? {
              action: "submit_business_claim",
              evidence_private_path: path,
            }
            : {
              action: "register",
              purpose: selectedPurpose,
              businessId: targetBusinessId,
              conversationId: targetConversationId,
              storagePath: path,
            },
        },
        201,
        cors,
      );
    }

    if (body.action === "register") {
      if (selectedPurpose === "claim_evidence") {
        throw new HttpError(400, "CLAIM_EVIDENCE_IS_NOT_PUBLIC_MEDIA");
      }
      await requireChatAccess();
      if (
        typeof body.storagePath !== "string" ||
        !new RegExp(
          `^quarantine/${user.id}/[0-9a-f-]{36}\\.(jpg|png|webp)$`,
          "i",
        ).test(body.storagePath)
      ) {
        throw new HttpError(400, "INVALID_QUARANTINE_PATH");
      }

      const { data: assetId, error } = await client.rpc("register_quarantined_media", {
        target_storage_path: body.storagePath,
        target_business_id: targetBusinessId,
        media_source: selectedPurpose === "review_photo" || selectedPurpose === "chat_photo"
          ? "review_upload"
          : "owner_upload",
      });
      if (error || !assetId) throw error ?? new Error("Unable to register media");

      return jsonResponse(
        {
          status: "quarantined",
          asset_id: assetId,
          quarantine_state: "uploaded",
          moderation_state: "pending",
          next: "external_scan_required",
        },
        202,
        cors,
      );
    }

    throw new HttpError(400, "INVALID_MEDIA_ACTION");
  } catch (error) {
    return publicError(error, cors);
  }
});
