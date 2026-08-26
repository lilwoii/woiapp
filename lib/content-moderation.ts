import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export type ModerationTargetType = 'review' | 'review_comment' | 'business_post' | 'update' | 'response';
export type ModerationDecision = 'approved' | 'rejected';

export type ModerationQueueItem = {
  targetType: ModerationTargetType;
  targetId: string;
  businessId: string;
  businessName: string;
  authorPublicId: string | null;
  authorDisplayName: string;
  body: string;
  rating: number | null;
  context: Record<string, unknown>;
  submittedAt: string;
  updatedAt: string;
};

export type ModerationQueuePage = {
  items: ModerationQueueItem[];
  hasMore: boolean;
  nextOffset: number;
};

export type ModerationResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 'AUTH' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID' | 'NETWORK' | 'UNKNOWN'; reason: string };

type Row = Record<string, unknown>;
type ErrorLike = { code?: string; message?: string; status?: number };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(row: Row, key: string, label: string) {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function requiredUuid(row: Row, key: string, label: string) {
  const value = requiredString(row, key, label);
  if (!uuidPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function validDate(row: Row, key: string, label: string) {
  const value = requiredString(row, key, label);
  if (!Number.isFinite(new Date(value).getTime())) throw new Error(`Invalid ${label}`);
  return value;
}

export function mapModerationQueuePage(value: unknown, offset = 0): ModerationQueuePage {
  if (!Array.isArray(value)) throw new Error('Invalid moderation queue');
  const items = value.map((candidate): ModerationQueueItem => {
    if (!isRow(candidate)) throw new Error('Invalid moderation queue item');
    const targetType = candidate.target_type;
    if (targetType !== 'review' && targetType !== 'review_comment' && targetType !== 'business_post' && targetType !== 'update' && targetType !== 'response') {
      throw new Error('Invalid moderation target type');
    }
    const authorPublicId = candidate.author_public_id;
    if (authorPublicId !== null && (typeof authorPublicId !== 'string' || !uuidPattern.test(authorPublicId))) {
      throw new Error('Invalid public author reference');
    }
    const rating = candidate.rating;
    if (rating !== null && (!Number.isInteger(rating) || Number(rating) < 1 || Number(rating) > 5)) {
      throw new Error('Invalid review rating');
    }
    return {
      targetType,
      targetId: requiredUuid(candidate, 'target_id', 'target reference'),
      businessId: requiredUuid(candidate, 'business_id', 'business reference'),
      businessName: requiredString(candidate, 'business_name', 'business name'),
      authorPublicId: authorPublicId as string | null,
      authorDisplayName:
        typeof candidate.author_display_name === 'string' && candidate.author_display_name.trim()
          ? candidate.author_display_name.trim()
          : 'Deleted account',
      body: requiredString(candidate, 'body', 'content body'),
      rating: rating === null ? null : Number(rating),
      context: isRow(candidate.context) ? candidate.context : {},
      submittedAt: validDate(candidate, 'submitted_at', 'submission date'),
      updatedAt: validDate(candidate, 'updated_at', 'update date'),
    };
  });
  return {
    items,
    hasMore: value.some((candidate) => isRow(candidate) && candidate.has_more === true),
    nextOffset: offset + items.length,
  };
}

function failure<T>(error: unknown, fallback: string): ModerationResult<T> {
  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.status === 401 || message.includes('not authenticated') || message.includes('jwt')) {
    return { ok: false, code: 'AUTH', reason: 'Sign in again before opening moderation.' };
  }
  if (message.includes('aal2') || message.includes('authenticator')) {
    return { ok: false, code: 'FORBIDDEN', reason: 'Verify a current authenticator code before moderating content.' };
  }
  if (candidate?.status === 403 || candidate?.code === '42501' || message.includes('platform moderation role')) {
    return { ok: false, code: 'FORBIDDEN', reason: 'An active Spottr moderator or administrator role is required.' };
  }
  if (candidate?.code === '40001' || message.includes('moderation_target_changed') || message.includes('moderation_state_changed')) {
    return { ok: false, code: 'CONFLICT', reason: 'This item changed while you were reviewing it. Reload the queue.' };
  }
  if (candidate?.code === '22023' || message.includes('review_media_not_ready') || message.includes('invalid')) {
    return { ok: false, code: 'INVALID', reason: message.includes('media') ? 'Every review photo must be clean and approved before this review can be approved.' : fallback };
  }
  if (message.includes('fetch') || message.includes('network') || candidate?.status === 0) {
    return { ok: false, code: 'NETWORK', reason: 'Moderation could not reach Spottr. Check the connection and retry.' };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

async function secureClient() {
  if (!isSupabaseConfigured || !supabase) throw Object.assign(new Error('Live services are not configured.'), { code: 'CONFIG' });
  const [{ data: userData, error: userError }, assurance] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (userError || !userData.user) throw Object.assign(userError ?? new Error('Not authenticated'), { status: 401 });
  if (assurance.error) throw assurance.error;
  if (assurance.data.currentLevel !== 'aal2') throw Object.assign(new Error('AAL2 authenticator verification required'), { status: 403 });
  return supabase;
}

export async function loadModerationQueue(offset = 0, limit = 30): Promise<ModerationResult<ModerationQueuePage>> {
  try {
    const client = await secureClient();
    const safeOffset = Math.min(Math.max(Math.floor(offset), 0), 100);
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const queueArgs = {
      result_limit: Math.min(safeOffset + safeLimit + 1, 100),
      result_offset: 0,
    };
    const [standard, posts] = await Promise.all([
      client.rpc('list_pending_content_moderation', queueArgs),
      client.rpc('list_reported_business_posts', queueArgs),
    ]);
    if (standard.error) throw standard.error;
    if (posts.error) throw posts.error;
    const combined = [...(Array.isArray(standard.data) ? standard.data : []), ...(Array.isArray(posts.data) ? posts.data : [])]
      .sort((left, right) => String(left.submitted_at).localeCompare(String(right.submitted_at)));
    const sourceHasMore = combined.some((row) => isRow(row) && row.has_more === true);
    const page = combined.slice(safeOffset, safeOffset + safeLimit);
    if (page.length && (sourceHasMore || combined.length > safeOffset + safeLimit)) {
      page[0] = { ...page[0], has_more: true };
    }
    return { ok: true, data: mapModerationQueuePage(page, safeOffset) };
  } catch (error) {
    return failure(error, 'The moderation queue could not be loaded.');
  }
}

export async function decideModerationItem(
  item: ModerationQueueItem,
  decision: ModerationDecision,
  reason: string
): Promise<ModerationResult<{ updatedAt: string }>> {
  try {
    const cleanReason = reason.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (cleanReason.length < 3 || cleanReason.length > 1000) {
      return { ok: false, code: 'INVALID', reason: 'Record a moderation reason from 3 to 1,000 characters.' };
    }
    const client = await secureClient();
    const { data, error } = item.targetType === 'review_comment'
      ? await client.rpc('decide_reported_review_comment', {
          target_comment_id: item.targetId,
          decision,
          moderation_reason: cleanReason,
          expected_updated_at: item.updatedAt,
        })
      : item.targetType === 'business_post'
        ? await client.rpc('decide_reported_business_post', {
            target_post_id: item.targetId,
            decision,
            moderation_reason: cleanReason,
            expected_updated_at: item.updatedAt,
          })
      : await client.rpc('decide_content_moderation', {
          target_type: item.targetType,
          target_id: item.targetId,
          decision,
          moderation_reason: cleanReason,
          expected_updated_at: item.updatedAt,
        });
    if (error) throw error;
    if (item.targetType === 'review_comment' || item.targetType === 'business_post') {
      if (typeof data !== 'string' || !Number.isFinite(new Date(data).getTime())) {
        throw new Error('Invalid reported comment decision receipt');
      }
      return { ok: true, data: { updatedAt: data } };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!isRow(row)) throw new Error('Invalid moderation decision receipt');
    return { ok: true, data: { updatedAt: validDate(row, 'decided_updated_at', 'decision date') } };
  } catch (error) {
    return failure(error, 'This moderation decision could not be recorded.');
  }
}
