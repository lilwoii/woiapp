import { toActionError } from '@/lib/errors';
import { createMarketplaceIdempotencyKey, createSignedMediaUrls } from '@/lib/marketplace-api';
import { stageMediaUpload, type LocalMedia } from '@/lib/media-upload';
import { createAccountBoundSupabaseClient, supabase } from '@/lib/supabase';
import { publicBadgeFromCode, type PublicBadge } from '@/lib/trust-badges';
import type { ActionResult } from '@/types/marketplace';
import type { BusinessPostMediaCandidate, FeedFilter, FeedItem } from '@/types/feed';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function relativeTime(value: unknown) {
  const timestamp = typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return 'Recently';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function dateTimeLabel(value: unknown) {
  const timestamp = typeof value === 'string' ? new Date(value) : null;
  if (!timestamp || !Number.isFinite(timestamp.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function configurationRequired<T>(): ActionResult<T> {
  return { ok: false, code: 'CONFIG_REQUIRED', reason: 'Live social services are not configured.' };
}

async function accountClient(expectedUserId: string) {
  if (!uuidPattern.test(expectedUserId)) throw new Error('ACCOUNT_CHANGED');
  return createAccountBoundSupabaseClient(expectedUserId);
}

async function hydrateFeedRows(
  feedRows: Row[],
  client: SupabaseClient,
): Promise<FeedItem[]> {
  if (!feedRows.length) return [];
  const postIds = feedRows.filter((row) => text(row.feed_type) === 'business_post').map((row) => text(row.content_id)).filter((id) => uuidPattern.test(id));
  const reviewIds = feedRows.filter((row) => text(row.feed_type) === 'user_review').map((row) => text(row.content_id)).filter((id) => uuidPattern.test(id));
  const authorIds = [...new Set(feedRows.map((row) => text(row.author_public_id)).filter((id) => uuidPattern.test(id)))];
  const businessIds = [...new Set(feedRows.map((row) => text(row.business_id)).filter((id) => uuidPattern.test(id)))];
  const [postMediaResult, reviewMediaResult, badgesResult, businessBadgesResult, businessMediaResult] = await Promise.all([
    postIds.length ? client.from('public_business_post_media').select('*').in('post_id', postIds) : Promise.resolve({ data: [], error: null }),
    reviewIds.length ? client.from('public_review_media').select('*').in('review_id', reviewIds) : Promise.resolve({ data: [], error: null }),
    authorIds.length ? client.from('public_profile_badges').select('*').in('subject_public_id', authorIds) : Promise.resolve({ data: [], error: null }),
    businessIds.length ? client.from('public_business_badges').select('*').in('business_id', businessIds) : Promise.resolve({ data: [], error: null }),
    businessIds.length ? client.from('public_business_media').select('*').in('business_id', businessIds).eq('media_role', 'logo') : Promise.resolve({ data: [], error: null }),
  ]);
  if (postMediaResult.error) throw postMediaResult.error;
  if (reviewMediaResult.error) throw reviewMediaResult.error;
  if (badgesResult.error) throw badgesResult.error;
  if (businessBadgesResult.error) throw businessBadgesResult.error;
  if (businessMediaResult.error) throw businessMediaResult.error;
  const postMedia = rows(postMediaResult.data);
  const reviewMedia = rows(reviewMediaResult.data);
  const badges = rows(badgesResult.data);
  const businessBadges = rows(businessBadgesResult.data);
  const businessMedia = rows(businessMediaResult.data);
  const urls = await createSignedMediaUrls(
    [...postMedia, ...reviewMedia, ...businessMedia].map((row) => text(row.storage_path)),
    client,
  );

  return feedRows.map((row) => {
    const type = text(row.feed_type) === 'business_post' ? 'business_post' : 'user_review';
    const id = text(row.content_id);
    const authorId = text(row.author_public_id);
    const media = type === 'business_post'
      ? postMedia.filter((item) => text(item.post_id) === id)
      : reviewMedia.filter((item) => text(item.review_id) === id);
    const badgeRows = type === 'business_post'
      ? businessBadges.filter((item) => text(item.business_id) === text(row.business_id))
      : badges.filter((item) => text(item.subject_public_id) === authorId);
    const itemBadges = badgeRows
      .map((item) => publicBadgeFromCode(text(item.badge_code), text(item.earned_at) || undefined, text(item.expires_at) || undefined))
      .filter((badge): badge is PublicBadge => Boolean(badge));
    return {
      type,
      id,
      businessId: text(row.business_id),
      businessName: text(row.business_name, 'Spottr place'),
      businessSlug: text(row.business_slug),
      businessLogoUrl: urls.get(text(businessMedia.find((item) => text(item.business_id) === text(row.business_id))?.storage_path)),
      authorId: authorId || undefined,
      authorUsername: text(row.author_username) || undefined,
      authorDisplayName: text(row.author_display_name) || undefined,
      body: text(row.body),
      rating: row.rating == null ? undefined : number(row.rating),
      photos: media
        .sort((left, right) => number(left.sort_order) - number(right.sort_order))
        .map((item) => urls.get(text(item.storage_path)))
        .filter((url): url is string => Boolean(url)),
      createdAt: text(row.created_at),
      createdLabel: relativeTime(row.created_at),
      createdDateTimeLabel: dateTimeLabel(row.created_at),
      badges: itemBadges,
    } satisfies FeedItem;
  });
}

export async function fetchBusinessBadges(businessId: string): Promise<ActionResult<PublicBadge[]>> {
  const client = supabase;
  if (!client) return configurationRequired();
  if (!uuidPattern.test(businessId)) return { ok: false, code: 'INVALID', reason: 'This business reference is invalid.' };
  try {
    const { data, error } = await client.from('public_business_badges').select('*').eq('business_id', businessId);
    if (error) throw error;
    return {
      ok: true,
      data: rows(data)
        .map((row) => publicBadgeFromCode(text(row.badge_code), text(row.earned_at) || undefined, text(row.expires_at) || undefined))
        .filter((badge): badge is PublicBadge => Boolean(badge)),
    };
  } catch (error) {
    return toActionError(error, 'Business achievements could not be loaded.');
  }
}

export async function fetchFollowedFeed(
  filter: FeedFilter,
  expectedUserId: string,
  offset = 0
): Promise<ActionResult<{ items: FeedItem[]; hasMore: boolean }>> {
  if (!supabase) return configurationRequired();
  if (
    !uuidPattern.test(expectedUserId) ||
    !['all', 'business_post', 'user_review'].includes(filter) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10_000
  ) {
    return { ok: false, code: 'INVALID', reason: 'This feed request is invalid.' };
  }
  const pageSize = 20;
  try {
    const client = await accountClient(expectedUserId);
    if (!client) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'The active account changed. Open the feed again from the current account.',
      };
    }
    let query = client.from('public_followed_feed').select('*');
    if (filter !== 'all') query = query.eq('feed_type', filter);
    const { data, error } = await query.order('created_at', { ascending: false }).range(offset, offset + pageSize);
    if (error) throw error;
    const page = rows(data);
    return {
      ok: true,
      data: {
        items: await hydrateFeedRows(page.slice(0, pageSize), client),
        hasMore: page.length > pageSize,
      },
    };
  } catch (error) {
    return toActionError(error, 'Your feed could not be loaded.');
  }
}

export async function fetchBusinessPosts(businessId: string, offset = 0): Promise<ActionResult<{ items: FeedItem[]; hasMore: boolean }>> {
  const client = supabase;
  if (!client) return configurationRequired();
  if (!uuidPattern.test(businessId) || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    return { ok: false, code: 'INVALID', reason: 'This post request is invalid.' };
  }
  const pageSize = 20;
  try {
    const { data, error } = await client.from('public_business_posts').select('*').eq('business_id', businessId).order('created_at', { ascending: false }).range(offset, offset + pageSize);
    if (error) throw error;
    const postRows = rows(data).map((row) => ({ ...row, feed_type: 'business_post', content_id: row.post_id }));
    return {
      ok: true,
      data: {
        items: await hydrateFeedRows(postRows.slice(0, pageSize), client),
        hasMore: postRows.length > pageSize,
      },
    };
  } catch (error) {
    return toActionError(error, 'Business posts could not be loaded.');
  }
}

export async function fetchBusinessPostMediaCandidates(businessId: string, expectedUserId: string): Promise<ActionResult<BusinessPostMediaCandidate[]>> {
  if (!uuidPattern.test(businessId) || !uuidPattern.test(expectedUserId)) return { ok: false, code: 'INVALID', reason: 'This media request is invalid.' };
  try {
    const client = await accountClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('list_approved_business_post_media', { target_business_id: businessId });
    if (error) throw error;
    const candidates = rows(data);
    const urls = await createSignedMediaUrls(candidates.map((row) => text(row.storage_path)));
    return { ok: true, data: candidates.flatMap((row) => {
      const id = text(row.asset_id);
      const url = urls.get(text(row.storage_path));
      if (!uuidPattern.test(id) || !url) return [];
      return [{ id, url, width: number(row.width), height: number(row.height), createdAt: text(row.created_at) }];
    }) };
  } catch (error) {
    return toActionError(error, 'Approved post images could not be loaded.');
  }
}

export async function uploadBusinessPostMedia(media: LocalMedia, businessId: string, expectedUserId: string): Promise<ActionResult<string>> {
  try {
    const client = await accountClient(expectedUserId);
    if (!client) return configurationRequired();
    const result = await stageMediaUpload(media, 'business_post', businessId, undefined, client);
    if (!result.ok || !result.data) return result.ok ? { ok: false, code: 'UNKNOWN', reason: 'The upload receipt was incomplete.' } : result;
    return { ok: true, data: result.data.assetId, message: 'Image queued for safety processing. It can be selected after approval.' };
  } catch (error) {
    return toActionError(error, 'This post image could not be uploaded.');
  }
}

export async function createBusinessPost(businessId: string, body: string, assetIds: string[], expectedUserId: string, idempotencyKey = createMarketplaceIdempotencyKey('post')): Promise<ActionResult<string>> {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!uuidPattern.test(businessId) || !uuidPattern.test(expectedUserId) || normalized.length > 500 || (!normalized && !assetIds.length) || assetIds.length > 4 || assetIds.some((id) => !uuidPattern.test(id))) {
    return { ok: false, code: 'INVALID', reason: 'Add a short message or up to four approved images.' };
  }
  try {
    const client = await accountClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('create_business_post', { target_business_id: businessId, post_body: normalized, media_asset_ids: assetIds, idempotency_key: idempotencyKey });
    if (error) throw error;
    const postId = text(data);
    if (!uuidPattern.test(postId)) throw new Error('INVALID_POST_RECEIPT');
    return { ok: true, data: postId };
  } catch (error) {
    return toActionError(error, 'This post could not be published.');
  }
}

export async function deleteBusinessPost(postId: string, expectedUserId: string): Promise<ActionResult<boolean>> {
  if (!uuidPattern.test(postId) || !uuidPattern.test(expectedUserId)) return { ok: false, code: 'INVALID', reason: 'This post request is invalid.' };
  try {
    const client = await accountClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('delete_business_post', { target_post_id: postId });
    if (error) throw error;
    return { ok: true, data: data === true };
  } catch (error) {
    return toActionError(error, 'This post could not be deleted.');
  }
}
