import type { SupabaseClient } from '@supabase/supabase-js';

import { toActionError } from '@/lib/errors';
import { stageMediaUpload, type LocalMedia } from '@/lib/media-upload';
import { createAccountBoundSupabaseClient } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';
import type { PublicProfileLink } from '@/types/social';

type Row = Record<string, unknown>;

export type SocialProfileWorkspace = {
  publicId: string;
  bio: string;
  links: PublicProfileLink[];
  bannerUrl: string | null;
  showFavorites: boolean;
  showFollowing: boolean;
  allowBusinessInvitations: boolean;
  approvedReviewCount: number;
  bannerUnlocked: boolean;
  approvedBanners: { assetId: string; url: string }[];
};

export type SocialProfileUpdate = {
  bio: string;
  links: PublicProfileLink[];
  showFavorites: boolean;
  showFollowing: boolean;
  allowBusinessInvitations: boolean;
  bannerAssetId?: string | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function clientFor(expectedUserId: string) {
  if (!uuidPattern.test(expectedUserId)) throw Object.assign(new Error('The active account changed.'), { status: 401 });
  const client = await createAccountBoundSupabaseClient(expectedUserId);
  if (!client) throw Object.assign(new Error('Live profile services are not configured.'), { code: 'CONFIG_REQUIRED' });
  return client;
}

function safeLinks(value: unknown): PublicProfileLink[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Row;
    return typeof row.label === 'string' && typeof row.url === 'string'
      ? [{ label: row.label, url: row.url }]
      : [];
  });
}

async function signedUrls(client: SupabaseClient, paths: string[]) {
  const clean = [...new Set(paths.filter(Boolean))];
  const result = new Map<string, string>();
  if (!clean.length) return result;
  const { data, error } = await client.storage.from('spottr-media').createSignedUrls(clean, 6 * 60 * 60);
  if (error) throw error;
  for (const item of data ?? []) if (item.path && item.signedUrl) result.set(item.path, item.signedUrl);
  return result;
}

export async function loadOwnSocialProfile(expectedUserId: string): Promise<ActionResult<SocialProfileWorkspace>> {
  try {
    const client = await clientFor(expectedUserId);
    const [profileResult, reviewResult, mediaResult] = await Promise.all([
      client
        .from('profiles')
        .select('public_id,bio,links,banner_path,show_favorites,show_following,allow_business_invitations')
        .eq('user_id', expectedUserId)
        .maybeSingle(),
      client
        .from('reviews')
        .select('id', { count: 'exact', head: true })
        .eq('author_id', expectedUserId)
        .eq('moderation', 'approved')
        .is('deleted_at', null),
      client
        .from('media_assets')
        .select('id,processed_storage_path,width,height,created_at')
        .eq('owner_id', expectedUserId)
        .is('business_id', null)
        .eq('source', 'owner_upload')
        .eq('quarantine_state', 'clean')
        .eq('moderation', 'approved')
        .gte('width', 900)
        .gte('height', 300)
        .order('created_at', { ascending: false })
        .limit(12),
    ]);
    if (profileResult.error) throw profileResult.error;
    if (reviewResult.error) throw reviewResult.error;
    if (mediaResult.error) throw mediaResult.error;
    if (!profileResult.data) return { ok: false, code: 'NOT_FOUND', reason: 'Your profile could not be found.' };
    const profile = profileResult.data as Row;
    const candidates = (mediaResult.data ?? []).filter((candidate) => {
      const width = Number(candidate.width);
      const height = Number(candidate.height);
      const ratio = width / height;
      return Number.isFinite(ratio) && width <= 6000 && height <= 2400 && ratio >= 1.8 && ratio <= 5;
    });
    const bannerPath = typeof profile.banner_path === 'string' ? profile.banner_path : '';
    const paths = [bannerPath, ...candidates.map((candidate) => candidate.processed_storage_path).filter((path): path is string => typeof path === 'string')];
    const urls = await signedUrls(client, paths);
    const approvedReviewCount = reviewResult.count ?? 0;
    return {
      ok: true,
      data: {
        publicId: String(profile.public_id ?? ''),
        bio: typeof profile.bio === 'string' ? profile.bio : '',
        links: safeLinks(profile.links),
        bannerUrl: urls.get(bannerPath) ?? null,
        showFavorites: profile.show_favorites === true,
        showFollowing: profile.show_following === true,
        allowBusinessInvitations: profile.allow_business_invitations === true,
        approvedReviewCount,
        bannerUnlocked: approvedReviewCount >= 10,
        approvedBanners: candidates.flatMap((candidate) => {
          const path = typeof candidate.processed_storage_path === 'string' ? candidate.processed_storage_path : '';
          const url = urls.get(path);
          return typeof candidate.id === 'string' && url ? [{ assetId: candidate.id, url }] : [];
        }),
      },
    };
  } catch (error) {
    return toActionError(error, 'Your public profile settings could not be loaded.');
  }
}

export async function updateOwnSocialProfile(
  input: SocialProfileUpdate,
  expectedUserId: string
): Promise<ActionResult> {
  if (input.bio.trim().length > 240 || input.links.length > 3) {
    return { ok: false, code: 'INVALID', reason: 'Check the profile bio and links.' };
  }
  try {
    const client = await clientFor(expectedUserId);
    const payload: Record<string, unknown> = {
      bio: input.bio.trim(),
      links: input.links.map((link) => ({ label: link.label.trim(), url: link.url.trim() })),
      show_favorites: input.showFavorites,
      show_following: input.showFollowing,
    };
    if (Object.hasOwn(input, 'bannerAssetId')) payload.banner_asset_id = input.bannerAssetId;
    const { error } = await client.rpc('update_social_profile_with_invitation_consent', {
      payload,
      next_consent: input.allowBusinessInvitations,
    });
    if (error) throw error;
    return { ok: true, message: 'Public profile updated.' };
  } catch (error) {
    return toActionError(error, 'Your public profile could not be updated.');
  }
}

export async function uploadProfileBanner(media: LocalMedia, expectedUserId: string) {
  try {
    const client = await clientFor(expectedUserId);
    return stageMediaUpload(media, 'profile_banner', undefined, undefined, client);
  } catch (error) {
    return toActionError(error, 'This banner could not be uploaded securely.');
  }
}
