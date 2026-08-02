import { toActionError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { ActionResult, BusinessCategory } from '@/types/marketplace';
import type {
  MarketplaceChatMessage,
  MarketplaceConversation,
  MarketplaceTypingMember,
} from '@/types/chat';

type Row = Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const categories = new Set<BusinessCategory>([
  'food_truck',
  'restaurant',
  'pop_up',
  'cafe_bakery',
  'home_kitchen',
]);

function unavailable<T>(): ActionResult<T> {
  return { ok: false, code: 'CONFIG_REQUIRED', reason: 'Secure Spottr chat is not configured.' };
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Row => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
}

function chatIdempotencyKey(scope: 'start' | 'send' | 'close' | 'report') {
  const cryptoApi = globalThis.crypto;
  let nonce: string | undefined = cryptoApi?.randomUUID?.();
  if (!nonce && cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  nonce ??= `${Date.now().toString(36)}-${Math.round(globalThis.performance?.now?.() ?? 0).toString(36)}`;
  return `spottr:chat:${scope}:${nonce}`;
}

async function signedUrls(paths: string[]) {
  const client = supabase;
  const unique = [...new Set(paths.filter(Boolean))];
  const result = new Map<string, string>();
  if (!client || !unique.length) return result;
  for (let offset = 0; offset < unique.length; offset += 100) {
    const { data, error } = await client.storage
      .from('spottr-media')
      .createSignedUrls(unique.slice(offset, offset + 100), 60 * 60);
    if (error) continue;
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) result.set(entry.path, entry.signedUrl);
    }
  }
  return result;
}

export async function startMarketplaceConversation(businessId: string): Promise<ActionResult<string>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(businessId)) return { ok: false, code: 'INVALID', reason: 'Choose a valid business.' };
  try {
    const { data, error } = await client.rpc('start_marketplace_conversation', {
      target_business_id: businessId,
      idempotency_key: chatIdempotencyKey('start'),
    });
    if (error) throw error;
    const id = stringValue((data as Row | null)?.conversation_public_id);
    if (!uuidPattern.test(id)) throw new Error('INVALID_CHAT_RESPONSE');
    return { ok: true, data: id };
  } catch (error) {
    return toActionError(error, 'This conversation could not be started.');
  }
}

export async function isMarketplaceChatAvailable(businessId: string): Promise<boolean> {
  const client = supabase;
  if (!client || !uuidPattern.test(businessId)) return false;
  const { data, error } = await client.rpc('is_marketplace_chat_available', {
    target_business_id: businessId,
  });
  return !error && data === true;
}

export async function listMarketplaceConversations(): Promise<ActionResult<MarketplaceConversation[]>> {
  const client = supabase;
  if (!client) return unavailable();
  try {
    const { data, error } = await client.rpc('list_my_marketplace_conversations', {
      cursor_time: null,
      cursor_public_id: null,
      result_limit: 50,
    });
    if (error) throw error;
    const sourceRows = rows(data);
    const urls = await signedUrls(sourceRows.map((row) => stringValue(row.counterpart_avatar_path)));
    const conversations = sourceRows.flatMap<MarketplaceConversation>((row) => {
      const id = stringValue(row.conversation_public_id);
      const businessId = stringValue(row.business_id);
      const profileId = stringValue(row.counterpart_public_profile_id);
      const category = stringValue(row.business_kind) as BusinessCategory;
      const state = stringValue(row.conversation_state) as MarketplaceConversation['state'];
      if (!uuidPattern.test(id) || !uuidPattern.test(businessId) || !uuidPattern.test(profileId) ||
          !categories.has(category) || !['open', 'closed_by_customer', 'closed_by_merchant', 'restricted'].includes(state)) return [];
      const avatarPath = stringValue(row.counterpart_avatar_path);
      return [{
        id,
        businessId,
        businessName: stringValue(row.business_name),
        businessCategory: category,
        state,
        counterpart: {
          profileId,
          name: stringValue(row.counterpart_name) || 'Spottr member',
          username: stringValue(row.counterpart_username),
          ...(urls.get(avatarPath) ? { avatarUrl: urls.get(avatarPath) } : {}),
        },
        ...(stringValue(row.last_message_preview) ? { lastMessage: stringValue(row.last_message_preview) } : {}),
        ...(stringValue(row.last_message_at) ? { lastMessageAt: stringValue(row.last_message_at) } : {}),
        unreadCount: Math.max(0, Math.floor(numberValue(row.unread_count))),
        createdAt: stringValue(row.created_at),
      }];
    });
    return { ok: true, data: conversations };
  } catch (error) {
    return toActionError(error, 'Conversations could not be loaded.');
  }
}

export async function getMarketplaceMessages(conversationId: string): Promise<ActionResult<MarketplaceChatMessage[]>> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId)) return { ok: false, code: 'INVALID', reason: 'Choose a valid conversation.' };
  try {
    const { data, error } = await client.rpc('get_marketplace_messages', {
      target_conversation_public_id: conversationId,
      before_sequence: null,
      result_limit: 100,
    });
    if (error) throw error;
    const sourceRows = rows(data);
    const paths = sourceRows.flatMap((row) => [
      stringValue(row.sender_avatar_path),
      ...rows(row.attachments).map((attachment) => stringValue(attachment.storage_path)),
    ]);
    const urls = await signedUrls(paths);
    const messages = sourceRows.flatMap<MarketplaceChatMessage>((row) => {
      const id = stringValue(row.message_public_id);
      const profileId = stringValue(row.sender_public_profile_id);
      if (!uuidPattern.test(id) || !uuidPattern.test(profileId)) return [];
      const avatarPath = stringValue(row.sender_avatar_path);
      const visibility = stringValue(row.visibility) as MarketplaceChatMessage['visibility'];
      return [{
        id,
        sequence: Math.max(0, Math.floor(numberValue(row.sequence))),
        sender: {
          profileId,
          name: stringValue(row.sender_name) || 'Spottr member',
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
            ...(numberValue(attachment.width) > 0 ? { width: numberValue(attachment.width) } : {}),
            ...(numberValue(attachment.height) > 0 ? { height: numberValue(attachment.height) } : {}),
          }];
        }),
        visibility: ['visible', 'moderated', 'removed'].includes(visibility) ? visibility : 'removed',
        sentAt: stringValue(row.sent_at),
        ...(stringValue(row.read_by_counterpart_at) ? { readAt: stringValue(row.read_by_counterpart_at) } : {}),
      }];
    });
    return { ok: true, data: messages.sort((a, b) => a.sequence - b.sequence) };
  } catch (error) {
    return toActionError(error, 'Messages could not be loaded.');
  }
}

export async function sendMarketplaceMessage(
  conversationId: string,
  body: string,
  mediaAssetIds: string[] = []
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(conversationId) || mediaAssetIds.some((id) => !uuidPattern.test(id))) {
    return { ok: false, code: 'INVALID', reason: 'The message contains an invalid reference.' };
  }
  try {
    const { error } = await client.rpc('send_marketplace_message', {
      target_conversation_public_id: conversationId,
      message_body: body,
      media_asset_ids: mediaAssetIds,
      idempotency_key: chatIdempotencyKey('send'),
    });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return toActionError(error, 'This message could not be sent.');
  }
}

export async function setMarketplaceTyping(conversationId: string, isTyping: boolean) {
  const client = supabase;
  if (!client || !uuidPattern.test(conversationId)) return;
  await client.rpc('set_marketplace_typing', {
    target_conversation_public_id: conversationId,
    is_typing: isTyping,
  });
}

export async function getMarketplaceTyping(conversationId: string): Promise<MarketplaceTypingMember[]> {
  const client = supabase;
  if (!client || !uuidPattern.test(conversationId)) return [];
  const { data, error } = await client.rpc('get_marketplace_typing', {
    target_conversation_public_id: conversationId,
  });
  if (error) return [];
  const sourceRows = rows(data);
  const urls = await signedUrls(sourceRows.map((row) => stringValue(row.avatar_path)));
  return sourceRows.flatMap((row) => {
    const profileId = stringValue(row.public_profile_id);
    if (!uuidPattern.test(profileId)) return [];
    const avatarPath = stringValue(row.avatar_path);
    return [{
      profileId,
      name: stringValue(row.name) || 'Spottr member',
      username: stringValue(row.username),
      expiresAt: stringValue(row.expires_at),
      ...(urls.get(avatarPath) ? { avatarUrl: urls.get(avatarPath) } : {}),
    }];
  });
}

export async function markMarketplaceConversationRead(conversationId: string, sequence: number) {
  const client = supabase;
  if (!client || !uuidPattern.test(conversationId) || sequence < 0) return;
  await client.rpc('mark_marketplace_conversation_read', {
    target_conversation_public_id: conversationId,
    through_sequence: Math.floor(sequence),
  });
}

export async function reportMarketplaceMessage(messageId: string): Promise<ActionResult> {
  const client = supabase;
  if (!client) return unavailable();
  if (!uuidPattern.test(messageId)) return { ok: false, code: 'INVALID', reason: 'Choose a valid message.' };
  try {
    const { error } = await client.rpc('report_marketplace_message', {
      target_message_public_id: messageId,
      report_reason: 'unsafe',
      report_detail: 'Submitted from the in-chat safety control for staff review.',
      idempotency_key: chatIdempotencyKey('report'),
    });
    if (error) throw error;
    return { ok: true, message: 'Message reported for staff review.' };
  } catch (error) {
    return toActionError(error, 'This message could not be reported.');
  }
}
