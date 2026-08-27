import { toActionError } from '@/lib/errors';
import { featureFlags } from '@/lib/features';
import { mapLogoPaths } from '@/lib/map-inventory';
import { publicBadgeFromCode, type PublicBadge } from '@/lib/trust-badges';
import { stageMediaUpload, type LocalMedia } from '@/lib/media-upload';
import {
  createAccountBoundSupabaseClient,
  supabase,
} from '@/lib/supabase';
import {
  ActionResult,
  BusinessCategory,
  BusinessUpdate,
  MenuSection,
  OwnerUpdateInput,
  PaymentMethod,
  Place,
  Review,
  ReviewInput,
  VenueStatus,
  WeeklyHours,
} from '@/types/marketplace';
import type { MapInventoryFeature, MapViewport } from '@/types/map';
import type { PublicProfile, PublicProfileLink, PublicProfileReview } from '@/types/social';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type PublicDiscoveryRequest =
  | {
      operation: 'map';
      west_longitude: number;
      south_latitude: number;
      east_longitude: number;
      north_latitude: number;
      map_zoom: number;
      requested_kinds: BusinessCategory[];
      max_features: number;
    }
  | {
      operation: 'nearby';
      search_lat: number;
      search_lng: number;
      radius_meters: number;
      result_limit: number;
      result_offset: number;
    }
  | {
      operation: 'search';
      search_text: string;
      result_limit: number;
      result_offset: number;
    };
type PublicDiscoveryResponse<TOperation extends PublicDiscoveryRequest['operation']> = {
  operation: TOperation;
  rows: Row[];
  sponsored: Row | null;
};
export type MarketplacePage = {
  places: Place[];
  hasMore: boolean;
  nextOffset: number;
};

export type ReviewSort = 'recent' | 'top';

type MarketplaceFetchOptions = {
  expectedUserId?: string;
  includeDetails?: boolean;
  includeBusinessIds?: string[];
  managedBusinessIds?: string[];
  onlyIncludedBusinesses?: boolean;
  resultLimit?: number;
  resultOffset?: number;
  origin?: {
    latitude: number;
    longitude: number;
    radiusMeters?: number;
  };
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
let actionIdempotencySequence = 0;

function configurationRequired<T = undefined>(): ActionResult<T> {
  return {
    ok: false,
    code: 'CONFIG_REQUIRED',
    reason: 'Live Spottr services are not configured for this build.',
  };
}

function accountChanged<T = undefined>(): ActionResult<T> {
  return {
    ok: false,
    code: 'AUTH_REQUIRED',
    reason: 'The active account changed. Try again from the current account.',
  };
}

async function marketplaceMutationClient(
  expectedUserId?: string,
): Promise<SupabaseClient | null> {
  if (!expectedUserId) return null;
  return createAccountBoundSupabaseClient(expectedUserId);
}

async function invokePublicDiscovery<TRequest extends PublicDiscoveryRequest>(
  request: TRequest,
): Promise<PublicDiscoveryResponse<TRequest['operation']>> {
  const client = supabase;
  if (!client) throw new Error('PUBLIC_DISCOVERY_NOT_CONFIGURED');

  const { data, error } = await client.functions.invoke<
    PublicDiscoveryResponse<TRequest['operation']>
  >('public-discovery', { body: request });
  if (error) throw error;
  if (
    !data ||
    data.operation !== request.operation ||
    !Array.isArray(data.rows)
  ) {
    throw new Error('INVALID_PUBLIC_DISCOVERY_RESPONSE');
  }
  const sponsored = data.sponsored ?? null;
  if (sponsored !== null && (typeof sponsored !== 'object' || Array.isArray(sponsored))) {
    throw new Error('INVALID_PUBLIC_DISCOVERY_RESPONSE');
  }
  return {
    operation: data.operation,
    rows: rows(data.rows),
    sponsored: sponsored as Row | null,
  };
}

function toDiscoveryActionError<T>(error: unknown, fallback: string): ActionResult<T> {
  const result = toActionError(error, fallback);
  if (!result.ok && result.code === 'RATE_LIMITED') {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      reason: 'The map is busy. Try again shortly.',
    };
  }
  return result;
}

export function createMarketplaceIdempotencyKey(
  scope: 'review' | 'update' | 'response' | 'sponsor' | 'post' | 'invite'
) {
  const cryptoApi = globalThis.crypto;
  let nonce: string | undefined = cryptoApi?.randomUUID?.();
  if (!nonce && cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  actionIdempotencySequence =
    (actionIdempotencySequence + 1) % Number.MAX_SAFE_INTEGER;
  nonce ??= `${Date.now().toString(36)}-${actionIdempotencySequence.toString(36)}-${Math.round(
    globalThis.performance?.now?.() ?? 0
  ).toString(36)}`;
  return `spottr:${scope}:${nonce}`;
}

function actionIdempotencyKey(
  supplied: string | undefined,
  scope: 'review' | 'update' | 'response' | 'sponsor' | 'post' | 'invite'
) {
  const key = supplied ?? createMarketplaceIdempotencyKey(scope);
  if (!idempotencyPattern.test(key)) {
    throw new Error('INVALID_IDEMPOTENCY_KEY');
  }
  return key;
}

const categoryLabels: Record<BusinessCategory, string> = {
  food_truck: 'Food truck',
  restaurant: 'Restaurant',
  pop_up: 'Pop-up',
  cafe_bakery: 'Café & bakery',
  home_kitchen: 'Neighborhood kitchen',
};

const categoryAccents: Record<BusinessCategory, string> = {
  food_truck: '#F15A3A',
  restaurant: '#276655',
  pop_up: '#B6422E',
  cafe_bakery: '#B67A2A',
  home_kitchen: '#53725F',
};

const paymentLabels: Record<string, PaymentMethod> = {
  cash: 'Cash',
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  cash_app: 'Cash App',
  venmo: 'Venmo',
};

const paymentKeys = Object.fromEntries(
  Object.entries(paymentLabels).map(([key, label]) => [label, key])
) as Record<PaymentMethod, string>;

const weekdayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((entry) => entry && typeof entry === 'object') as Row[]) : [];
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export async function fetchMyTrustBadges(
  expectedUserId: string
): Promise<ActionResult<PublicBadge[]>> {
  if (!uuidPattern.test(expectedUserId)) {
    return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to view earned badges.' };
  }
  try {
    const client = await createAccountBoundSupabaseClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('get_my_profile_badges');
    if (error) throw error;
    const badges = rows(data)
      .map((entry) => publicBadgeFromCode(
        stringValue(entry.badge_code),
        stringValue(entry.earned_at) || undefined,
        stringValue(entry.expires_at) || undefined
      ))
      .filter((badge): badge is PublicBadge => Boolean(badge));
    return { ok: true, data: badges };
  } catch (error) {
    return toActionError(error, 'Your badges could not be loaded.');
  }
}

function publicProfileLinks(value: unknown): PublicProfileLink[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Row;
    const label = stringValue(row.label).trim();
    const url = stringValue(row.url).trim();
    if (!label || !safeHttpsProfileLink(url)) return [];
    return [{ label, url }];
  });
}

function safeHttpsProfileLink(candidate: string) {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function fetchPublicProfile(
  publicId: string,
  resultOffset = 0
): Promise<ActionResult<PublicProfile>> {
  const client = supabase;
  if (!client) return configurationRequired();
  if (!uuidPattern.test(publicId) || !Number.isInteger(resultOffset) || resultOffset < 0 || resultOffset > 10_000) {
    return { ok: false, code: 'INVALID', reason: 'This profile link is invalid.' };
  }

  const pageSize = 20;
  try {
    const [profileResult, reviewsResult, badgesResult] = await Promise.all([
      client.from('public_profile_directory').select('*').eq('public_id', publicId).maybeSingle(),
      client
        .from('public_reviews')
        .select('*')
        .eq('author_public_id', publicId)
        .order('created_at', { ascending: false })
        .range(resultOffset, resultOffset + pageSize),
      client.from('public_profile_badges').select('*').eq('subject_public_id', publicId),
    ]);
    if (profileResult.error) throw profileResult.error;
    if (reviewsResult.error) throw reviewsResult.error;
    if (badgesResult.error) throw badgesResult.error;
    if (!profileResult.data) {
      return { ok: false, code: 'NOT_FOUND', reason: 'This profile is unavailable.' };
    }

    const profile = profileResult.data as Row;
    const reviewRows = rows(reviewsResult.data);
    const hasMoreReviews = reviewRows.length > pageSize;
    const pageRows = reviewRows.slice(0, pageSize);
    const reviewIds = pageRows.map((row) => stringValue(row.review_id)).filter((id) => uuidPattern.test(id));
    const businessIds = [...new Set(pageRows.map((row) => stringValue(row.business_id)).filter((id) => uuidPattern.test(id)))];
    const [businessesResult, mediaResult, reactionsResult, commentsResult] = await Promise.all([
      businessIds.length
        ? client.from('public_business_directory').select('business_id,name,slug').in('business_id', businessIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? client.from('public_review_media').select('*').in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? client.from('public_review_reaction_summary').select('*').in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? client
            .from('public_profile_review_comments')
            .select('*')
            .eq('review_author_public_id', publicId)
            .in('review_id', reviewIds)
            .order('created_at', { ascending: true })
            .limit(200)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (businessesResult.error) throw businessesResult.error;
    if (mediaResult.error) throw mediaResult.error;
    if (reactionsResult.error) throw reactionsResult.error;
    if (commentsResult.error) throw commentsResult.error;
    const mediaRows = rows(mediaResult.data);
    const reactionRows = rows(reactionsResult.data);
    const commentRows = rows(commentsResult.data);
    const mediaUrls = await createSignedMediaUrls([
      stringValue(profile.avatar_path),
      stringValue(profile.banner_path),
      ...mediaRows.map((row) => stringValue(row.storage_path)),
      ...commentRows.map((row) => stringValue(row.author_avatar_path)),
    ]);
    const businesses = new Map(rows(businessesResult.data).map((row) => [stringValue(row.business_id), row]));
    const profileReviews: PublicProfileReview[] = pageRows.map((review) => {
      const reviewId = stringValue(review.review_id);
      const businessId = stringValue(review.business_id);
      const business = businesses.get(businessId);
      const reaction = reactionRows.find((row) => stringValue(row.review_id) === reviewId);
      const viewerReaction = numberValue(reaction?.viewer_reaction);
      return {
        id: reviewId,
        businessId,
        businessName: stringValue(business?.name, 'Spottr place'),
        businessSlug: stringValue(business?.slug),
        rating: numberValue(review.rating),
        body: stringValue(review.body),
        postedAt: stringValue(review.created_at),
        postedLabel: relativeTime(review.created_at),
        photos: mediaRows
          .filter((row) => stringValue(row.review_id) === reviewId)
          .sort((left, right) => numberValue(left.sort_order) - numberValue(right.sort_order))
          .map((row) => mediaUrls.get(stringValue(row.storage_path)))
          .filter((url): url is string => Boolean(url)),
        helpfulCount: numberValue(review.helpful_count),
        upCount: numberValue(reaction?.up_count),
        downCount: numberValue(reaction?.down_count),
        viewerReaction: viewerReaction === -1 || viewerReaction === 1 ? viewerReaction : 0,
        comments: commentRows
          .filter((row) => stringValue(row.review_id) === reviewId)
          .map((row) => ({
            id: stringValue(row.comment_id),
            authorId: stringValue(row.author_public_id),
            authorUsername: stringValue(row.author_username),
            authorDisplayName: stringValue(row.author_display_name, 'Spottr member'),
            authorAvatarUrl: mediaUrls.get(stringValue(row.author_avatar_path)),
            body: stringValue(row.body),
            postedAt: stringValue(row.created_at),
            postedLabel: relativeTime(row.created_at),
            viewerCanDelete: booleanValue(row.viewer_can_delete),
          })),
      };
    });
    const badges = rows(badgesResult.data)
      .map((row) => publicBadgeFromCode(
        stringValue(row.badge_code),
        stringValue(row.earned_at) || undefined,
        stringValue(row.expires_at) || undefined
      ))
      .filter((badge): badge is PublicBadge => Boolean(badge));

    return {
      ok: true,
      data: {
        id: stringValue(profile.public_id),
        username: stringValue(profile.username),
        displayName: stringValue(profile.display_name, 'Spottr member'),
        avatarUrl: mediaUrls.get(stringValue(profile.avatar_path)),
        bannerUrl: mediaUrls.get(stringValue(profile.banner_path)),
        bio: stringValue(profile.bio),
        links: publicProfileLinks(profile.links),
        reviewCount: numberValue(profile.review_count),
        followerCount: numberValue(profile.follower_count),
        followingCount: profile.following_count == null ? null : numberValue(profile.following_count),
        favoriteCount: profile.favorite_count == null ? null : numberValue(profile.favorite_count),
        showFollowing: booleanValue(profile.show_following),
        showFavorites: booleanValue(profile.show_favorites),
        followedByViewer: booleanValue(profile.followed_by_viewer),
        memberSince: stringValue(profile.created_at),
        badges,
        reviews: profileReviews,
        hasMoreReviews,
      },
    };
  } catch (error) {
    return toActionError(error, 'This profile could not be loaded.');
  }
}

export async function setProfileFollow(
  targetPublicId: string,
  shouldFollow: boolean,
  expectedUserId: string
): Promise<ActionResult<boolean>> {
  if (!uuidPattern.test(targetPublicId) || !uuidPattern.test(expectedUserId)) {
    return { ok: false, code: 'INVALID', reason: 'This profile follow request is invalid.' };
  }
  try {
    const client = await createAccountBoundSupabaseClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('set_profile_follow_by_public_id', {
      target_public_id: targetPublicId,
      should_follow: shouldFollow,
    });
    if (error) throw error;
    return { ok: true, data: data === true };
  } catch (error) {
    return toActionError(error, shouldFollow ? 'This profile could not be followed.' : 'This profile could not be unfollowed.');
  }
}

export async function setReviewReaction(
  reviewId: string,
  reaction: -1 | 0 | 1,
  expectedUserId: string
): Promise<ActionResult<{ upCount: number; downCount: number; viewerReaction: -1 | 0 | 1 }>> {
  if (!uuidPattern.test(reviewId) || !uuidPattern.test(expectedUserId) || ![-1, 0, 1].includes(reaction)) {
    return { ok: false, code: 'INVALID', reason: 'This review reaction is invalid.' };
  }
  try {
    const client = await createAccountBoundSupabaseClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('set_review_reaction', {
      target_review_id: reviewId,
      next_reaction: reaction,
    });
    if (error) throw error;
    const row = rows(data)[0];
    const viewerReaction = numberValue(row?.viewer_reaction);
    return {
      ok: true,
      data: {
        upCount: numberValue(row?.up_count),
        downCount: numberValue(row?.down_count),
        viewerReaction: viewerReaction === -1 || viewerReaction === 1 ? viewerReaction : 0,
      },
    };
  } catch (error) {
    return toActionError(error, 'Your reaction could not be saved.');
  }
}

export async function addReviewProfileComment(
  reviewId: string,
  body: string,
  expectedUserId: string
): Promise<ActionResult<string>> {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!uuidPattern.test(reviewId) || !uuidPattern.test(expectedUserId) || normalized.length < 1 || normalized.length > 500) {
    return { ok: false, code: 'INVALID', reason: 'Write a comment up to 500 characters.' };
  }
  try {
    const client = await createAccountBoundSupabaseClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('add_review_profile_comment', {
      target_review_id: reviewId,
      comment_body: normalized,
    });
    if (error) throw error;
    const commentId = stringValue(data);
    if (!uuidPattern.test(commentId)) throw new Error('INVALID_COMMENT_RECEIPT');
    return { ok: true, data: commentId };
  } catch (error) {
    return toActionError(error, 'Your comment could not be posted.');
  }
}

export async function deleteReviewProfileComment(
  commentId: string,
  expectedUserId: string
): Promise<ActionResult<boolean>> {
  if (!uuidPattern.test(commentId) || !uuidPattern.test(expectedUserId)) {
    return { ok: false, code: 'INVALID', reason: 'This comment request is invalid.' };
  }
  try {
    const client = await createAccountBoundSupabaseClient(expectedUserId);
    if (!client) return configurationRequired();
    const { data, error } = await client.rpc('delete_own_review_profile_comment', {
      target_comment_id: commentId,
    });
    if (error) throw error;
    return { ok: true, data: data === true };
  } catch (error) {
    return toActionError(error, 'Your comment could not be deleted.');
  }
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown) {
  return value === true;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function relativeTime(value: unknown) {
  if (typeof value !== 'string') return 'Recently';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Recently';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function timeLabel(value: unknown) {
  const text = stringValue(value);
  if (!/^\d{2}:\d{2}/.test(text)) return '';
  const [hourText, minuteText] = text.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function getTimeParts(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return {
    dateKey: `${year}-${month}-${day}`,
    weekday: Math.max(0, weekday),
    minutes: hour * 60 + minute,
  };
}

function timeToMinutes(value: unknown) {
  const match = stringValue(value).match(/^(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function buildHours(hours: Row[], specialHours: Row[], businessId: string, timeZone: string) {
  const byDay = new Map(
    hours
      .filter((entry) => entry.business_id === businessId)
      .map((entry) => [numberValue(entry.weekday), entry])
  );
  const weeklyHours: WeeklyHours[] = weekdayLabels.map((day, weekday) => {
    const entry = byDay.get(weekday);
    if (!entry || booleanValue(entry.is_closed)) return { day, hours: 'Closed', closed: true };
    const opens = timeLabel(entry.opens_at);
    const closes = timeLabel(entry.closes_at);
    return {
      day,
      hours: opens && closes ? `${opens}–${closes}` : 'Hours unavailable',
      closed: false,
    };
  });

  const nowDate = new Date();
  const now = getTimeParts(timeZone, nowDate);
  const yesterday = getTimeParts(timeZone, new Date(nowDate.getTime() - 24 * 60 * 60 * 1000));
  const specialByDate = new Map(
    specialHours
      .filter((entry) => entry.business_id === businessId)
      .map((entry) => [stringValue(entry.service_date), entry])
  );
  const today = specialByDate.get(now.dateKey) ?? byDay.get(now.weekday);
  const previous = specialByDate.get(yesterday.dateKey) ?? byDay.get(yesterday.weekday);
  const previousOpensAt = timeToMinutes(previous?.opens_at);
  const previousClosesAt = timeToMinutes(previous?.closes_at);
  const carriedFromYesterday =
    previous &&
    !booleanValue(previous.is_closed) &&
    previousOpensAt !== null &&
    previousClosesAt !== null &&
    previousClosesAt <= previousOpensAt &&
    now.minutes < previousClosesAt;

  if (carriedFromYesterday) {
    return {
      weeklyHours,
      todayHours: `Open until ${timeLabel(previous?.closes_at)}`,
      status: 'open' as VenueStatus,
    };
  }

  if (!today || booleanValue(today.is_closed)) {
    return { weeklyHours, todayHours: 'Closed today', status: 'closed' as VenueStatus };
  }

  const opensAt = timeToMinutes(today.opens_at);
  const closesAt = timeToMinutes(today.closes_at);
  const opens = timeLabel(today.opens_at);
  const closes = timeLabel(today.closes_at);
  let status: VenueStatus = 'closed';
  if (opensAt !== null && closesAt !== null) {
    const openNow =
      closesAt > opensAt
        ? now.minutes >= opensAt && now.minutes < closesAt
        : now.minutes >= opensAt;
    const openingSoon = !openNow && now.minutes < opensAt && opensAt - now.minutes <= 60;
    status = openNow ? 'open' : openingSoon ? 'opening_soon' : 'closed';
  }

  return {
    weeklyHours,
    todayHours: opens && closes ? `${opens}–${closes}` : 'Hours unavailable',
    status,
  };
}

function pointCoordinates(value: unknown) {
  if (value && typeof value === 'object') {
    const coordinates = (value as { coordinates?: unknown }).coordinates;
    if (Array.isArray(coordinates) && coordinates.length >= 2) {
      return {
        longitude: numberValue(coordinates[0], Number.NaN),
        latitude: numberValue(coordinates[1], Number.NaN),
      };
    }
  }
  return null;
}

function locationCoordinates(location?: Row) {
  const latitude = numberValue(location?.latitude, Number.NaN);
  const longitude = numberValue(location?.longitude, Number.NaN);
  if (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    return { latitude, longitude };
  }
  const point = pointCoordinates(location?.point);
  if (
    point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180
  ) {
    return point;
  }
  return null;
}

function buildMenus(sections: Row[], items: Row[], businessId: string): MenuSection[] {
  return sections
    .filter((section) => section.business_id === businessId)
    .sort((a, b) => numberValue(a.sort_order) - numberValue(b.sort_order))
    .map((section) => ({
      id: stringValue(section.id),
      name: stringValue(section.name, 'Menu'),
      items: items
        .filter((item) => item.section_id === section.id && item.availability !== 'hidden')
        .sort((a, b) => numberValue(a.sort_order) - numberValue(b.sort_order))
        .map((item) => ({
          id: stringValue(item.id),
          name: stringValue(item.name, 'Menu item'),
          description: stringValue(item.description),
          price: numberValue(item.price_minor) / 100,
          dietary: stringArray(item.dietary_tags) as MenuSection['items'][number]['dietary'],
          soldOut: item.availability === 'sold_out',
        })),
    }));
}

function buildReviews(
  reviewRows: Row[],
  responseRows: Row[],
  reviewMediaRows: Row[],
  mediaUrls: Map<string, string>,
  businessId: string,
  badgeRows: Row[] = []
): Review[] {
  return reviewRows
    .filter((review) => review.business_id === businessId)
    .sort(
      (a, b) =>
        new Date(stringValue(b.created_at)).getTime() - new Date(stringValue(a.created_at)).getTime()
    )
    .slice(0, 20)
    .map((review) => {
      const reviewId = stringValue(review.review_id ?? review.id);
      const response = responseRows.find((entry) => entry.review_id === reviewId);
      const reviewMedia = reviewMediaRows
        .filter((entry) => entry.review_id === reviewId)
        .sort((left, right) => numberValue(left.sort_order) - numberValue(right.sort_order));
      const authorPublicId = stringValue(review.author_public_id);
      const badges = badgeRows
        .filter((entry) => stringValue(entry.subject_public_id) === authorPublicId)
        .map((entry) => publicBadgeFromCode(
          stringValue(entry.badge_code),
          stringValue(entry.earned_at) || undefined,
          stringValue(entry.expires_at) || undefined
        ))
        .filter((badge): badge is PublicBadge => Boolean(badge));
      return {
        id: reviewId,
        authorId: authorPublicId || undefined,
        username: stringValue(review.author_username, 'spottr-member'),
        displayName: stringValue(review.author_display_name, 'Spottr member'),
        rating: numberValue(review.rating, 5),
        comment: stringValue(review.body),
        createdAt: relativeTime(review.created_at),
        photos: reviewMedia
          .map((entry) => mediaUrls.get(stringValue(entry.storage_path)))
          .filter((url): url is string => Boolean(url)),
        photoMediaIds: reviewMedia
          .map((entry) => stringValue(entry.asset_id))
          .filter((id) => uuidPattern.test(id)),
        helpfulCount: numberValue(review.helpful_count),
        badges,
        ownerResponse: response ? stringValue(response.body) : undefined,
        ownerResponseId: response
          ? stringValue(response.review_id) || undefined
          : undefined,
        moderation: 'approved',
      };
    });
}

function businessIdOf(row: Row) {
  return stringValue(row.business_id ?? row.id);
}

function locationIdOf(row?: Row) {
  return stringValue(row?.location_id ?? row?.id);
}

function serverHoursSummary(business: Row) {
  if (business.today_is_closed === true) return 'Closed today';
  const opens = timeLabel(business.today_opens_at);
  const closes = timeLabel(business.today_closes_at);
  return opens && closes ? `${opens}–${closes}` : 'Hours unavailable';
}

export async function createSignedMediaUrls(
  paths: string[]
): Promise<Map<string, string>> {
  const client = supabase;
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const urlByPath = new Map<string, string>();
  if (!client || !uniquePaths.length) return urlByPath;

  const chunks: string[][] = [];
  for (let offset = 0; offset < uniquePaths.length; offset += 100) {
    chunks.push(uniquePaths.slice(offset, offset + 100));
  }
  for (let offset = 0; offset < chunks.length; offset += 4) {
    const results = await Promise.all(
      chunks.slice(offset, offset + 4).map((chunk) =>
        client.storage.from('spottr-media').createSignedUrls(chunk, 6 * 60 * 60)
      )
    );
    for (const { data, error } of results) {
      if (error) continue;
      for (const entry of data ?? []) {
        if (entry.path && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl);
      }
    }
  }
  return urlByPath;
}

function sourceLabel(value: unknown, verified: boolean): Place['sourceLabel'] {
  if (value === 'licensed_provider') return 'Licensed provider';
  if (value === 'community') return 'Community added';
  return verified ? 'Owner verified' : 'Owner provided';
}

const businessCategories: BusinessCategory[] = [
  'food_truck',
  'restaurant',
  'pop_up',
  'cafe_bakery',
  'home_kitchen',
];

function businessCategory(value: unknown): BusinessCategory | null {
  return typeof value === 'string' && businessCategories.includes(value as BusinessCategory)
    ? (value as BusinessCategory)
    : null;
}

export async function fetchMapFoodFeatures(
  viewport: MapViewport,
  requestedCategories: BusinessCategory[],
): Promise<ActionResult<MapInventoryFeature[]>> {
  const client = supabase;
  if (!client) return configurationRequired();
  const { west, south, east, north } = viewport.bounds;
  if (
    ![west, south, east, north, viewport.zoom].every(Number.isFinite) ||
    west < -180 || west > 180 || east < -180 || east > 180 ||
    south < -85.05112878 || north > 85.05112878 || south >= north
  ) {
    return { ok: false, code: 'INVALID', reason: 'The visible map area is invalid.' };
  }

  const uniqueRequestedCategories = [...new Set(requestedCategories)];
  if (
    uniqueRequestedCategories.length < 1 ||
    uniqueRequestedCategories.length !== requestedCategories.length ||
    uniqueRequestedCategories.some((category) => !businessCategories.includes(category))
  ) {
    return { ok: false, code: 'INVALID', reason: 'Select at least one valid map category.' };
  }

  try {
    const { rows: mapRows } = await invokePublicDiscovery({
      operation: 'map',
      west_longitude: west,
      south_latitude: south,
      east_longitude: east,
      north_latitude: north,
      map_zoom: Math.round(Math.min(18, Math.max(2, viewport.zoom))),
      requested_kinds: uniqueRequestedCategories,
      max_features: 1200,
    });
    const logoPaths = mapLogoPaths(mapRows);
    const logoUrls = await createSignedMediaUrls(logoPaths);
    const features: MapInventoryFeature[] = [];

    for (const entry of mapRows) {
      const type = entry.feature_type === 'cluster' ? 'cluster' : entry.feature_type === 'place' ? 'place' : null;
      const dominantCategory = businessCategory(entry.dominant_kind);
      const latitude = numberValue(entry.latitude, Number.NaN);
      const longitude = numberValue(entry.longitude, Number.NaN);
      const count = numberValue(entry.place_count, 0);
      const id = stringValue(entry.feature_id);
      if (!type || !dominantCategory || !id || !Number.isFinite(latitude) || !Number.isFinite(longitude) || count < 1) continue;

      const rawCounts = entry.category_counts;
      const categoryCounts: MapInventoryFeature['categoryCounts'] = {};
      if (rawCounts && typeof rawCounts === 'object' && !Array.isArray(rawCounts)) {
        for (const category of businessCategories) {
          const value = numberValue((rawCounts as Row)[category], 0);
          if (Number.isInteger(value) && value > 0) categoryCounts[category] = value;
        }
      }
      const logoPath = stringValue(entry.logo_path);
      const businessId = stringValue(entry.business_id);
      const locationId = stringValue(entry.location_id);
      const rawSourceLabel = stringValue(entry.source_label);
      features.push({
        type,
        id,
        count,
        latitude,
        longitude,
        categoryCounts,
        dominantCategory,
        ...(uuidPattern.test(businessId) ? { businessId } : {}),
        ...(uuidPattern.test(locationId) ? { locationId } : {}),
        ...(stringValue(entry.business_name) ? { name: stringValue(entry.business_name) } : {}),
        ...(logoUrls.get(logoPath) ? { logoUrl: logoUrls.get(logoPath) } : {}),
        ...(
          rawSourceLabel === 'Owner verified' || rawSourceLabel === 'Owner provided' ||
          rawSourceLabel === 'Community added' || rawSourceLabel === 'Licensed provider'
            ? { sourceLabel: rawSourceLabel as Place['sourceLabel'] }
            : {}
        ),
      });
    }
    return { ok: true, data: features };
  } catch (error) {
    return toDiscoveryActionError(error, 'The visible map inventory could not be loaded.');
  }
}

export async function fetchMarketplacePlaces(
  options: MarketplaceFetchOptions = {}
): Promise<ActionResult<MarketplacePage>> {
  const client = supabase;
  if (!client) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live marketplace services are not configured.',
    };
  }
  if (options.expectedUserId) {
    const user = await activeUserIdentity(options.expectedUserId);
    if (!user.ok) return user;
  }

  try {
    const includeDetails = options.includeDetails === true;
    const resultLimit = Math.min(
      100,
      Math.max(1, Math.trunc(options.resultLimit ?? 100))
    );
    const resultOffset = Math.min(
      10_000,
      Math.max(0, Math.trunc(options.resultOffset ?? 0))
    );
    const includedIds = (options.includeBusinessIds ?? []).filter((id) => uuidPattern.test(id));
    const managedIds = (options.managedBusinessIds ?? []).filter((id) => uuidPattern.test(id));
    let nearbyRows: Row[] = [];
    let sponsoredRow: Row | null = null;

    if (options.origin) {
      const { latitude, longitude, radiusMeters = 16093 } = options.origin;
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        !Number.isFinite(radiusMeters) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return { ok: false, code: 'INVALID', reason: 'The search location is invalid.' };
      }
      const { rows: nearbyResultRows, sponsored } = await invokePublicDiscovery({
        operation: 'nearby',
        search_lat: latitude,
        search_lng: longitude,
        radius_meters: Math.min(80_467, Math.max(500, Math.trunc(radiusMeters))),
        result_limit: resultLimit,
        result_offset: resultOffset,
      });
      nearbyRows = nearbyResultRows;
      sponsoredRow = featureFlags.sponsoredPlacements ? sponsored : null;
    }

    const nearbyIds = nearbyRows
      .map((entry) => stringValue(entry.business_id))
      .filter((id) => uuidPattern.test(id));
    const sponsoredBusinessId = stringValue(sponsoredRow?.business_id);
    const directoryIds = [
      ...new Set([
        ...nearbyIds,
        ...(uuidPattern.test(sponsoredBusinessId) ? [sponsoredBusinessId] : []),
      ]),
    ];
    const managedBusinessSelection =
      'id, slug, name, kind, description, cuisine_labels, price_level, state, verification, timezone, provenance, provider_freshness_at, updated_at';
    const publishedResult = options.onlyIncludedBusinesses
      ? { data: [], error: null }
      : options.origin
      ? directoryIds.length
        ? await client.from('public_business_directory').select('*').in('business_id', directoryIds)
        : { data: [], error: null }
      : await client
          .from('public_business_directory')
          .select('*')
          .order('updated_at', { ascending: false })
          .range(resultOffset, resultOffset + resultLimit);
    if (publishedResult.error) throw publishedResult.error;
    const rawPublishedRows = rows(publishedResult.data);
    const nearbyHasMore = nearbyRows.some((entry) => entry.has_more === true);
    const directoryHasMore =
      !options.origin &&
      !options.onlyIncludedBusinesses &&
      rawPublishedRows.length > resultLimit;
    const hasMore = options.origin ? nearbyHasMore : directoryHasMore;
    const pagePublishedRows =
      !options.origin && !options.onlyIncludedBusinesses
        ? rawPublishedRows.slice(0, resultLimit)
        : rawPublishedRows;

    const includedResult = includedIds.length
      ? await client.from('public_business_directory').select('*').in('business_id', includedIds)
      : { data: [], error: null };
    if (includedResult.error) throw includedResult.error;

    const managedResult = managedIds.length
      ? await client.from('businesses').select(managedBusinessSelection).in('id', managedIds)
      : { data: [], error: null };
    if (managedResult.error) throw managedResult.error;

    const businessById = new Map<string, Row>();
    for (const business of rows(managedResult.data)) {
      businessById.set(businessIdOf(business), { ...business, _managed_raw: true });
    }
    for (const business of [...pagePublishedRows, ...rows(includedResult.data)]) {
      businessById.set(businessIdOf(business), { ...business, state: 'published' });
    }
    const businesses = [...businessById.values()];
    const ids = businesses.map(businessIdOf).filter(Boolean);
    if (!ids.length) {
      return {
        ok: true,
        data: {
          places: [],
          hasMore,
          nextOffset: hasMore ? resultOffset + resultLimit : resultOffset,
        },
      };
    }
    const detailedIds = includeDetails
      ? ids
      : managedIds.filter((id) => businessById.has(id));

    const [
      locationsResult,
      managedLocationsResult,
      stopsResult,
      updatesResult,
      liveStatusResult,
      aggregatesResult,
      contactsResult,
      hoursResult,
      specialHoursResult,
      paymentsResult,
      sectionsResult,
      reviewsResult,
      businessMediaResult,
    ] = await Promise.all([
      client.from('public_business_locations').select('*').in('business_id', ids),
      managedIds.length
        ? client.from('business_locations').select('*').in('business_id', managedIds)
        : Promise.resolve({ data: [], error: null }),
      client
        .from('mobile_stops')
        .select('id, business_id, location_id, starts_at, ends_at, state, confirmed_at')
        .in('business_id', ids)
        .in('state', ['scheduled', 'live'])
        .gte('ends_at', new Date().toISOString())
        .lte('starts_at', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('starts_at', { ascending: true }),
      client
        .from('public_business_updates')
        .select('*')
        .in('business_id', ids)
        .order('created_at', { ascending: false }),
      client.from('public_business_live_status').select('*').in('business_id', ids),
      client.from('public_business_review_aggregates').select('*').in('business_id', ids),
      detailedIds.length
        ? client.from('public_business_contacts').select('*').in('business_id', detailedIds)
        : Promise.resolve({ data: [], error: null }),
      detailedIds.length
        ? client.from('weekly_hours').select('*').in('business_id', detailedIds)
        : Promise.resolve({ data: [], error: null }),
      detailedIds.length
        ? client.from('special_hours').select('*').in('business_id', detailedIds)
        : Promise.resolve({ data: [], error: null }),
      detailedIds.length
        ? client.from('business_payments').select('*').in('business_id', detailedIds)
        : Promise.resolve({ data: [], error: null }),
      detailedIds.length
        ? client.from('menu_sections').select('*').in('business_id', detailedIds).eq('is_published', true)
        : Promise.resolve({ data: [], error: null }),
      detailedIds.length
        ? client
            .from('public_reviews')
            .select('*')
            .in('business_id', detailedIds)
            .order('created_at', { ascending: false })
            .limit(21)
        : Promise.resolve({ data: [], error: null }),
      detailedIds.length
        ? client.from('public_business_media').select('*').in('business_id', detailedIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const requiredResults = [
      locationsResult,
      managedLocationsResult,
      stopsResult,
      updatesResult,
      liveStatusResult,
      aggregatesResult,
      contactsResult,
      hoursResult,
      specialHoursResult,
      paymentsResult,
      sectionsResult,
      reviewsResult,
      businessMediaResult,
    ];
    const requiredError = requiredResults.find((result) => result.error)?.error;
    if (requiredError) throw requiredError;

    const sectionIds = rows(sectionsResult.data)
      .map((entry) => stringValue(entry.id))
      .filter((id) => uuidPattern.test(id));
    const reviewIds = rows(reviewsResult.data)
      .map((entry) => stringValue(entry.review_id))
      .filter((id) => uuidPattern.test(id));
    const reviewAuthorIds = [...new Set(rows(reviewsResult.data)
      .map((entry) => stringValue(entry.author_public_id))
      .filter((id) => uuidPattern.test(id)))];
    const [itemsResult, responsesResult, reviewMediaResult, reviewBadgesResult] = await Promise.all([
      sectionIds.length
        ? client.from('menu_items').select('*').in('section_id', sectionIds).eq('is_published', true)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? client
            .from('public_business_responses')
            .select('*')
            .in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? client
            .from('public_review_media')
            .select('*')
            .in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      reviewAuthorIds.length
        ? client
            .from('public_profile_badges')
            .select('*')
            .in('subject_public_id', reviewAuthorIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const dependentError = [itemsResult, responsesResult, reviewMediaResult, reviewBadgesResult].find(
      (result) => result.error
    )?.error;
    if (dependentError) throw dependentError;

    const locationsById = new Map<string, Row>();
    for (const location of [
      ...rows(locationsResult.data),
      ...rows(managedLocationsResult.data),
    ]) {
      locationsById.set(locationIdOf(location), location);
    }
    const locations = [...locationsById.values()];
    const hours = rows(hoursResult.data);
    const specialHours = rows(specialHoursResult.data);
    const stops = rows(stopsResult.data);
    const payments = rows(paymentsResult.data);
    const updates = rows(updatesResult.data);
    const sections = rows(sectionsResult.data);
    const items = rows(itemsResult.data);
    const reviewRows = rows(reviewsResult.data);
    const responses = rows(responsesResult.data);
    const reviewMedia = rows(reviewMediaResult.data);
    const reviewBadges = rows(reviewBadgesResult.data);
    const businessMedia = rows(businessMediaResult.data);
    const liveStatuses = rows(liveStatusResult.data);
    const aggregates = rows(aggregatesResult.data);
    const contacts = rows(contactsResult.data);
    const distanceByBusiness = new Map(
      nearbyRows.map((entry) => [
        stringValue(entry.business_id),
        numberValue(entry.distance_meters, Number.NaN),
      ])
    );
    const mediaUrls = await createSignedMediaUrls([
      ...businesses.map((business) => stringValue(business.logo_path)),
      ...businessMedia.map((entry) => stringValue(entry.storage_path)),
      ...reviewMedia.map((entry) => stringValue(entry.storage_path)),
    ]);

    const displayableBusinesses = businesses.filter(
      (business) => {
        const id = businessIdOf(business);
        const businessLocations = locations.filter((location) => location.business_id === id);
        if (stringValue(business.state, 'published') !== 'published') return true;
        return businessLocations.some((location) => Boolean(locationCoordinates(location)));
      }
    );

    const places = displayableBusinesses.map((business): Place => {
      const id = businessIdOf(business);
      const distanceMeters = distanceByBusiness.get(id);
      const kind = (
        Object.hasOwn(categoryLabels, stringValue(business.kind)) ? business.kind : 'restaurant'
      ) as BusinessCategory;
      const businessStops = stops.filter((entry) => entry.business_id === id);
      const nowTimestamp = Date.now();
      const activeStop = businessStops.find((entry) => {
        const startsAt = Date.parse(stringValue(entry.starts_at));
        const endsAt = Date.parse(stringValue(entry.ends_at));
        return startsAt <= nowTimestamp && endsAt > nowTimestamp;
      });
      const upcomingStop = businessStops.find(
        (entry) => Date.parse(stringValue(entry.starts_at)) > nowTimestamp
      );
      const nearbyLocationId = stringValue(
        nearbyRows.find((entry) => entry.business_id === id)?.location_id
      );
      const selectedLocationId =
        nearbyLocationId ||
        stringValue(activeStop?.location_id) ||
        stringValue(upcomingStop?.location_id);
      const location =
        locations.find((entry) => locationIdOf(entry) === selectedLocationId) ??
        locations.find((entry) => entry.business_id === id && entry.is_primary === true) ??
        locations.find((entry) => entry.business_id === id);
      const coordinates = locationCoordinates(location);
      const timeZone = stringValue(business.timezone, 'America/Los_Angeles');
      const hasDetails = includeDetails || managedIds.includes(id);
      const hoursInfo = hasDetails
        ? buildHours(hours, specialHours, id, timeZone)
        : {
            weeklyHours: [] as WeeklyHours[],
            todayHours: serverHoursSummary(business),
            status: stringValue(business.effective_status, 'closed') as VenueStatus,
          };
      const liveStatus = liveStatuses.find(
        (entry) =>
          entry.business_id === id &&
          Date.parse(stringValue(entry.expires_at)) > nowTimestamp
      );
      const liveState = stringValue(liveStatus?.status) as VenueStatus;
      const status: VenueStatus = ['open', 'opening_soon', 'moving_soon', 'closed'].includes(liveState)
        ? liveState
        : ['open', 'opening_soon', 'moving_soon', 'closed'].includes(
              stringValue(business.effective_status)
            )
          ? (business.effective_status as VenueStatus)
          : hoursInfo.status;
      const businessReviews = buildReviews(reviewRows, responses, reviewMedia, mediaUrls, id, reviewBadges);
      const hasMoreReviews =
        hasDetails &&
        reviewRows.filter((entry) => entry.business_id === id).length > 20;
      const aggregate = aggregates.find((entry) => entry.business_id === id);
      const rating = numberValue(aggregate?.average_rating);
      const reviewCount = numberValue(aggregate?.review_count);
      const recentReviewCount7d = numberValue(aggregate?.recent_review_count_7d);
      const recentReviewCount30d = numberValue(aggregate?.recent_review_count_30d);
      const followerCount = numberValue(aggregate?.follower_count);
      const currentUpdate = updates.find((entry) => entry.business_id === id);
      const kindPayments = payments
        .filter((entry) => entry.business_id === id)
        .map((entry) => paymentLabels[stringValue(entry.payment)])
        .filter((entry): entry is PaymentMethod => Boolean(entry));
      const isPrivateLocation = kind === 'home_kitchen' || location?.address_line == null;
      const city = stringValue(location?.city, 'Local area');
      const menu = buildMenus(sections, items, id);
      const nextStopLocation = upcomingStop
        ? locations.find((entry) => locationIdOf(entry) === upcomingStop.location_id)
        : undefined;
      const nextStop = upcomingStop
        ? `${new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date(stringValue(upcomingStop.starts_at)))} · ${stringValue(
            nextStopLocation?.label,
            stringValue(nextStopLocation?.city, 'Location posted')
          )}`
        : undefined;

      const update: BusinessUpdate | undefined = currentUpdate
        ? {
            id: stringValue(currentUpdate.update_id ?? currentUpdate.id),
            type: stringValue(currentUpdate.kind, 'availability') as BusinessUpdate['type'],
            message: stringValue(currentUpdate.body),
            createdAt: relativeTime(currentUpdate.created_at),
            expiresAt: `Ends ${new Intl.DateTimeFormat('en-US', {
              hour: 'numeric',
              minute: '2-digit',
            }).format(new Date(stringValue(currentUpdate.expires_at)))}`,
            moderation: 'approved',
          }
        : undefined;
      const contact = contacts.find((entry) => entry.business_id === id);
      const businessGalleryEntries = businessMedia
        .filter((entry) => entry.business_id === id && entry.media_role !== 'logo')
        .flatMap((entry) => {
          const url = mediaUrls.get(stringValue(entry.storage_path));
          const assetId = stringValue(entry.asset_id);
          return url && uuidPattern.test(assetId) ? [{ url, assetId }] : [];
        });
      const businessGallery = businessGalleryEntries.map((entry) => entry.url);
      const logoPath =
        stringValue(business.logo_path) ||
        stringValue(
          businessMedia.find(
            (entry) => entry.business_id === id && entry.media_role === 'logo'
          )?.storage_path
        );
      const publicationState = stringValue(
        business.state,
        'published'
      ) as Place['publicationState'];
      const sponsoredPlacementId = stringValue(sponsoredRow?.placement_id);
      const sponsoredToken = stringValue(sponsoredRow?.placement_token);
      const sponsoredExpiry = stringValue(sponsoredRow?.expires_at);
      const sponsoredDisclosure = stringValue(sponsoredRow?.disclosure);
      const sponsoredReason = stringValue(sponsoredRow?.reason);
      const sponsoredPlacement =
        sponsoredBusinessId === id &&
        uuidPattern.test(sponsoredPlacementId) &&
        sponsoredDisclosure === 'Sponsored ad' &&
        sponsoredReason.length > 0 &&
        sponsoredReason.length <= 120 &&
        sponsoredToken.length >= 110 &&
        Number.isFinite(Date.parse(sponsoredExpiry))
          ? {
              id: sponsoredPlacementId,
              disclosure: 'Sponsored ad' as const,
              reason: sponsoredReason,
              token: sponsoredToken,
              expiresAt: sponsoredExpiry,
            }
          : undefined;

      return {
        id,
        slug: stringValue(business.slug, id),
        name: stringValue(business.name, 'Local business'),
        category: kind,
        categoryLabel: categoryLabels[kind],
        cuisines: stringArray(business.cuisine_labels),
        address: isPrivateLocation
          ? `Approximate service area · ${city}`
          : stringValue(location?.address_line, stringValue(location?.label, city)),
        city,
        region: stringValue(location?.region),
        postalCode: isPrivateLocation ? '' : stringValue(location?.postal_code),
        phone: stringValue(contact?.phone) || undefined,
        websiteUrl: stringValue(contact?.website_url) || undefined,
        latitude: coordinates?.latitude ?? 0,
        longitude: coordinates?.longitude ?? 0,
        distanceMiles:
          typeof distanceMeters === 'number' && Number.isFinite(distanceMeters)
            ? distanceMeters / 1609.344
            : null,
        status,
        todayHours: hoursInfo.todayHours,
        weeklyHours: hoursInfo.weeklyHours,
        nextStop,
        description: stringValue(business.description, 'Independent local food on Spottr.'),
        priceLevel: Math.min(4, Math.max(1, numberValue(business.price_level, 2))) as 1 | 2 | 3 | 4,
        accent: categoryAccents[kind],
        logoUrl: mediaUrls.get(logoPath) ?? '',
        coverImageUrl: businessGallery[0] ?? '',
        gallery: businessGallery,
        galleryMediaIds: businessGalleryEntries.map((entry) => entry.assetId),
        rating: Number(rating.toFixed(1)),
        reviewCount,
        verified: business.verification === 'verified',
        lastConfirmedAt: relativeTime(
          liveStatus?.confirmed_at ??
            activeStop?.confirmed_at ??
            business.provider_freshness_at ??
            business.updated_at
        ),
        payments: kindPayments,
        menu,
        reviews: businessReviews,
        hasMoreReviews,
        update,
        features: [],
        trendingScore:
          rating * 15 +
          recentReviewCount7d * 5 +
          recentReviewCount30d * 2 +
          (update ? 15 : 0),
        popularityScore: reviewCount * 4 + followerCount * 2 + rating * 10,
        serviceArea: kind === 'home_kitchen' ? city : undefined,
        sourceLabel: sourceLabel(business.provenance, business.verification === 'verified'),
        publicationState,
        detailsLoaded: hasDetails,
        sponsoredPlacement,
      };
    });

    return {
      ok: true,
      data: {
        places,
        hasMore,
        nextOffset: hasMore ? resultOffset + resultLimit : resultOffset,
      },
    };
  } catch (error) {
    return toDiscoveryActionError(error, 'Live listings could not be loaded.');
  }
}

export async function fetchMarketplacePlaceById(
  businessId: string,
  expectedUserId?: string
): Promise<ActionResult<Place>> {
  if (!uuidPattern.test(businessId)) {
    return { ok: false, code: 'INVALID', reason: 'This listing link is invalid.' };
  }

  const result = await fetchMarketplacePlaces({
    expectedUserId,
    includeDetails: true,
    includeBusinessIds: [businessId],
    onlyIncludedBusinesses: true,
  });
  if (!result.ok) return result;
  const place = result.data?.places.find((entry) => entry.id === businessId);
  return place
    ? { ok: true, data: place }
    : { ok: false, code: 'NOT_FOUND', reason: 'This listing is unavailable or no longer public.' };
}

export async function recordSponsoredInteraction(
  placementToken: string,
  interactionType: 'open' | 'menu_view' | 'directions' | 'hide' | 'report',
): Promise<ActionResult<{ receiptId: string; accepted: boolean; duplicate: boolean; billed: boolean }>> {
  const client = supabase;
  if (!client || !featureFlags.sponsoredPlacements) return configurationRequired();
  if (
    !/^[0-9a-f-]{36}\.[0-9]{10}\.[0-9a-f]{64}$/.test(placementToken) ||
    !['open', 'menu_view', 'directions', 'hide', 'report'].includes(interactionType)
  ) {
    return { ok: false, code: 'INVALID', reason: 'This sponsored placement is invalid.' };
  }
  try {
    const { data, error } = await client.rpc('record_sponsored_interaction', {
      placement_token: placementToken,
      interaction_type: interactionType,
      idempotency_key: createMarketplaceIdempotencyKey('sponsor'),
    });
    if (error) throw error;
    const result = data && typeof data === 'object' && !Array.isArray(data) ? data as Row : null;
    const receiptId = stringValue(result?.receipt_id);
    if (
      !result || !uuidPattern.test(receiptId) ||
      typeof result.accepted !== 'boolean' ||
      typeof result.duplicate !== 'boolean' ||
      typeof result.billed !== 'boolean'
    ) {
      throw new Error('INVALID_SPONSORED_RECEIPT');
    }
    return {
      ok: true,
      data: {
        receiptId,
        accepted: result.accepted,
        duplicate: result.duplicate,
        billed: result.billed,
      },
    };
  } catch (error) {
    return toActionError(error, 'The sponsored interaction could not be recorded.');
  }
}

export async function fetchBusinessReviewsPage(
  businessId: string,
  resultOffset: number,
  expectedUserId?: string,
  sort: ReviewSort = 'recent'
): Promise<
  ActionResult<{ reviews: Review[]; hasMore: boolean; nextOffset: number }>
> {
  const client = supabase;
  if (!client) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live reviews are not configured.',
    };
  }
  if (
    !uuidPattern.test(businessId) ||
    !['recent', 'top'].includes(sort) ||
    !Number.isInteger(resultOffset) ||
    resultOffset < 0 ||
    resultOffset > 10_000
  ) {
    return { ok: false, code: 'INVALID', reason: 'This review page is invalid.' };
  }
  if (expectedUserId) {
    const user = await activeUserIdentity(expectedUserId);
    if (!user.ok) return user;
  }

  const pageSize = 20;
  try {
    let reviewQuery = client
      .from('public_reviews')
      .select('*')
      .eq('business_id', businessId);
    if (sort === 'top') {
      reviewQuery = reviewQuery
        .order('top_score', { ascending: false })
        .order('created_at', { ascending: false });
    } else {
      reviewQuery = reviewQuery.order('created_at', { ascending: false });
    }
    const { data: reviewData, error: reviewError } = await reviewQuery.range(
      resultOffset,
      resultOffset + pageSize
    );
    if (reviewError) throw reviewError;
    const reviewRows = rows(reviewData);
    const hasMore = reviewRows.length > pageSize;
    const pageRows = reviewRows.slice(0, pageSize);
    const reviewIds = pageRows
      .map((entry) => stringValue(entry.review_id))
      .filter((id) => uuidPattern.test(id));
    const authorIds = [...new Set(pageRows
      .map((entry) => stringValue(entry.author_public_id))
      .filter((id) => uuidPattern.test(id)))];
    const [responsesResult, mediaResult, badgesResult] = await Promise.all([
      reviewIds.length
        ? client
            .from('public_business_responses')
            .select('*')
            .in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? client.from('public_review_media').select('*').in('review_id', reviewIds)
        : Promise.resolve({ data: [], error: null }),
      authorIds.length
        ? client.from('public_profile_badges').select('*').in('subject_public_id', authorIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (responsesResult.error) throw responsesResult.error;
    if (mediaResult.error) throw mediaResult.error;
    if (badgesResult.error) throw badgesResult.error;
    const reviewMedia = rows(mediaResult.data);
    const mediaUrls = await createSignedMediaUrls(
      reviewMedia.map((entry) => stringValue(entry.storage_path))
    );
    return {
      ok: true,
      data: {
        reviews: buildReviews(
          pageRows,
          rows(responsesResult.data),
          reviewMedia,
          mediaUrls,
          businessId,
          rows(badgesResult.data)
        ),
        hasMore,
        nextOffset: hasMore ? resultOffset + pageSize : resultOffset,
      },
    };
  } catch (error) {
    return toActionError(error, 'More reviews could not be loaded.');
  }
}

export async function searchMarketplacePlaces(
  searchText: string,
  options: Pick<
    MarketplaceFetchOptions,
    | 'expectedUserId'
    | 'includeBusinessIds'
    | 'managedBusinessIds'
    | 'resultLimit'
    | 'resultOffset'
  > = {}
): Promise<ActionResult<MarketplacePage>> {
  const client = supabase;
  if (!client) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live marketplace search is not configured.',
    };
  }

  const clean = searchText.replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || clean.length > 120) {
    return { ok: false, code: 'INVALID', reason: 'Enter a city, ZIP code, or business name.' };
  }

  try {
    const resultLimit = Math.min(
      100,
      Math.max(1, Math.trunc(options.resultLimit ?? 100))
    );
    const resultOffset = Math.min(
      10_000,
      Math.max(0, Math.trunc(options.resultOffset ?? 0))
    );
    const { rows: searchRows } = await invokePublicDiscovery({
      operation: 'search',
      search_text: clean,
      result_limit: resultLimit,
      result_offset: resultOffset,
    });
    const rankedIds = searchRows
      .map((entry) => stringValue(entry.business_id))
      .filter((id) => uuidPattern.test(id));
    const includedIds = [
      ...new Set([...rankedIds, ...(options.includeBusinessIds ?? [])]),
    ];
    const result = await fetchMarketplacePlaces({
      expectedUserId: options.expectedUserId,
      includeBusinessIds: includedIds,
      managedBusinessIds: options.managedBusinessIds,
      onlyIncludedBusinesses: true,
    });
    if (!result.ok) return result;

    const rank = new Map(rankedIds.map((id, index) => [id, index]));
    return {
      ok: true,
      data: {
        places: (result.data?.places ?? []).sort(
          (left, right) =>
            (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        ),
        hasMore: searchRows.some((entry) => entry.has_more === true),
        nextOffset: searchRows.some((entry) => entry.has_more === true)
          ? resultOffset + resultLimit
          : resultOffset,
      },
    };
  } catch (error) {
    return toDiscoveryActionError(error, 'This area could not be searched.');
  }
}

async function activeUserIdentity(expectedUserId?: string): Promise<
  ActionResult<{ emailConfirmed: boolean; id: string }>
> {
  const client = supabase;
  if (!client) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live marketplace services are not configured.',
    };
  }
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in to continue.' };
    }
    if (expectedUserId && data.user.id !== expectedUserId) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        reason: 'The active account changed. Try again from the current account.',
      };
    }
    return {
      ok: true,
      data: {
        emailConfirmed: Boolean(data.user.email_confirmed_at),
        id: data.user.id,
      },
    };
  } catch {
    return {
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: 'The active account could not be verified. Sign in again to continue.',
    };
  }
}

async function authenticatedUserId(expectedUserId?: string): Promise<ActionResult<string>> {
  const identity = await activeUserIdentity(expectedUserId);
  if (!identity.ok) return identity;
  const user = identity.data;
  if (!user?.emailConfirmed) {
    return { ok: false, code: 'AUTH_REQUIRED', reason: 'Verify your email before posting.' };
  }
  return { ok: true, data: user.id };
}

export async function fetchFollowedIds(expectedUserId?: string): Promise<ActionResult<string[]>> {
  const client = supabase;
  if (!client) return configurationRequired();
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;

  try {
    const { data, error } = await client
      .from('follows')
      .select('business_id')
      .eq('user_id', user.data);
    if (error) throw error;
    return {
      ok: true,
      data: rows(data).map((entry) => stringValue(entry.business_id)).filter(Boolean),
    };
  } catch (error) {
    return toActionError(error, 'Saved places could not be loaded.');
  }
}

export async function fetchManagedBusinessIds(
  expectedUserId?: string
): Promise<ActionResult<string[]>> {
  const client = supabase;
  if (!client) return configurationRequired();
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;

  try {
    const { data, error } = await client
      .from('business_members')
      .select('business_id')
      .eq('user_id', user.data)
      .eq('status', 'active');
    if (error) throw error;
    return {
      ok: true,
      data: rows(data).map((entry) => stringValue(entry.business_id)).filter(Boolean),
    };
  } catch (error) {
    return toActionError(error, 'Business access could not be verified.');
  }
}

export async function setFollow(
  placeId: string,
  following: boolean,
  expectedUserId?: string
): Promise<ActionResult> {
  if (!supabase) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live follows are not configured.',
    };
  }
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return expectedUserId ? accountChanged() : configurationRequired();

  try {
    const query = following
      ? client.from('follows').upsert(
          { user_id: user.data, business_id: placeId },
          { onConflict: 'user_id,business_id', ignoreDuplicates: true }
        )
      : client.from('follows').delete().eq('user_id', user.data).eq('business_id', placeId);
    const { error } = await query;
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return toActionError(error, following ? 'This place could not be followed.' : 'This place could not be unfollowed.');
  }
}

export async function submitReview(
  placeId: string,
  input: ReviewInput,
  expectedUserId?: string
): Promise<ActionResult> {
  if (!supabase) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live reviews are not configured.',
    };
  }
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return expectedUserId ? accountChanged() : configurationRequired();
  if (!uuidPattern.test(placeId)) {
    return { ok: false, code: 'INVALID', reason: 'This business link is invalid.' };
  }
  if ((input.photoUploads?.length ?? 0) > 4) {
    return { ok: false, code: 'INVALID', reason: 'Add no more than four review photos.' };
  }

  try {
    const mediaAssetIds: string[] = [];
    for (const photo of input.photoUploads ?? []) {
      const staged = await stageMediaUpload(
        photo,
        'review_photo',
        placeId,
        undefined,
        expectedUserId ? client : undefined,
      );
      if (!staged.ok) return staged;
      mediaAssetIds.push(staged.data!.assetId);
    }

    const { data, error } = await client.rpc('submit_review', {
      target_business_id: placeId,
      review_rating: input.rating,
      review_body: input.comment,
      idempotency_key: actionIdempotencyKey(input.idempotencyKey, 'review'),
      media_asset_ids: mediaAssetIds,
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const moderationState =
      result && typeof result === 'object' && 'moderation_state' in result
        ? String(result.moderation_state)
        : 'pending';
    return {
      ok: true,
      message:
        moderationState === 'approved'
          ? 'Your review is live.'
          : 'Your review is saved and will appear after its photos pass safety checks.',
    };
  } catch (error) {
    return toActionError(error, 'Your review could not be submitted.');
  }
}

export async function submitOwnerUpdate(
  input: OwnerUpdateInput,
  expectedUserId: string
): Promise<ActionResult> {
  if (!supabase) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live business updates are not configured.',
    };
  }
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return expectedUserId ? accountChanged() : configurationRequired();
  if (!uuidPattern.test(input.placeId)) {
    return { ok: false, code: 'INVALID', reason: 'This business link is invalid.' };
  }

  try {
    const { data, error } = await client.rpc('submit_business_update', {
      target_business_id: input.placeId,
      update_kind: input.type,
      update_body: input.message,
      active_for_minutes: 360,
      idempotency_key: actionIdempotencyKey(input.idempotencyKey, 'update'),
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const moderationState =
      result && typeof result === 'object' && 'moderation_state' in result
        ? String(result.moderation_state)
        : 'pending';
    return {
      ok: true,
      message:
        moderationState === 'approved'
          ? 'Update published for six hours.'
          : 'Update saved and queued for a safety review.',
    };
  } catch (error) {
    return toActionError(error, 'The update could not be published.');
  }
}

export async function uploadBusinessLogo(
  businessId: string,
  media: LocalMedia,
  expectedUserId: string
): Promise<ActionResult<{ assetId: string }>> {
  if (!supabase) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Secure logo processing is not configured.',
    };
  }
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return accountChanged();
  if (!uuidPattern.test(businessId)) {
    return { ok: false, code: 'INVALID', reason: 'This business link is invalid.' };
  }

  const staged = await stageMediaUpload(
    media,
    'business_logo',
    businessId,
    undefined,
    client,
  );
  if (!staged.ok) return staged;

  try {
    const { error } = await client.rpc('nominate_business_logo', {
      target_business_id: businessId,
      target_asset_id: staged.data!.assetId,
    });
    if (error) throw error;
    return {
      ok: true,
      data: { assetId: staged.data!.assetId },
      message: 'Logo uploaded and queued for private safety processing.',
    };
  } catch (error) {
    return toActionError(error, 'The uploaded logo could not be attached to this business.');
  }
}

export async function updateVenueStatus(
  placeId: string,
  status: VenueStatus,
  expectedUserId: string
): Promise<ActionResult> {
  if (!supabase) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Live business status is not configured.',
    };
  }
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return expectedUserId ? accountChanged() : configurationRequired();

  try {
    const { error } = await client.rpc('set_business_live_status', {
      target_business_id: placeId,
      next_status: status,
    });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return toActionError(error, 'The live status could not be changed.');
  }
}

export async function setMenuItemAvailability(
  itemId: string,
  soldOut: boolean,
  expectedUserId: string
): Promise<ActionResult> {
  if (!supabase) return configurationRequired();
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return accountChanged();
  if (!uuidPattern.test(itemId)) {
    return { ok: false, code: 'INVALID', reason: 'This menu item link is invalid.' };
  }

  try {
    const { error } = await client.rpc('set_menu_item_availability', {
      target_menu_item_id: itemId,
      next_availability: soldOut ? 'sold_out' : 'available',
    });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return toActionError(error, 'Menu availability could not be changed.');
  }
}

export async function submitContentReport(input: {
  targetType: 'business' | 'business_post' | 'review' | 'review_comment' | 'response' | 'update' | 'media' | 'user';
  targetId: string;
  reason: string;
  detail?: string;
}): Promise<ActionResult> {
  const client = supabase;
  if (!client) return configurationRequired();
  const user = await authenticatedUserId();
  if (!user.ok) return user;

  try {
    const { error } = await client.rpc('submit_content_report', {
      target_type: input.targetType,
      target_id: input.targetId,
      report_reason: input.reason,
      report_detail: input.detail?.trim() || '',
    });
    if (error) throw error;
    return {
      ok: true,
      message: 'Report received. The Spottr safety team will review it.',
    };
  } catch (error) {
    return toActionError(error, 'This report could not be submitted.');
  }
}

export async function blockUser(
  blockedPublicProfileId: string,
  expectedUserId?: string
): Promise<ActionResult> {
  if (!supabase) return configurationRequired();
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return expectedUserId ? accountChanged() : configurationRequired();
  if (!uuidPattern.test(blockedPublicProfileId)) {
    return { ok: false, code: 'INVALID', reason: 'This member cannot be blocked.' };
  }

  try {
    const { error } = await client.rpc('set_user_block_by_public_id', {
      target_public_profile_id: blockedPublicProfileId,
      should_block: true,
    });
    if (error) throw error;
    return { ok: true, message: 'This member’s community content is now hidden from you.' };
  } catch (error) {
    return toActionError(error, 'This member could not be blocked.');
  }
}

export async function createBusinessDraft(
  input: {
    kind: BusinessCategory;
    name: string;
    description: string;
    cuisines: string[];
    businessEmail: string;
    businessPhone: string;
    websiteUrl?: string;
    address?: string;
    city: string;
    region: string;
    postalCode?: string;
    timezone: string;
    payments: PaymentMethod[];
    permitNumber?: string;
  },
  expectedUserId: string,
): Promise<ActionResult<{ businessId: string }>> {
  if (!supabase) return configurationRequired();
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return accountChanged();

  try {
    const { data, error } = await client.rpc('create_business_draft', {
      payload: {
        kind: input.kind,
        name: input.name.trim(),
        description: input.description.trim(),
        cuisine_labels: input.cuisines.map((value) => value.trim()).filter(Boolean),
        business_email: input.businessEmail.trim().toLocaleLowerCase('en-US'),
        business_phone: input.businessPhone.trim(),
        website_url: input.websiteUrl?.trim() || null,
        address_line: input.address?.trim() || null,
        city: input.city.trim(),
        region: input.region.trim().toLocaleUpperCase('en-US'),
        postal_code: input.postalCode?.trim() || null,
        timezone: input.timezone.trim(),
        payments: input.payments.map((payment) => paymentKeys[payment]),
        permit_number: input.permitNumber?.trim() || null,
      },
    });
    if (error) throw error;
    const businessId =
      typeof data === 'string'
        ? data
        : data && typeof data === 'object' && 'business_id' in data
          ? String((data as { business_id: unknown }).business_id)
          : '';
    if (!businessId) throw new Error('Business draft did not return an identifier.');

    return {
      ok: true,
      data: { businessId },
      message: 'Business draft created. Add a service pin, hours, and menu before submitting it.',
    };
  } catch (error) {
    return toActionError(error, 'The business draft could not be submitted.');
  }
}

export async function submitBusinessClaim(
  businessId: string,
  method: 'listed_phone' | 'domain_email' | 'document' | 'permit',
  expectedUserId: string,
): Promise<ActionResult> {
  if (!featureFlags.businessClaims) {
    return {
      ok: false,
      reason:
        'Ownership claims are unavailable until secure phone, email, or document verification is connected.',
    };
  }
  if (!supabase) return configurationRequired();
  const user = await authenticatedUserId(expectedUserId);
  if (!user.ok) return user;
  const client = await marketplaceMutationClient(expectedUserId);
  if (!client) return accountChanged();

  try {
    const { error } = await client.rpc('submit_business_claim', {
      target_business_id: businessId,
      claim_method: method,
      evidence_private_path: null,
    });
    if (error) throw error;
    return {
      ok: true,
      message: 'Claim submitted. Ownership verification is now pending.',
    };
  } catch (error) {
    return toActionError(error, 'The business claim could not be submitted.');
  }
}

export async function requestAccountExport(): Promise<
  ActionResult<{ content?: string; fileName?: string }>
> {
  const client = supabase;
  if (!client) return configurationRequired();
  const user = await authenticatedUserId();
  if (!user.ok) return user;

  try {
    const { data, error } = await client.functions.invoke('export-account', { method: 'GET' });
    if (error) throw error;
    const content = JSON.stringify(data ?? {}, null, 2);
    const fileName = `spottr-account-export-${new Date().toISOString().slice(0, 10)}.json`;
    return {
      ok: true,
      data: { content, fileName },
      message: 'Your export is ready.',
    };
  } catch (error) {
    return toActionError(error, 'Your data export could not be requested.');
  }
}

export async function updateFollowAlertPreference(
  businessIds: string[],
  field: 'live_nearby' | 'owner_update',
  enabled: boolean
): Promise<ActionResult> {
  const client = supabase;
  if (!client) return configurationRequired();
  const user = await authenticatedUserId();
  if (!user.ok) return user;
  if (!businessIds.length) return { ok: true };

  try {
    const payload = businessIds.map((businessId) => ({
      user_id: user.data,
      business_id: businessId,
      [field]: enabled,
    }));
    const { error } = await client
      .from('notification_preferences')
      .upsert(payload, {
        onConflict: 'user_id,business_id',
        defaultToNull: false,
      });
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return toActionError(error, 'Notification preferences could not be saved.');
  }
}

export async function fetchFollowAlertPreferences(
  businessIds: string[]
): Promise<ActionResult<{ liveNearby: boolean; ownerUpdates: boolean }>> {
  const client = supabase;
  if (!client) return configurationRequired();
  if (!businessIds.length) {
    return {
      ok: true,
      data: { liveNearby: true, ownerUpdates: true },
    };
  }
  const user = await authenticatedUserId();
  if (!user.ok) return user;

  try {
    const { data, error } = await client
      .from('notification_preferences')
      .select('business_id, live_nearby, owner_update')
      .eq('user_id', user.data)
      .in('business_id', businessIds);
    if (error) throw error;

    const rows = (data ?? []) as {
      business_id: string;
      live_nearby: boolean;
      owner_update: boolean;
    }[];
    const byBusiness = new Map(rows.map((row) => [row.business_id, row]));

    return {
      ok: true,
      data: {
        liveNearby: businessIds.every(
          (businessId) => byBusiness.get(businessId)?.live_nearby ?? true
        ),
        ownerUpdates: businessIds.every(
          (businessId) => byBusiness.get(businessId)?.owner_update ?? true
        ),
      },
    };
  } catch (error) {
    return toActionError(error, 'Notification preferences could not be loaded.');
  }
}
