import type { SupabaseClient } from '@supabase/supabase-js';

import { toActionError } from '@/lib/errors';
import { featureFlags } from '@/lib/features';
import { readLocalMedia } from '@/lib/local-media-file';
import { supabase } from '@/lib/supabase';
import { ActionResult } from '@/types/marketplace';

export type MediaPurpose =
  | 'profile_avatar'
  | 'profile_banner'
  | 'business_logo'
  | 'business_gallery'
  | 'business_post'
  | 'review_photo'
  | 'chat_photo';

export type LocalMedia = {
  uri: string;
  mimeType?: string | null;
  fileSize?: number | null;
};

export type StagedMedia = {
  assetId: string;
  moderationState: 'pending';
  quarantineState: 'uploaded';
};

const maxUploadBytes = 5 * 1024 * 1024;
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function detectedImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export async function stageMediaUpload(
  media: LocalMedia,
  purpose: MediaPurpose,
  businessId?: string,
  conversationId?: string,
  accountClient?: SupabaseClient,
): Promise<ActionResult<StagedMedia>> {
  if (!featureFlags.mediaUploads) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Photo uploads are not available in this release.',
    };
  }
  const client = accountClient ?? supabase;
  if (!client) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Secure media processing is not configured.',
    };
  }
  if (
    (purpose === 'business_logo' ||
      purpose === 'business_gallery' ||
      purpose === 'business_post' ||
      purpose === 'review_photo' ||
      purpose === 'chat_photo') &&
    !businessId
  ) {
    return { ok: false, code: 'INVALID', reason: 'Choose a valid business first.' };
  }
  if (purpose === 'chat_photo' && !conversationId) {
    return { ok: false, code: 'INVALID', reason: 'Choose a valid conversation first.' };
  }

  try {
    const bytes = await readLocalMedia(media.uri);
    if (bytes.byteLength < 1 || bytes.byteLength > maxUploadBytes) {
      return {
        ok: false,
        code: 'INVALID',
        reason: 'Choose a JPEG, PNG, or WebP image smaller than 5 MB.',
      };
    }
    if (media.fileSize && media.fileSize !== bytes.byteLength) {
      return {
        ok: false,
        code: 'INVALID',
        reason: 'The selected image changed before it could be uploaded. Choose it again.',
      };
    }

    const detectedMime = detectedImageMime(new Uint8Array(bytes));
    const declaredMime = media.mimeType?.toLocaleLowerCase('en-US') ?? detectedMime;
    if (
      !detectedMime ||
      !declaredMime ||
      !allowedMimeTypes.has(declaredMime) ||
      detectedMime !== declaredMime
    ) {
      return {
        ok: false,
        code: 'INVALID',
        reason: 'The selected file is not a valid JPEG, PNG, or WebP image.',
      };
    }

    const { data: stageData, error: stageError } = await client.functions.invoke(
      'media-stage',
      {
        method: 'POST',
        body: {
          action: 'stage',
          purpose,
          businessId: businessId ?? null,
          conversationId: conversationId ?? null,
          mimeType: detectedMime,
          byteSize: bytes.byteLength,
        },
      }
    );
    if (stageError) throw stageError;
    const upload =
      stageData && typeof stageData === 'object' && 'upload' in stageData
        ? (stageData.upload as Record<string, unknown>)
        : null;
    const bucket = typeof upload?.bucket === 'string' ? upload.bucket : '';
    const path = typeof upload?.path === 'string' ? upload.path : '';
    const token = typeof upload?.token === 'string' ? upload.token : '';
    if (bucket !== 'spottr-media' || !path || !token) {
      throw new Error('The upload service returned an invalid staging token.');
    }

    const { error: uploadError } = await client.storage
      .from(bucket)
      .uploadToSignedUrl(path, token, bytes, {
        contentType: detectedMime,
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { data: registration, error: registrationError } =
      await client.functions.invoke('media-stage', {
        method: 'POST',
        body: {
          action: 'register',
          purpose,
          businessId: businessId ?? null,
          conversationId: conversationId ?? null,
          storagePath: path,
        },
      });
    if (registrationError) throw registrationError;
    const assetId =
      registration &&
      typeof registration === 'object' &&
      typeof registration.asset_id === 'string'
        ? registration.asset_id
        : '';
    if (!assetId) throw new Error('The upload could not be registered for safety processing.');

    return {
      ok: true,
      data: {
        assetId,
        moderationState: 'pending',
        quarantineState: 'uploaded',
      },
      message: 'Image uploaded securely and queued for scanning.',
    };
  } catch (error) {
    return toActionError(error, 'This image could not be uploaded securely.');
  }
}

export async function mediaProcessingStates(conversationId: string, assetIds: string[]) {
  const client = supabase;
  if (!client || !assetIds.length) return new Map<string, 'pending' | 'approved' | 'rejected'>();
  const { data, error } = await client.rpc('get_marketplace_chat_media_states', {
    target_conversation_public_id: conversationId,
    target_asset_ids: assetIds.slice(0, 4),
  });
  const states = new Map<string, 'pending' | 'approved' | 'rejected'>();
  if (error) return states;
  for (const row of data ?? []) {
    if (row.processing_state === 'pending' || row.processing_state === 'approved' || row.processing_state === 'rejected') {
      states.set(row.asset_id, row.processing_state);
    }
  }
  return states;
}
