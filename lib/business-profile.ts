import { featureFlags } from '@/lib/features';
import { stageMediaUpload, type LocalMedia } from '@/lib/media-upload';
import { checkProfessionalText } from '@/lib/moderation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { BusinessCategory } from '@/types/marketplace';

export const BUSINESS_LOGO_MIN_DIMENSION = 512;
export const BUSINESS_LOGO_MAX_DIMENSION = 2048;
export const BUSINESS_LOGO_MAX_BYTES = 5 * 1024 * 1024;

export type BusinessProfileState = 'draft' | 'published';
export type BusinessProfileRole = 'owner' | 'manager';

export type BusinessProfileValues = {
  name: string;
  description: string;
  cuisines: string[];
  priceLevel: 1 | 2 | 3 | 4;
  timezone: string;
  businessEmail: string;
  businessPhone: string;
  websiteUrl: string;
  showPhonePublic: boolean;
  showWebsitePublic: boolean;
  logoAssetId: string | null;
};

export type PendingBusinessProfileRevision = {
  revisionId: string;
  businessId: string;
  sections: string[];
  profile: Partial<
    Pick<
      BusinessProfileValues,
      'name' | 'description' | 'cuisines' | 'priceLevel' | 'timezone' | 'logoAssetId'
    >
  >;
  contacts: Partial<
    Pick<
      BusinessProfileValues,
      | 'businessEmail'
      | 'businessPhone'
      | 'websiteUrl'
      | 'showPhonePublic'
      | 'showWebsitePublic'
    >
  >;
  baseUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type BusinessProfileWorkspace = {
  businessId: string;
  category: BusinessCategory;
  categoryLabel: string;
  state: BusinessProfileState;
  verification: string;
  role: BusinessProfileRole;
  live: BusinessProfileValues;
  currentLogoUrl: string | null;
  pendingRevision: PendingBusinessProfileRevision | null;
};

export type BusinessLogoSelection = LocalMedia & {
  width?: number | null;
  height?: number | null;
};

export type BusinessProfileResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | {
      ok: false;
      code:
        | 'AUTH_REQUIRED'
        | 'CONFIG_REQUIRED'
        | 'CONFLICT'
        | 'FEATURE_DISABLED'
        | 'FORBIDDEN'
        | 'INVALID'
        | 'NETWORK'
        | 'NOT_FOUND'
        | 'RATE_LIMITED'
        | 'UNKNOWN';
      reason: string;
    };

type JsonRecord = Record<string, unknown>;
type ErrorLike = { code?: string; message?: string; status?: number };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern =
  /^\+?\(?[0-9][0-9 ()-]{5,30}( ?(x|ext\.?) ?[0-9]{1,8})?$/i;
const allowedLogoMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const categoryLabels: Record<BusinessCategory, string> = {
  food_truck: 'Food truck',
  restaurant: 'Restaurant',
  pop_up: 'Pop-up',
  cafe_bakery: 'Café & bakery',
  home_kitchen: 'Neighborhood kitchen',
};

class BusinessProfileValidationError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function singleRow(value: unknown): JsonRecord | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isRecord(candidate) ? candidate : null;
}

function requiredString(record: JsonRecord, key: string, label: string) {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new BusinessProfileValidationError(
      `The business profile response is missing ${label}.`
    );
  }
  return value.trim();
}

function nullableString(record: JsonRecord, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) {
    throw new BusinessProfileValidationError(
      `The business profile response contains an invalid ${label}.`
    );
  }
  return value;
}

function assertUuid(value: string, label: string) {
  if (!uuidPattern.test(value)) {
    throw new BusinessProfileValidationError(`${label} is invalid.`);
  }
}

function parseCategory(value: unknown): BusinessCategory {
  if (
    value === 'food_truck' ||
    value === 'restaurant' ||
    value === 'pop_up' ||
    value === 'cafe_bakery' ||
    value === 'home_kitchen'
  ) {
    return value;
  }
  throw new BusinessProfileValidationError(
    'The business profile contains an unsupported category.'
  );
}

function parseState(value: unknown): BusinessProfileState {
  if (value === 'draft' || value === 'published') return value;
  throw new BusinessProfileValidationError(
    'Only draft and published listings can be edited here.'
  );
}

function parseRole(value: unknown): BusinessProfileRole {
  if (value === 'owner' || value === 'manager') return value;
  throw new BusinessProfileValidationError(
    'Owner or manager access is required.'
  );
}

function parsePriceLevel(value: unknown): 1 | 2 | 3 | 4 {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4) return parsed;
  throw new BusinessProfileValidationError(
    'The business profile contains an invalid price level.'
  );
}

function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new BusinessProfileValidationError(
      'The business profile contains invalid cuisines.'
    );
  }
  return value.map((entry) => String(entry));
}

function pendingPartialProfile(value: unknown) {
  if (!isRecord(value)) return {};
  const result: PendingBusinessProfileRevision['profile'] = {};
  if (typeof value.name === 'string') result.name = value.name;
  if (typeof value.description === 'string') result.description = value.description;
  if (Array.isArray(value.cuisine_labels)) {
    result.cuisines = value.cuisine_labels.filter(
      (entry): entry is string => typeof entry === 'string'
    );
  }
  if ([1, 2, 3, 4].includes(Number(value.price_level))) {
    result.priceLevel = Number(value.price_level) as 1 | 2 | 3 | 4;
  }
  if (typeof value.timezone === 'string') result.timezone = value.timezone;
  if (value.logo_asset_id === null) {
    result.logoAssetId = null;
  } else if (
    typeof value.logo_asset_id === 'string' &&
    uuidPattern.test(value.logo_asset_id)
  ) {
    result.logoAssetId = value.logo_asset_id;
  }
  return result;
}

function pendingPartialContacts(value: unknown) {
  if (!isRecord(value)) return {};
  const result: PendingBusinessProfileRevision['contacts'] = {};
  if (typeof value.business_email === 'string') {
    result.businessEmail = value.business_email;
  }
  if (typeof value.business_phone === 'string') {
    result.businessPhone = value.business_phone;
  }
  if (typeof value.website_url === 'string') result.websiteUrl = value.website_url;
  if (typeof value.show_phone_public === 'boolean') {
    result.showPhonePublic = value.show_phone_public;
  }
  if (typeof value.show_website_public === 'boolean') {
    result.showWebsitePublic = value.show_website_public;
  }
  return result;
}

export function mapPendingBusinessProfileRevision(
  value: unknown
): PendingBusinessProfileRevision | null {
  const record = singleRow(value);
  if (!record) return null;
  const proposedPatch = isRecord(record.proposed_patch)
    ? record.proposed_patch
    : {};
  const revisionId = requiredString(record, 'revision_id', 'a revision reference');
  const businessId = requiredString(record, 'business_id', 'a business reference');
  assertUuid(revisionId, 'The revision reference');
  assertUuid(businessId, 'The business reference');
  if (record.state !== 'pending') {
    throw new BusinessProfileValidationError(
      'The business profile response contains a non-pending revision.'
    );
  }
  return {
    revisionId,
    businessId,
    sections: Array.isArray(record.sections)
      ? record.sections.filter((entry): entry is string => typeof entry === 'string')
      : [],
    profile: pendingPartialProfile(proposedPatch.profile),
    contacts: pendingPartialContacts(proposedPatch.contacts),
    baseUpdatedAt: validDate(record.base_updated_at, 'base revision date'),
    createdAt: validDate(record.created_at, 'revision creation date'),
    updatedAt: validDate(record.updated_at, 'revision update date'),
  };
}

export function mapBusinessProfileWorkspace(input: {
  business: unknown;
  contacts: unknown;
  membership: unknown;
  pendingRevision?: unknown;
  currentLogoUrl?: string | null;
}): BusinessProfileWorkspace {
  const business = singleRow(input.business);
  const contacts = singleRow(input.contacts);
  const membership = singleRow(input.membership);
  if (!business || !contacts || !membership) {
    throw new BusinessProfileValidationError(
      'The business profile response is incomplete.'
    );
  }
  const businessId = requiredString(business, 'id', 'the business reference');
  const contactBusinessId = requiredString(
    contacts,
    'business_id',
    'the contact business reference'
  );
  assertUuid(businessId, 'The business reference');
  if (businessId !== contactBusinessId) {
    throw new BusinessProfileValidationError(
      'The business profile response does not match its contacts.'
    );
  }
  const category = parseCategory(business.kind);
  const logoAssetId = nullableString(business, 'logo_asset_id');
  if (logoAssetId) assertUuid(logoAssetId, 'The logo reference');
  const pendingRevision = mapPendingBusinessProfileRevision(
    input.pendingRevision
  );
  if (pendingRevision && pendingRevision.businessId !== businessId) {
    throw new BusinessProfileValidationError(
      'The pending revision does not match this business.'
    );
  }

  return {
    businessId,
    category,
    categoryLabel: categoryLabels[category],
    state: parseState(business.state),
    verification:
      typeof business.verification === 'string'
        ? business.verification
        : 'unverified',
    role: parseRole(membership.role),
    live: {
      name: requiredString(business, 'name', 'the business name'),
      description:
        typeof business.description === 'string' ? business.description : '',
      cuisines: stringArray(business.cuisine_labels),
      priceLevel: parsePriceLevel(business.price_level),
      timezone: requiredString(business, 'timezone', 'the business time zone'),
      businessEmail: nullableString(contacts, 'business_email') ?? '',
      businessPhone: nullableString(contacts, 'business_phone') ?? '',
      websiteUrl: nullableString(contacts, 'website_url') ?? '',
      showPhonePublic: contacts.show_phone_public === true,
      showWebsitePublic: contacts.show_website_public === true,
      logoAssetId,
    },
    currentLogoUrl: input.currentLogoUrl?.trim() || null,
    pendingRevision,
  };
}

export function proposedBusinessProfileValues(
  workspace: BusinessProfileWorkspace
): BusinessProfileValues {
  const pending = workspace.pendingRevision;
  if (!pending) return { ...workspace.live, cuisines: [...workspace.live.cuisines] };
  return {
    ...workspace.live,
    ...pending.profile,
    ...pending.contacts,
    cuisines: pending.profile.cuisines
      ? [...pending.profile.cuisines]
      : [...workspace.live.cuisines],
  };
}

export function cuisineLabelsFromText(value: string) {
  const unique = new Map<string, string>();
  for (const raw of value.split(',')) {
    const clean = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const professional = checkProfessionalText(clean, 60);
    if (!professional.ok) {
      throw new BusinessProfileValidationError(
        `Cuisine “${clean.slice(0, 24)}” needs professional wording and must be 60 characters or fewer.`
      );
    }
    const comparisonKey = professional.clean.toLocaleLowerCase('en-US');
    if (!unique.has(comparisonKey)) {
      unique.set(comparisonKey, professional.clean);
    }
  }
  if (unique.size > 12) {
    throw new BusinessProfileValidationError(
      'Add no more than 12 cuisine labels.'
    );
  }
  return [...unique.values()];
}

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateBusinessProfileValues(
  input: BusinessProfileValues
): BusinessProfileValues {
  const normalizedName = checkProfessionalText(input.name, 100);
  if (!normalizedName.ok || normalizedName.clean.length < 2) {
    throw new BusinessProfileValidationError(
      'Business name must use 2–100 professional characters.'
    );
  }
  const description = input.description
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  if (description.length > 2000) {
    throw new BusinessProfileValidationError(
      'Description must be 2,000 characters or fewer.'
    );
  }
  if (description) {
    const professional = checkProfessionalText(description, 2000);
    if (!professional.ok) {
      throw new BusinessProfileValidationError(professional.reason);
    }
  }
  const cuisines = cuisineLabelsFromText(input.cuisines.join(', '));
  if (![1, 2, 3, 4].includes(input.priceLevel)) {
    throw new BusinessProfileValidationError('Choose a price level from $ to $$$$.');
  }
  const timezone = input.timezone.trim();
  if (!timezone || timezone.length > 80 || !validTimeZone(timezone)) {
    throw new BusinessProfileValidationError(
      'Enter a valid IANA time zone, such as America/Los_Angeles.'
    );
  }
  const businessEmail = input.businessEmail
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US');
  if (
    !businessEmail ||
    businessEmail.length > 320 ||
    !emailPattern.test(businessEmail)
  ) {
    throw new BusinessProfileValidationError(
      'Enter a complete business email address.'
    );
  }
  const businessPhone = input.businessPhone.normalize('NFKC').trim();
  if (
    businessPhone.length < 7 ||
    businessPhone.length > 40 ||
    !phonePattern.test(businessPhone)
  ) {
    throw new BusinessProfileValidationError(
      'Enter a business phone using 7–40 digits and standard phone punctuation.'
    );
  }
  const websiteUrl = input.websiteUrl.trim();
  if (websiteUrl) {
    if (websiteUrl.length > 2048 || !websiteUrl.startsWith('https://')) {
      throw new BusinessProfileValidationError(
        'Website must be a complete HTTPS address.'
      );
    }
    try {
      const parsed = new URL(websiteUrl);
      if (
        parsed.protocol !== 'https:' ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error('unsafe');
      }
    } catch {
      throw new BusinessProfileValidationError(
        'Website must be a complete HTTPS address.'
      );
    }
  }
  if (input.showWebsitePublic && !websiteUrl) {
    throw new BusinessProfileValidationError(
      'Add an HTTPS website before showing it publicly.'
    );
  }
  if (input.showPhonePublic && !businessPhone) {
    throw new BusinessProfileValidationError(
      'Add a business phone before showing it publicly.'
    );
  }
  if (input.logoAssetId) assertUuid(input.logoAssetId, 'The logo reference');

  return {
    name: normalizedName.clean,
    description,
    cuisines,
    priceLevel: input.priceLevel,
    timezone,
    businessEmail,
    businessPhone,
    websiteUrl,
    showPhonePublic: input.showPhonePublic,
    showWebsitePublic: input.showWebsitePublic,
    logoAssetId: input.logoAssetId,
  };
}

export function validateBusinessLogoSelection(selection: BusinessLogoSelection) {
  const mimeType = selection.mimeType?.toLocaleLowerCase('en-US') ?? '';
  if (!allowedLogoMimeTypes.has(mimeType)) {
    throw new BusinessProfileValidationError(
      'Choose a JPEG, PNG, or WebP logo.'
    );
  }
  if (
    !Number.isInteger(selection.width) ||
    !Number.isInteger(selection.height) ||
    selection.width !== selection.height ||
    (selection.width ?? 0) < BUSINESS_LOGO_MIN_DIMENSION ||
    (selection.width ?? 0) > BUSINESS_LOGO_MAX_DIMENSION
  ) {
    throw new BusinessProfileValidationError(
      'Choose a square logo from 512 × 512 through 2048 × 2048 pixels.'
    );
  }
  if (
    !Number.isInteger(selection.fileSize) ||
    (selection.fileSize ?? 0) < 1 ||
    (selection.fileSize ?? 0) >= BUSINESS_LOGO_MAX_BYTES
  ) {
    throw new BusinessProfileValidationError(
      'Choose a logo smaller than 5 MB with a readable file size.'
    );
  }
  return {
    ...selection,
    mimeType,
    width: selection.width as number,
    height: selection.height as number,
    fileSize: selection.fileSize as number,
  };
}

export function buildBusinessProfileRevisionPatch(values: BusinessProfileValues) {
  const clean = validateBusinessProfileValues(values);
  return {
    profile: {
      name: clean.name,
      description: clean.description,
      cuisine_labels: clean.cuisines,
      price_level: clean.priceLevel,
      timezone: clean.timezone,
      logo_asset_id: clean.logoAssetId,
    },
    contacts: {
      business_email: clean.businessEmail,
      business_phone: clean.businessPhone,
      website_url: clean.websiteUrl || null,
      show_phone_public: clean.showPhonePublic,
      show_website_public: clean.showWebsitePublic,
    },
  };
}

function draftPayload(values: BusinessProfileValues) {
  const revision = buildBusinessProfileRevisionPatch(values);
  return {
    ...revision.profile,
    ...revision.contacts,
  };
}

function isNetworkError(error: unknown) {
  const message = (error as ErrorLike | null)?.message?.toLocaleLowerCase('en-US') ?? '';
  return (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('offline') ||
    message.includes('connection')
  );
}

function failure<T>(
  error: unknown,
  fallback: string
): BusinessProfileResult<T> {
  if (error instanceof BusinessProfileValidationError) {
    return { ok: false, code: 'INVALID', reason: error.message };
  }
  const candidate = error as ErrorLike | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.code === 'FEATURE_DISABLED') {
    return {
      ok: false,
      code: 'FEATURE_DISABLED',
      reason:
        'Logo uploads remain unavailable until private scanning and re-encoding are connected.',
    };
  }
  if (candidate?.code === 'CONFIG_REQUIRED') {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Connect Spottr live services before editing this business.',
    };
  }
  if (
    candidate?.status === 401 ||
    message.includes('jwt') ||
    message.includes('not authenticated')
  ) {
    return {
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: 'Sign in again before editing this business.',
    };
  }
  if (
    message.includes('aal2') ||
    message.includes('authenticator verification required')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'Verify a current authenticator code in Security, then try again.',
    };
  }
  if (
    candidate?.status === 403 ||
    candidate?.code === '42501' ||
    message.includes('owner or manager') ||
    message.includes('row-level security')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'An active owner or manager role is required.',
    };
  }
  if (
    candidate?.status === 429 ||
    message.includes('rate_limited') ||
    message.includes('rate limit')
  ) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      reason: 'Too many profile changes were requested. Wait before trying again.',
    };
  }
  if (
    candidate?.code === '40001' ||
    message.includes('revision_stale') ||
    message.includes('business_revision_stale')
  ) {
    return {
      ok: false,
      code: 'CONFLICT',
      reason:
        'The live listing changed after this proposal began. Reload before submitting again.',
    };
  }
  if (
    candidate?.code === 'PGRST116' ||
    message.includes('pending revision not found') ||
    message.includes('not found')
  ) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      reason: 'This business profile is no longer available. Reload Studio.',
    };
  }
  if (
    candidate?.code === '22023' ||
    candidate?.code === '23514' ||
    message.includes('invalid') ||
    message.includes('content_policy_violation')
  ) {
    return {
      ok: false,
      code: 'INVALID',
      reason: message.includes('content')
        ? 'Use professional, customer-safe wording and try again.'
        : fallback,
    };
  }
  if (candidate?.status === 0 || isNetworkError(error)) {
    return {
      ok: false,
      code: 'NETWORK',
      reason: 'Spottr could not confirm this change. Check your connection and reload.',
    };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

async function secureClient(businessId?: string) {
  if (!isSupabaseConfigured || !supabase) {
    throw Object.assign(new Error('Live services are not configured.'), {
      code: 'CONFIG_REQUIRED',
    });
  }
  const [{ data: userData, error: userError }, assurance] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (userError || !userData.user) {
    throw Object.assign(userError ?? new Error('Not authenticated'), {
      status: 401,
    });
  }
  if (assurance.error) throw assurance.error;
  if (assurance.data.currentLevel !== 'aal2') {
    throw Object.assign(new Error('AAL2 authenticator verification required'), {
      status: 403,
    });
  }
  if (businessId) {
    assertUuid(businessId, 'This business link');
    const { data: allowed, error } = await supabase.rpc('is_business_member', {
      target_business_id: businessId,
      allowed_roles: ['owner', 'manager'],
    });
    if (error) throw error;
    if (!allowed) {
      throw Object.assign(new Error('Business owner or manager role required'), {
        status: 403,
        code: '42501',
      });
    }
  }
  return { client: supabase, userId: userData.user.id };
}

async function approvedLogoUrl(
  client: NonNullable<typeof supabase>,
  assetId: string | null
) {
  if (!assetId) return null;
  const { data, error } = await client
    .from('media_assets')
    .select('processed_storage_path,quarantine_state,moderation')
    .eq('id', assetId)
    .maybeSingle();
  if (error) throw error;
  if (
    !data ||
    data.quarantine_state !== 'clean' ||
    data.moderation !== 'approved' ||
    typeof data.processed_storage_path !== 'string'
  ) {
    return null;
  }
  const { data: signed, error: signedError } = await client.storage
    .from('spottr-media')
    .createSignedUrl(data.processed_storage_path, 6 * 60 * 60);
  if (signedError) throw signedError;
  return signed.signedUrl || null;
}

export async function loadBusinessProfileWorkspace(
  businessId: string
): Promise<BusinessProfileResult<BusinessProfileWorkspace>> {
  try {
    const { client, userId } = await secureClient(businessId);
    const [businessResult, contactsResult, membershipResult] = await Promise.all([
      client
        .from('businesses')
        .select(
          'id,kind,name,description,cuisine_labels,price_level,state,verification,timezone,logo_asset_id'
        )
        .eq('id', businessId)
        .maybeSingle(),
      client
        .from('business_private_details')
        .select(
          'business_id,business_email,business_phone,website_url,show_phone_public,show_website_public'
        )
        .eq('business_id', businessId)
        .maybeSingle(),
      client
        .from('business_members')
        .select('role,status')
        .eq('business_id', businessId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle(),
    ]);
    if (businessResult.error) throw businessResult.error;
    if (contactsResult.error) throw contactsResult.error;
    if (membershipResult.error) throw membershipResult.error;
    if (!businessResult.data || !contactsResult.data || !membershipResult.data) {
      throw Object.assign(new Error('Business profile not found'), {
        code: 'PGRST116',
      });
    }

    const state = parseState(businessResult.data.state);
    const [pendingResult, logoUrl] = await Promise.all([
      state === 'published'
        ? client.rpc('get_my_pending_business_revision', {
            target_business_id: businessId,
          })
        : Promise.resolve({ data: null, error: null }),
      approvedLogoUrl(
        client,
        typeof businessResult.data.logo_asset_id === 'string'
          ? businessResult.data.logo_asset_id
          : null
      ),
    ]);
    if (pendingResult.error) throw pendingResult.error;

    return {
      ok: true,
      data: mapBusinessProfileWorkspace({
        business: businessResult.data,
        contacts: contactsResult.data,
        membership: membershipResult.data,
        pendingRevision: pendingResult.data,
        currentLogoUrl: logoUrl,
      }),
    };
  } catch (error) {
    return failure(error, 'This business profile could not be loaded.');
  }
}

export async function saveBusinessProfile(
  businessId: string,
  state: BusinessProfileState,
  values: BusinessProfileValues
): Promise<BusinessProfileResult<{ revisionId: string | null }>> {
  try {
    const clean = validateBusinessProfileValues(values);
    const { client } = await secureClient(businessId);
    if (state === 'draft') {
      const { error } = await client.rpc('update_business_draft_profile', {
        target_business_id: businessId,
        payload: draftPayload(clean),
      });
      if (error) throw error;
      return {
        ok: true,
        data: { revisionId: null },
        message: 'Draft profile saved.',
      };
    }

    const { data, error } = await client.rpc('submit_business_revision', {
      target_business_id: businessId,
      proposed_patch: buildBusinessProfileRevisionPatch(clean),
    });
    if (error) throw error;
    const revisionId = typeof data === 'string' ? data : '';
    assertUuid(revisionId, 'The revision reference');
    return {
      ok: true,
      data: { revisionId },
      message:
        'Profile changes were submitted for review. The live listing is unchanged.',
    };
  } catch (error) {
    return failure(error, 'This business profile could not be saved.');
  }
}

export async function stageBusinessProfileLogo(
  businessId: string,
  state: BusinessProfileState,
  selection: BusinessLogoSelection
): Promise<BusinessProfileResult<{ assetId: string }>> {
  try {
    if (!featureFlags.mediaUploads) {
      throw Object.assign(new Error('Media uploads disabled'), {
        code: 'FEATURE_DISABLED',
      });
    }
    const clean = validateBusinessLogoSelection(selection);
    const { client } = await secureClient(businessId);
    const staged = await stageMediaUpload(clean, 'business_logo', businessId);
    if (!staged.ok) {
      return {
        ok: false,
        code:
          staged.code === 'AUTH_REQUIRED'
            ? 'AUTH_REQUIRED'
            : staged.code === 'CONFIG_REQUIRED'
              ? 'CONFIG_REQUIRED'
              : staged.code === 'NETWORK'
                ? 'NETWORK'
                : 'INVALID',
        reason: staged.reason,
      };
    }
    if (state === 'draft') {
      const { error } = await client.rpc('nominate_business_logo', {
        target_business_id: businessId,
        target_asset_id: staged.data!.assetId,
      });
      if (error) throw error;
    }
    return {
      ok: true,
      data: { assetId: staged.data!.assetId },
      message:
        state === 'draft'
          ? 'Logo uploaded and attached to the private draft for safety processing.'
          : 'Logo uploaded privately. Save the profile to include it in the revision.',
    };
  } catch (error) {
    return failure(error, 'This logo could not be uploaded securely.');
  }
}

export async function withdrawBusinessProfileRevision(
  revisionId: string
): Promise<BusinessProfileResult> {
  try {
    assertUuid(revisionId, 'The revision reference');
    const { client } = await secureClient();
    const { error } = await client.rpc('withdraw_business_revision', {
      target_revision_id: revisionId,
    });
    if (error) throw error;
    return {
      ok: true,
      data: undefined,
      message: 'Pending profile changes were withdrawn.',
    };
  } catch (error) {
    return failure(error, 'The pending profile revision could not be withdrawn.');
  }
}
