import { toActionError } from "@/lib/errors";
import { chatSafetyIssue, chatSafetyMessage } from "@/lib/chat-safety";
import { supabase } from "@/lib/supabase";
import type { ActionResult, BusinessCategory } from "@/types/marketplace";
import type {
  MarketplaceChatMessage,
  MarketplaceConversation,
  MarketplaceConversationContext,
  MarketplacePickupDetail,
  MarketplacePickupOption,
  MarketplacePickupRequest,
  MarketplaceTypingMember,
} from "@/types/chat";

type Row = Record<string, unknown>;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const categories = new Set<BusinessCategory>([
  "food_truck",
  "restaurant",
  "pop_up",
  "cafe_bakery",
  "home_kitchen",
]);

function unavailable<T>(): ActionResult<T> {
  return {
    ok: false,
    code: "CONFIG_REQUIRED",
    reason: "Secure Spottr chat is not configured.",
  };
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Row =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() &&
        Number.isFinite(Number(value))
    ? Number(value)
    : 0;
}

function dateValue(value: unknown) {
  const candidate = stringValue(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : "";
}

function coordinateValue(value: unknown) {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? Number(value)
    : NaN;
  return Number.isFinite(candidate) ? candidate : null;
}

function chatIdempotencyKey(
  scope: "start" | "send" | "close" | "report" | "pickup",
) {
  const cryptoApi = globalThis.crypto;
  let nonce: string | undefined = cryptoApi?.randomUUID?.();
  if (!nonce && cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  nonce ??= `${Date.now().toString(36)}-${
    Math.round(globalThis.performance?.now?.() ?? 0).toString(36)
  }`;
  return `spottr:chat:${scope}:${nonce}`;
}

async function signedUrls(paths: string[]) {
  const client = supabase;
  const unique = [...new Set(paths.filter(Boolean))];
  const result = new Map<string, string>();
  if (!client || !unique.length) return result;
  for (let offset = 0; offset < unique.length; offset += 100) {
    const { data, error } = await client.storage
      .from("spottr-media")
      .createSignedUrls(unique.slice(offset, offset + 100), 60 * 60);
    if (error) continue;
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) {
        result.set(entry.path, entry.signedUrl);
      }
    }
  }
  return result;
}

export async function startMarketplaceConversation(
  businessId: string,
  expectedUserId?: string,
): Promise<ActionResult<string>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(businessId)) {
    return { ok: false, code: "INVALID", reason: "Choose a valid business." };
  }
  if (!expectedUserId) {
    return { ok: false, code: "AUTH_REQUIRED", reason: "Sign in to start a conversation." };
  }
  try {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || userData.user?.id !== expectedUserId) {
      return {
        ok: false,
        code: "AUTH_REQUIRED",
        reason: "The active account changed. Try again from the current account.",
      };
    }
    const { data, error } = await client.rpc("start_marketplace_conversation", {
      target_business_id: businessId,
      idempotency_key: chatIdempotencyKey("start"),
    });
    if (error) throw error;
    const id = stringValue((data as Row | null)?.conversation_public_id);
    if (!uuidPattern.test(id)) throw new Error("INVALID_CHAT_RESPONSE");
    return { ok: true, data: id };
  } catch (error) {
    return toActionError(error, "This conversation could not be started.");
  }
}

export async function isMarketplaceChatAvailable(
  businessId: string,
): Promise<boolean> {
  const client = supabase;
  if (!client || !uuidPattern.test(businessId)) return false;
  const { data, error } = await client.rpc("is_marketplace_chat_available", {
    target_business_id: businessId,
  });
  return !error && data === true;
}

export async function listMarketplaceConversations(): Promise<
  ActionResult<MarketplaceConversation[]>
> {
  const client = supabase;
  if (!client) return unavailable();
  try {
    const { data, error } = await client.rpc(
      "list_my_marketplace_conversations_v2",
      {
        cursor_time: null,
        cursor_public_id: null,
        result_limit: 50,
      },
    );
    if (error) throw error;
    const sourceRows = rows(data);
    const urls = await signedUrls(
      sourceRows.map((row) => stringValue(row.counterpart_avatar_path)),
    );
    const conversations = sourceRows.flatMap<MarketplaceConversation>((row) => {
      const id = stringValue(row.conversation_public_id);
      const businessId = stringValue(row.business_id);
      const profileId = stringValue(row.counterpart_public_profile_id);
      const category = stringValue(row.business_kind) as BusinessCategory;
      const state = stringValue(
        row.conversation_state,
      ) as MarketplaceConversation["state"];
      if (
        !uuidPattern.test(id) || !uuidPattern.test(businessId) ||
        !categories.has(category) ||
        !["open", "closed_by_customer", "closed_by_merchant", "restricted"]
          .includes(state)
      ) return [];
      const avatarPath = stringValue(row.counterpart_avatar_path);
      return [{
        id,
        businessId,
        businessName: stringValue(row.business_name),
        businessCategory: category,
        state,
        counterpart: {
          ...(uuidPattern.test(profileId) ? { profileId } : {}),
          name: stringValue(row.counterpart_name) || "Deleted account",
          username: stringValue(row.counterpart_username),
          ...(urls.get(avatarPath) ? { avatarUrl: urls.get(avatarPath) } : {}),
        },
        ...(stringValue(row.last_message_preview)
          ? { lastMessage: stringValue(row.last_message_preview) }
          : {}),
        ...(stringValue(row.last_message_at)
          ? { lastMessageAt: stringValue(row.last_message_at) }
          : {}),
        unreadCount: Math.max(0, Math.floor(numberValue(row.unread_count))),
        createdAt: stringValue(row.created_at),
      }];
    });
    return { ok: true, data: conversations };
  } catch (error) {
    return toActionError(error, "Conversations could not be loaded.");
  }
}

export async function getMarketplaceMessages(
  conversationId: string,
): Promise<ActionResult<MarketplaceChatMessage[]>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId)) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid conversation.",
    };
  }
  try {
    const { data, error } = await client.rpc("get_marketplace_messages_v2", {
      target_conversation_public_id: conversationId,
      before_sequence: null,
      result_limit: 100,
    });
    if (error) throw error;
    const sourceRows = rows(data);
    const paths = sourceRows.flatMap((row) => [
      stringValue(row.sender_avatar_path),
      ...rows(row.attachments).map((attachment) =>
        stringValue(attachment.storage_path)
      ),
    ]);
    const urls = await signedUrls(paths);
    const messages = sourceRows.flatMap<MarketplaceChatMessage>((row) => {
      const id = stringValue(row.message_public_id);
      const profileId = stringValue(row.sender_public_profile_id);
      if (!uuidPattern.test(id)) return [];
      const avatarPath = stringValue(row.sender_avatar_path);
      const visibility = stringValue(
        row.visibility,
      ) as MarketplaceChatMessage["visibility"];
      return [{
        id,
        sequence: Math.max(0, Math.floor(numberValue(row.sequence))),
        sender: {
          ...(uuidPattern.test(profileId) ? { profileId } : {}),
          name: stringValue(row.sender_name) || "Deleted account",
          username: stringValue(row.sender_username),
          ...(urls.get(avatarPath) ? { avatarUrl: urls.get(avatarPath) } : {}),
        },
        ...(stringValue(row.body) ? { body: stringValue(row.body) } : {}),
        attachments: rows(row.attachments).flatMap((attachment) => {
          const assetId = stringValue(attachment.asset_id);
          const path = stringValue(attachment.storage_path);
          const url = urls.get(path);
          if (!uuidPattern.test(assetId) || !url) return [];
          return [{
            assetId,
            url,
            mimeType: stringValue(attachment.mime_type),
            ...(numberValue(attachment.width) > 0
              ? { width: numberValue(attachment.width) }
              : {}),
            ...(numberValue(attachment.height) > 0
              ? { height: numberValue(attachment.height) }
              : {}),
          }];
        }),
        visibility: ["visible", "held", "removed"].includes(visibility)
          ? visibility
          : "removed",
        sentAt: stringValue(row.sent_at),
        ...(stringValue(row.read_by_counterpart_at)
          ? { readAt: stringValue(row.read_by_counterpart_at) }
          : {}),
      }];
    });
    return { ok: true, data: messages.sort((a, b) => a.sequence - b.sequence) };
  } catch (error) {
    return toActionError(error, "Messages could not be loaded.");
  }
}

export async function sendMarketplaceMessage(
  conversationId: string,
  body: string,
  mediaAssetIds: string[] = [],
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (
    !uuidPattern.test(conversationId) ||
    mediaAssetIds.some((id) => !uuidPattern.test(id))
  ) {
    return {
      ok: false,
      code: "INVALID",
      reason: "The message contains an invalid reference.",
    };
  }
  const safetyIssue = chatSafetyIssue(body);
  if (safetyIssue) {
    return {
      ok: false,
      code: "INVALID",
      reason: chatSafetyMessage(safetyIssue),
    };
  }
  try {
    const { error } = await client.rpc("send_marketplace_message", {
      target_conversation_public_id: conversationId,
      message_body: body,
      media_asset_ids: mediaAssetIds,
      idempotency_key: chatIdempotencyKey("send"),
    });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String((error as { message?: unknown } | null)?.message ?? "");
    if (message.includes("SENSITIVE_PAYMENT_DATA_BLOCKED")) {
      return {
        ok: false,
        code: "INVALID",
        reason: chatSafetyMessage("sensitive_payment"),
      };
    }
    if (message.includes("PRECISE_LOCATION_BLOCKED")) {
      return {
        ok: false,
        code: "INVALID",
        reason: chatSafetyMessage("precise_location"),
      };
    }
    return toActionError(error, "This message could not be sent.");
  }
}

export async function setMarketplaceTyping(
  conversationId: string,
  isTyping: boolean,
) {
  const client = supabase;
  if (!client || !uuidPattern.test(conversationId)) return;
  await client.rpc("set_marketplace_typing", {
    target_conversation_public_id: conversationId,
    is_typing: isTyping,
  });
}

export async function getMarketplaceTyping(
  conversationId: string,
): Promise<MarketplaceTypingMember[]> {
  const client = supabase;
  if (!client || !uuidPattern.test(conversationId)) return [];
  const { data, error } = await client.rpc("get_marketplace_typing", {
    target_conversation_public_id: conversationId,
  });
  if (error) return [];
  const sourceRows = rows(data);
  const urls = await signedUrls(
    sourceRows.map((row) => stringValue(row.avatar_path)),
  );
  return sourceRows.flatMap((row) => {
    const profileId = stringValue(row.public_profile_id);
    if (!uuidPattern.test(profileId)) return [];
    const avatarPath = stringValue(row.avatar_path);
    return [{
      profileId,
      name: stringValue(row.name) || "Spottr member",
      username: stringValue(row.username),
      expiresAt: stringValue(row.expires_at),
      ...(urls.get(avatarPath) ? { avatarUrl: urls.get(avatarPath) } : {}),
    }];
  });
}

export async function markMarketplaceConversationRead(
  conversationId: string,
  sequence: number,
) {
  const client = supabase;
  if (!client || !uuidPattern.test(conversationId) || sequence < 0) return;
  await client.rpc("mark_marketplace_conversation_read", {
    target_conversation_public_id: conversationId,
    through_sequence: Math.floor(sequence),
  });
}

export async function reportMarketplaceMessage(
  messageId: string,
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(messageId)) {
    return { ok: false, code: "INVALID", reason: "Choose a valid message." };
  }
  try {
    const { error } = await client.rpc("report_marketplace_message", {
      target_message_public_id: messageId,
      report_reason: "unsafe",
      report_detail:
        "Submitted from the in-chat safety control for staff review.",
      idempotency_key: chatIdempotencyKey("report"),
    });
    if (error) throw error;
    return { ok: true, message: "Message reported for staff review." };
  } catch (error) {
    return toActionError(error, "This message could not be reported.");
  }
}

export async function getMarketplaceConversationRole(
  conversationId: string,
): Promise<"customer" | "merchant" | null> {
  const client = supabase;
  if (!client || !uuidPattern.test(conversationId)) return null;
  const { data, error } = await client.rpc(
    "get_marketplace_conversation_role",
    {
      target_conversation_public_id: conversationId,
    },
  );
  return !error && (data === "customer" || data === "merchant") ? data : null;
}

export async function getMarketplaceConversationContext(
  conversationId: string,
): Promise<ActionResult<MarketplaceConversationContext>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId)) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid conversation.",
    };
  }
  try {
    const { data, error } = await client.rpc(
      "get_marketplace_conversation_context",
      {
        target_conversation_public_id: conversationId,
      },
    );
    if (error) throw error;
    const row = (data && typeof data === "object" && !Array.isArray(data)
      ? data
      : {}) as Row;
    const category = stringValue(row.business_kind) as BusinessCategory;
    const role = stringValue(row.participant_role);
    const actorProfileId = stringValue(row.actor_public_profile_id);
    if (
      !categories.has(category) ||
      (role !== "customer" && role !== "merchant") ||
      row.platform_payment_enabled !== false
    ) {
      throw new Error("INVALID_CHAT_CONTEXT");
    }
    const paymentMethodsConfirmedAt = dateValue(
      row.payment_methods_confirmed_at,
    );
    const paymentMethods = Array.isArray(row.payment_methods)
      ? row.payment_methods.filter((value): value is string =>
        typeof value === "string" && value.length <= 32
      )
      : [];
    return {
      ok: true,
      data: {
        businessCategory: category,
        role,
        ...(uuidPattern.test(actorProfileId) ? { actorProfileId } : {}),
        paymentMethods,
        ...(paymentMethodsConfirmedAt ? { paymentMethodsConfirmedAt } : {}),
        platformPaymentEnabled: false,
      },
    };
  } catch (error) {
    return toActionError(error, "Conversation details could not be loaded.");
  }
}

export async function clearMarketplaceConversation(
  conversationId: string,
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId)) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid conversation.",
    };
  }
  try {
    const { error } = await client.rpc(
      "clear_marketplace_conversation_from_inbox",
      {
        target_conversation_public_id: conversationId,
        idempotency_key: chatIdempotencyKey("close"),
      },
    );
    if (error) throw error;
    return { ok: true, message: "Conversation cleared from your inbox." };
  } catch (error) {
    return toActionError(error, "This conversation could not be cleared.");
  }
}

export async function listNeighborhoodPickupChoices(
  conversationId: string,
): Promise<ActionResult<MarketplacePickupOption[]>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId)) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid conversation.",
    };
  }
  try {
    const { data, error } = await client.rpc(
      "list_neighborhood_pickup_choices",
      {
        target_conversation_public_id: conversationId,
      },
    );
    if (error) throw error;
    return {
      ok: true,
      data: rows(data).flatMap<MarketplacePickupOption>((row) => {
        const id = stringValue(row.choice_public_id);
        const kind = stringValue(
          row.choice_kind,
        ) as MarketplacePickupOption["kind"];
        if (
          !uuidPattern.test(id) ||
          !["safe_meeting_place", "seller_residence"].includes(kind)
        ) return [];
        const latitude = coordinateValue(row.latitude);
        const longitude = coordinateValue(row.longitude);
        return [{
          id,
          kind,
          label: stringValue(row.label),
          city: stringValue(row.city),
          region: stringValue(row.region),
          ...(stringValue(row.address_line)
            ? { address: stringValue(row.address_line) }
            : {}),
          ...(stringValue(row.postal_code)
            ? { postalCode: stringValue(row.postal_code) }
            : {}),
          ...(latitude !== null ? { latitude } : {}),
          ...(longitude !== null ? { longitude } : {}),
          warningRequired: row.warning_required === true,
        }];
      }),
    };
  } catch (error) {
    return toActionError(error, "Pickup choices could not be loaded.");
  }
}

export async function requestNeighborhoodPickupChoice(
  conversationId: string,
  option: MarketplacePickupOption,
  startsAt: Date,
  endsAt: Date,
  residenceWarningAccepted: boolean,
  note = "",
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (
    !uuidPattern.test(conversationId) || !uuidPattern.test(option.id) ||
    !["safe_meeting_place", "seller_residence"].includes(option.kind)
  ) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid pickup preference.",
    };
  }
  if (option.kind === "seller_residence" && !residenceWarningAccepted) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Review and accept the residence pickup caution first.",
    };
  }
  try {
    const { error } = await client.rpc("request_neighborhood_pickup_choice", {
      target_conversation_public_id: conversationId,
      target_choice_public_id: option.id,
      target_choice_kind: option.kind,
      pickup_starts_at: startsAt.toISOString(),
      pickup_ends_at: endsAt.toISOString(),
      accepted_buyer_terms_version: option.kind === "seller_residence"
        ? "2026-08-01"
        : null,
      request_note: note,
      idempotency_key: chatIdempotencyKey("pickup"),
    });
    if (error) throw error;
    return { ok: true, message: "Pickup preference sent to the seller." };
  } catch (error) {
    return toActionError(error, "Pickup preference could not be sent.");
  }
}

export async function authorizeNeighborhoodPickupChoice(
  conversationId: string,
  requestId: string,
  expectedVersion: number,
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (![conversationId, requestId].every((value) => uuidPattern.test(value))) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid pickup request.",
    };
  }
  try {
    const { error } = await client.rpc("authorize_neighborhood_pickup_choice", {
      target_conversation_public_id: conversationId,
      target_pickup_request_public_id: requestId,
      expected_version: Math.floor(expectedVersion),
      idempotency_key: chatIdempotencyKey("pickup"),
    });
    if (error) throw error;
    return { ok: true, message: "Pickup preference accepted." };
  } catch (error) {
    return toActionError(error, "Pickup preference could not be accepted.");
  }
}

export async function getAuthorizedNeighborhoodPickupDetail(
  conversationId: string,
  requestId: string,
): Promise<ActionResult<MarketplacePickupDetail>> {
  const client = supabase;
  if (!client) return unavailable();
  if (![conversationId, requestId].every((value) => uuidPattern.test(value))) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid pickup request.",
    };
  }
  try {
    const { data, error } = await client.rpc(
      "get_authorized_neighborhood_pickup_detail",
      {
        target_conversation_public_id: conversationId,
        target_pickup_request_public_id: requestId,
      },
    );
    if (error) throw error;
    const row = (data && typeof data === "object" && !Array.isArray(data)
      ? data
      : {}) as Row;
    const requestPublicId = stringValue(row.pickup_request_public_id);
    const siteId = stringValue(row.pickup_site_public_id);
    const kind = stringValue(row.site_kind) as MarketplacePickupDetail["kind"];
    const latitude = coordinateValue(row.latitude);
    const longitude = coordinateValue(row.longitude);
    const startsAt = dateValue(row.pickup_starts_at);
    const endsAt = dateValue(row.pickup_ends_at);
    const expiresAt = dateValue(row.expires_at);
    if (
      !uuidPattern.test(requestPublicId) || !uuidPattern.test(siteId) ||
      !["safe_meeting_place", "seller_residence"].includes(kind) ||
      latitude === null || longitude === null ||
      !startsAt || !endsAt || !expiresAt || !stringValue(row.address_line)
    ) {
      throw new Error("INVALID_PICKUP_DETAIL_RESPONSE");
    }
    return {
      ok: true,
      data: {
        requestId: requestPublicId,
        siteId,
        label: stringValue(row.label),
        kind,
        address: stringValue(row.address_line),
        city: stringValue(row.city),
        region: stringValue(row.region),
        ...(stringValue(row.postal_code)
          ? { postalCode: stringValue(row.postal_code) }
          : {}),
        latitude,
        longitude,
        startsAt,
        endsAt,
        expiresAt,
      },
    };
  } catch (error) {
    return toActionError(error, "Pickup details are not available.");
  }
}

export async function listMarketplacePickupRequests(
  conversationId: string,
): Promise<ActionResult<MarketplacePickupRequest[]>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId)) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid conversation.",
    };
  }
  try {
    const { data, error } = await client.rpc(
      "list_marketplace_pickup_requests_v2",
      {
        target_conversation_public_id: conversationId,
      },
    );
    if (error) throw error;
    return {
      ok: true,
      data: rows(data).flatMap<MarketplacePickupRequest>((row) => {
        const requestId = stringValue(row.pickup_request_public_id);
        const state = stringValue(
          row.request_state,
        ) as MarketplacePickupRequest["state"];
        if (
          !uuidPattern.test(requestId) ||
          !["pending", "authorized", "declined", "cancelled", "expired"]
            .includes(state)
        ) return [];
        const choiceId = stringValue(row.choice_public_id);
        const choiceKind = stringValue(row.choice_kind);
        return [{
          id: requestId,
          startsAt: stringValue(row.pickup_starts_at),
          endsAt: stringValue(row.pickup_ends_at),
          ...(stringValue(row.request_note)
            ? { note: stringValue(row.request_note) }
            : {}),
          state,
          version: Math.max(1, Math.floor(numberValue(row.request_version))),
          createdAt: stringValue(row.created_at),
          ...(uuidPattern.test(choiceId) &&
              (choiceKind === "safe_meeting_place" ||
                choiceKind === "seller_residence")
            ? {
              choice: {
                id: choiceId,
                kind: choiceKind,
                label: stringValue(row.choice_label),
                city: stringValue(row.choice_city),
                region: stringValue(row.choice_region),
              },
            }
            : {}),
        }];
      }),
    };
  } catch (error) {
    return toActionError(error, "Pickup requests could not be loaded.");
  }
}

export async function requestMarketplacePickup(
  conversationId: string,
  startsAt: Date,
  endsAt: Date,
  note = "",
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (
    !uuidPattern.test(conversationId) || !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime())
  ) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid pickup window.",
    };
  }
  const safetyIssue = chatSafetyIssue(note);
  if (safetyIssue) {
    return {
      ok: false,
      code: "INVALID",
      reason: chatSafetyMessage(safetyIssue),
    };
  }
  try {
    const { error } = await client.rpc("request_marketplace_pickup_detail", {
      target_conversation_public_id: conversationId,
      pickup_starts_at: startsAt.toISOString(),
      pickup_ends_at: endsAt.toISOString(),
      request_note: note,
      idempotency_key: chatIdempotencyKey("pickup"),
    });
    if (error) throw error;
    return { ok: true, message: "Pickup window requested." };
  } catch (error) {
    return toActionError(error, "Pickup details could not be requested.");
  }
}

export async function listMarketplacePickupOptions(
  conversationId: string,
): Promise<ActionResult<MarketplacePickupOption[]>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId)) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid conversation.",
    };
  }
  try {
    const { data, error } = await client.rpc(
      "list_marketplace_pickup_options",
      {
        target_conversation_public_id: conversationId,
      },
    );
    if (error) throw error;
    return {
      ok: true,
      data: rows(data).flatMap<MarketplacePickupOption>((row) => {
        const optionId = stringValue(row.pickup_site_public_id);
        const kind = stringValue(
          row.site_kind,
        ) as MarketplacePickupOption["kind"];
        if (
          !uuidPattern.test(optionId) ||
          !["public_meeting_place", "commercial_site"].includes(kind)
        ) return [];
        return [{
          id: optionId,
          label: stringValue(row.label),
          city: stringValue(row.city),
          region: stringValue(row.region),
          kind,
        }];
      }),
    };
  } catch (error) {
    return toActionError(
      error,
      "Approved pickup locations could not be loaded.",
    );
  }
}

export async function authorizeMarketplacePickup(
  conversationId: string,
  requestId: string,
  siteId: string,
  expectedVersion: number,
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (
    ![conversationId, requestId, siteId].every((value) =>
      uuidPattern.test(value)
    )
  ) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid pickup request and location.",
    };
  }
  try {
    const { error } = await client.rpc("authorize_marketplace_pickup_detail", {
      target_conversation_public_id: conversationId,
      target_pickup_request_public_id: requestId,
      target_pickup_site_public_id: siteId,
      expected_version: Math.floor(expectedVersion),
      idempotency_key: chatIdempotencyKey("pickup"),
    });
    if (error) throw error;
    return { ok: true, message: "Verified pickup details released." };
  } catch (error) {
    return toActionError(error, "Pickup details could not be authorized.");
  }
}

export async function getAuthorizedMarketplacePickupDetail(
  conversationId: string,
  requestId: string,
): Promise<ActionResult<MarketplacePickupDetail>> {
  const client = supabase;
  if (!client) return unavailable();
  if (![conversationId, requestId].every((value) => uuidPattern.test(value))) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid pickup request.",
    };
  }
  try {
    const { data, error } = await client.rpc(
      "get_authorized_marketplace_pickup_detail",
      {
        target_conversation_public_id: conversationId,
        target_pickup_request_public_id: requestId,
      },
    );
    if (error) throw error;
    const row = (data && typeof data === "object" && !Array.isArray(data)
      ? data
      : {}) as Row;
    const requestPublicId = stringValue(row.pickup_request_public_id);
    const siteId = stringValue(row.pickup_site_public_id);
    const kind = stringValue(row.site_kind) as MarketplacePickupDetail["kind"];
    const address = stringValue(row.address_line);
    const city = stringValue(row.city);
    const region = stringValue(row.region);
    const latitude = coordinateValue(row.latitude);
    const longitude = coordinateValue(row.longitude);
    const startsAt = dateValue(row.pickup_starts_at);
    const endsAt = dateValue(row.pickup_ends_at);
    const expiresAt = dateValue(row.expires_at);
    if (
      !uuidPattern.test(requestPublicId) ||
      !uuidPattern.test(siteId) ||
      !["public_meeting_place", "commercial_site"].includes(kind) ||
      !address || !city || !region || !startsAt || !endsAt || !expiresAt ||
      latitude === null || latitude < -90 || latitude > 90 ||
      longitude === null || longitude < -180 || longitude > 180
    ) {
      throw new Error("INVALID_PICKUP_DETAIL_RESPONSE");
    }
    return {
      ok: true,
      data: {
        requestId: requestPublicId,
        siteId,
        label: stringValue(row.label),
        kind,
        address,
        city,
        region,
        ...(stringValue(row.postal_code)
          ? { postalCode: stringValue(row.postal_code) }
          : {}),
        latitude,
        longitude,
        startsAt,
        endsAt,
        expiresAt,
      },
    };
  } catch (error) {
    return toActionError(error, "Verified pickup details are not available.");
  }
}

export async function resolveMarketplacePickup(
  conversationId: string,
  requestId: string,
  resolution: "cancel" | "decline" | "revoke",
  expectedVersion: number,
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (![conversationId, requestId].every((value) => uuidPattern.test(value))) {
    return {
      ok: false,
      code: "INVALID",
      reason: "Choose a valid pickup request.",
    };
  }
  try {
    const { error } = await client.rpc("resolve_marketplace_pickup_request", {
      target_conversation_public_id: conversationId,
      target_pickup_request_public_id: requestId,
      resolution,
      expected_version: Math.floor(expectedVersion),
      idempotency_key: chatIdempotencyKey("pickup"),
    });
    if (error) throw error;
    return { ok: true, message: "Pickup request updated." };
  } catch (error) {
    return toActionError(error, "Pickup request could not be updated.");
  }
}
