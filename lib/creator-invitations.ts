import { toActionError } from '@/lib/errors';
import { createMarketplaceIdempotencyKey } from '@/lib/marketplace-api';
import { createAccountBoundSupabaseClient } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';
import type { CreatorInvitation, CreatorInvitationStatus } from '@/types/creator-invitations';

type Row = Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function clientFor(expectedUserId: string) {
  if (!uuidPattern.test(expectedUserId)) throw Object.assign(new Error('The active account changed.'), { status: 401 });
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) throw Object.assign(new Error('Live invitation services are not configured.'), { code: 'CONFIG_REQUIRED' });
  return client;
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function mapCreatorInvitation(value: unknown): CreatorInvitation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid invitation');
  const row = value as Row;
  const status = row.status;
  if (!['pending', 'accepted', 'declined', 'withdrawn', 'expired'].includes(String(status))) throw new Error('Invalid invitation status');
  const id = String(row.public_id ?? '');
  const businessId = String(row.business_id ?? '');
  const recipientId = String(row.recipient_public_id ?? '');
  if (!uuidPattern.test(id) || !uuidPattern.test(businessId) || !uuidPattern.test(recipientId)) throw new Error('Invalid invitation reference');
  const startsAt = String(row.event_starts_at ?? '');
  const endsAt = String(row.event_ends_at ?? '');
  const createdAt = String(row.created_at ?? '');
  const respondedAt = optionalText(row.responded_at);
  const title = String(row.title ?? '').trim();
  const message = String(row.message ?? '').trim();
  const businessName = String(row.business_name ?? '').trim();
  const recipientName = String(row.recipient_name ?? '').trim();
  const parsedDates = [startsAt, endsAt, createdAt, ...(respondedAt ? [respondedAt] : [])]
    .map((date) => new Date(date).getTime());
  if (parsedDates.some((date) => !Number.isFinite(date)) || parsedDates[1] <= parsedDates[0]) throw new Error('Invalid invitation date');
  if (!businessName || !recipientName || title.length < 3 || title.length > 80 || message.length < 10 || message.length > 800) {
    throw new Error('Invalid invitation content');
  }
  if (typeof row.is_recipient !== 'boolean') throw new Error('Invalid invitation participant');
  return {
    id,
    businessId,
    businessName,
    senderPublicId: optionalText(row.sender_public_id),
    senderName: optionalText(row.sender_name) ?? 'Former business member',
    recipientPublicId: recipientId,
    recipientName,
    title,
    message,
    responseNote: optionalText(row.response_note),
    startsAt,
    endsAt,
    status: status as CreatorInvitationStatus,
    createdAt,
    respondedAt,
    isRecipient: row.is_recipient,
  };
}

export async function loadCreatorInvitations(expectedUserId: string): Promise<ActionResult<CreatorInvitation[]>> {
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.from('my_creator_invitations').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return { ok: true, data: (data ?? []).map(mapCreatorInvitation) };
  } catch (error) {
    return toActionError(error, 'Invitations could not be loaded.');
  }
}

export async function canInviteCreator(publicProfileId: string, expectedUserId: string): Promise<ActionResult<boolean>> {
  if (!uuidPattern.test(publicProfileId)) return { ok: false, code: 'INVALID', reason: 'This reviewer reference is invalid.' };
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.rpc('can_receive_creator_invitation', { target_profile_public_id: publicProfileId });
    if (error) throw error;
    return { ok: true, data: data === true };
  } catch (error) {
    return toActionError(error, 'Invitation eligibility could not be checked.');
  }
}

export async function setCreatorInvitationConsent(enabled: boolean, expectedUserId: string): Promise<ActionResult<boolean>> {
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.rpc('set_creator_invitation_consent', { next_value: enabled });
    if (error) throw error;
    return { ok: true, data: data === true, message: enabled ? 'Business invitations enabled.' : 'Business invitations disabled.' };
  } catch (error) {
    return toActionError(error, 'Invitation privacy could not be updated.');
  }
}

export async function sendCreatorInvitation(input: {
  businessId: string;
  recipientPublicId: string;
  title: string;
  message: string;
  startsAt: string;
  endsAt: string;
  independenceAcknowledged: boolean;
  idempotencyKey?: string;
}, expectedUserId: string): Promise<ActionResult<string>> {
  if (!uuidPattern.test(input.businessId) || !uuidPattern.test(input.recipientPublicId)) {
    return { ok: false, code: 'INVALID', reason: 'Check the business and reviewer.' };
  }
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.rpc('send_creator_invitation', {
      target_business_id: input.businessId,
      target_profile_public_id: input.recipientPublicId,
      invite_title: input.title.trim(),
      invite_message: input.message.trim(),
      invite_starts_at: input.startsAt,
      invite_ends_at: input.endsAt,
      no_review_required_ack: input.independenceAcknowledged,
      idempotency_key: input.idempotencyKey ?? createMarketplaceIdempotencyKey('invite'),
    });
    if (error) throw error;
    if (typeof data !== 'string' || !uuidPattern.test(data)) throw new Error('Invalid invitation receipt');
    return { ok: true, data, message: 'Invitation sent privately.' };
  } catch (error) {
    return toActionError(error, 'This invitation could not be sent.');
  }
}

export async function respondCreatorInvitation(
  invitationId: string,
  decision: 'accepted' | 'declined',
  note: string,
  expectedUserId: string
): Promise<ActionResult<CreatorInvitationStatus>> {
  if (!uuidPattern.test(invitationId)) return { ok: false, code: 'INVALID', reason: 'This invitation is invalid.' };
  try {
    const client = await clientFor(expectedUserId);
    const { data, error } = await client.rpc('respond_creator_invitation', {
      target_invitation_public_id: invitationId,
      decision,
      response_message: note.trim() || null,
    });
    if (error) throw error;
    if (data !== 'accepted' && data !== 'declined') throw new Error('Invalid invitation response');
    return { ok: true, data };
  } catch (error) {
    return toActionError(error, 'This invitation response could not be saved.');
  }
}
