import { checkProfessionalText } from '@/lib/moderation';
import { createAccountBoundSupabaseClient, isSupabaseConfigured } from '@/lib/supabase';

type Row = Record<string, unknown>;
type BusinessKind = 'food_truck' | 'restaurant' | 'pop_up' | 'cafe_bakery' | 'home_kitchen';
type VerificationState = 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';

export type BusinessSubmissionContact = {
  legalName: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  showPhonePublic: boolean;
  showWebsitePublic: boolean;
};

export type PendingBusinessSubmission = {
  businessId: string;
  businessName: string;
  kind: BusinessKind;
  verification: VerificationState;
  ownerPublicIds: string[];
  submittedAt: string;
  description: string;
  cuisineLabels: string[];
  priceLevel: number;
  timezone: string;
  locationCount: number;
  weeklyDayCount: number;
  payments: string[];
  publishedMenuItemCount: number;
  logoReady: boolean;
  contact: BusinessSubmissionContact;
};

export type PendingBusinessSubmissionPage = {
  items: PendingBusinessSubmission[];
  hasMore: boolean;
  nextOffset: number;
};

export type PendingMobileLocation = {
  id: string;
  label: string;
  addressLine: string | null;
  city: string;
  region: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  isPrimary: boolean;
  isApproximate: boolean;
  publicAddress: boolean;
  publicationState: 'private' | 'published' | 'archived';
};

export type PendingMobileStop = {
  id: string;
  locationId: string;
  startsAt: string;
  endsAt: string;
  state: 'draft';
};

export type PendingMobileSubmission = {
  businessId: string;
  businessName: string;
  kind: 'food_truck' | 'pop_up';
  state: 'pending';
  locations: PendingMobileLocation[];
  draftStops: PendingMobileStop[];
};

export type BusinessSubmissionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: 'AUTH' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID' | 'NETWORK' | 'UNKNOWN';
      reason: string;
    };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const businessKinds = new Set<BusinessKind>([
  'food_truck',
  'restaurant',
  'pop_up',
  'cafe_bakery',
  'home_kitchen',
]);
const verificationStates = new Set<VerificationState>([
  'unverified',
  'pending',
  'verified',
  'rejected',
  'expired',
]);

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(row: Row, key: string, label: string) {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function optionalString(row: Row, key: string) {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${key}`);
  return value.trim() || null;
}

function requiredUuid(row: Row, key: string, label: string) {
  const value = requiredString(row, key, label);
  if (!uuidPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function requiredDate(row: Row, key: string, label: string) {
  const value = requiredString(row, key, label);
  if (!Number.isFinite(new Date(value).getTime())) throw new Error(`Invalid ${label}`);
  return value;
}

function requiredInteger(row: Row, key: string, minimum: number, maximum: number) {
  const value = row[key];
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Invalid ${key}`);
  }
  return Number(value);
}

function requiredBoolean(row: Row, key: string) {
  const value = row[key];
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
  return value;
}

function requiredCoordinate(row: Row, key: string, minimum: number, maximum: number) {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${label}`);
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`Invalid ${label}`);
    return item.trim();
  });
}

function uuidArray(value: unknown, label: string) {
  const values = stringArray(value, label);
  if (values.some((value) => !uuidPattern.test(value))) throw new Error(`Invalid ${label}`);
  return values;
}

export function mapPendingBusinessSubmissionPage(
  value: unknown,
  offset = 0,
): PendingBusinessSubmissionPage {
  if (!Array.isArray(value)) throw new Error('Invalid business submission queue');
  const items = value.map((candidate): PendingBusinessSubmission => {
    if (!isRow(candidate) || !isRow(candidate.submission_snapshot)) {
      throw new Error('Invalid business submission');
    }
    const kind = candidate.kind;
    const verification = candidate.verification;
    if (typeof kind !== 'string' || !businessKinds.has(kind as BusinessKind)) {
      throw new Error('Invalid business kind');
    }
    if (typeof verification !== 'string' || !verificationStates.has(verification as VerificationState)) {
      throw new Error('Invalid verification state');
    }
    const snapshot = candidate.submission_snapshot;
    const contacts = isRow(snapshot.contacts) ? snapshot.contacts : {};
    const logo = isRow(snapshot.logo) ? snapshot.logo : null;
    return {
      businessId: requiredUuid(candidate, 'business_id', 'business reference'),
      businessName: requiredString(candidate, 'business_name', 'business name'),
      kind: kind as BusinessKind,
      verification: verification as VerificationState,
      ownerPublicIds: uuidArray(candidate.owner_public_ids, 'owner references'),
      submittedAt: requiredDate(candidate, 'submitted_at', 'submission date'),
      description: optionalString(snapshot, 'description') ?? '',
      cuisineLabels: stringArray(snapshot.cuisine_labels ?? [], 'cuisine labels', 12),
      priceLevel: requiredInteger(snapshot, 'price_level', 1, 4),
      timezone: requiredString(snapshot, 'timezone', 'timezone'),
      locationCount: requiredInteger(snapshot, 'location_count', 0, 100),
      weeklyDayCount: requiredInteger(snapshot, 'weekly_day_count', 0, 7),
      payments: stringArray(snapshot.payments ?? [], 'payments', 20),
      publishedMenuItemCount: requiredInteger(snapshot, 'published_menu_item_count', 0, 100_000),
      logoReady: Boolean(
        logo && logo.quarantine_state === 'clean' && logo.moderation === 'approved'
      ),
      contact: {
        legalName: optionalString(contacts, 'legal_name'),
        email: optionalString(contacts, 'business_email'),
        phone: optionalString(contacts, 'business_phone'),
        websiteUrl: optionalString(contacts, 'website_url'),
        showPhonePublic: contacts.show_phone_public === true,
        showWebsitePublic: contacts.show_website_public === true,
      },
    };
  });
  return {
    items,
    hasMore: value.some((candidate) => isRow(candidate) && candidate.has_more === true),
    nextOffset: offset + items.length,
  };
}

export function mapPendingMobileSubmission(value: unknown): PendingMobileSubmission {
  if (!isRow(value)) throw new Error('Invalid mobile business submission');
  const kind = value.kind;
  if (kind !== 'food_truck' && kind !== 'pop_up') throw new Error('Invalid mobile business kind');
  if (value.state !== 'pending') throw new Error('Invalid mobile business state');
  if (!Array.isArray(value.locations) || !Array.isArray(value.draft_stops)) {
    throw new Error('Invalid mobile business detail');
  }
  const locations = value.locations.map((candidate): PendingMobileLocation => {
    if (!isRow(candidate)) throw new Error('Invalid mobile location');
    const publicationState = candidate.publication_state;
    if (publicationState !== 'private' && publicationState !== 'published' && publicationState !== 'archived') {
      throw new Error('Invalid location publication state');
    }
    return {
      id: requiredUuid(candidate, 'id', 'location reference'),
      label: requiredString(candidate, 'label', 'location label'),
      addressLine: optionalString(candidate, 'address_line'),
      city: requiredString(candidate, 'city', 'location city'),
      region: requiredString(candidate, 'region', 'location region'),
      postalCode: optionalString(candidate, 'postal_code'),
      latitude: requiredCoordinate(candidate, 'latitude', -90, 90),
      longitude: requiredCoordinate(candidate, 'longitude', -180, 180),
      isPrimary: requiredBoolean(candidate, 'is_primary'),
      isApproximate: requiredBoolean(candidate, 'is_approximate'),
      publicAddress: requiredBoolean(candidate, 'public_address'),
      publicationState,
    };
  });
  if (locations.length < 1 || locations.length > 100 || locations.filter((item) => item.isPrimary).length !== 1) {
    throw new Error('Invalid primary mobile location');
  }
  const locationIds = new Set(locations.map((location) => location.id));
  if (locationIds.size !== locations.length) throw new Error('Duplicate mobile location');
  const draftStops = value.draft_stops.map((candidate): PendingMobileStop => {
    if (!isRow(candidate) || candidate.state !== 'draft') throw new Error('Invalid draft mobile stop');
    const locationId = requiredUuid(candidate, 'location_id', 'stop location reference');
    if (!locationIds.has(locationId)) throw new Error('Unknown stop location');
    const startsAt = requiredDate(candidate, 'starts_at', 'stop start');
    const endsAt = requiredDate(candidate, 'ends_at', 'stop end');
    if (new Date(endsAt) <= new Date(startsAt)) throw new Error('Invalid stop window');
    return {
      id: requiredUuid(candidate, 'id', 'stop reference'),
      locationId,
      startsAt,
      endsAt,
      state: 'draft',
    };
  });
  if (draftStops.length > 100 || new Set(draftStops.map((stop) => stop.id)).size !== draftStops.length) {
    throw new Error('Invalid draft stop collection');
  }
  return {
    businessId: requiredUuid(value, 'business_id', 'business reference'),
    businessName: requiredString(value, 'business_name', 'business name'),
    kind,
    state: 'pending',
    locations,
    draftStops,
  };
}

export function validateMobileReviewSelection(
  submission: PendingMobileSubmission,
  approvedLocationIds: string[],
  approvedStopIds: string[],
): { ok: true } | { ok: false; reason: string } {
  const locations = new Set(approvedLocationIds);
  const stops = new Set(approvedStopIds);
  if (!approvedLocationIds.length || locations.size !== approvedLocationIds.length) {
    return { ok: false, reason: 'Choose each approved location only once.' };
  }
  if (stops.size !== approvedStopIds.length) {
    return { ok: false, reason: 'Choose each approved stop only once.' };
  }
  const knownLocations = new Set(submission.locations.map((location) => location.id));
  const primary = submission.locations.find((location) => location.isPrimary);
  if (!primary || !locations.has(primary.id)) {
    return { ok: false, reason: 'The primary location must be approved.' };
  }
  if ([...locations].some((id) => !knownLocations.has(id))) {
    return { ok: false, reason: 'A selected location is no longer part of this submission.' };
  }
  const selectedStops = submission.draftStops.filter((stop) => stops.has(stop.id));
  if (selectedStops.length !== stops.size) {
    return { ok: false, reason: 'A selected stop is no longer part of this submission.' };
  }
  if (selectedStops.some((stop) => !locations.has(stop.locationId))) {
    return { ok: false, reason: 'Approve a stop’s location before approving the stop.' };
  }
  const chronological = [...selectedStops].sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt)
  );
  for (let index = 1; index < chronological.length; index += 1) {
    if (new Date(chronological[index].startsAt) < new Date(chronological[index - 1].endsAt)) {
      return { ok: false, reason: 'Approved stop times cannot overlap.' };
    }
  }
  return { ok: true };
}

function failure<T>(error: unknown, fallback: string): BusinessSubmissionResult<T> {
  const candidate = error as { code?: string; message?: string; status?: number } | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.status === 401 || message.includes('jwt') || message.includes('not authenticated')) {
    return { ok: false, code: 'AUTH', reason: 'Sign in again before reviewing business submissions.' };
  }
  if (
    candidate?.status === 403 ||
    candidate?.code === '42501' ||
    message.includes('aal2') ||
    message.includes('administrator role')
  ) {
    return { ok: false, code: 'FORBIDDEN', reason: 'A verified Spottr administrator session is required.' };
  }
  if (
    candidate?.code === '40001' ||
    message.includes('submission_changed') ||
    message.includes('not found')
  ) {
    return { ok: false, code: 'CONFLICT', reason: 'This submission changed while it was open. Reload the queue.' };
  }
  if (candidate?.code === '23P01' || message.includes('overlap')) {
    return { ok: false, code: 'INVALID', reason: 'Approved mobile stop times cannot overlap.' };
  }
  if (candidate?.code === '22023' || candidate?.code === '23514' || candidate?.code === '55000') {
    return { ok: false, code: 'INVALID', reason: fallback };
  }
  if (message.includes('fetch') || message.includes('network') || candidate?.status === 0) {
    return { ok: false, code: 'NETWORK', reason: 'Business review could not reach Spottr. Check the connection and retry.' };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback };
}

async function secureClient(expectedAccountId: string) {
  if (!isSupabaseConfigured) throw Object.assign(new Error('Live services are not configured.'), { code: 'CONFIG' });
  const client = await createAccountBoundSupabaseClient(expectedAccountId);
  if (!client) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  return client;
}

function reviewReason(value: string) {
  const moderation = checkProfessionalText(value.normalize('NFKC'), 1000);
  if (!moderation.ok || moderation.clean.length < 3) return null;
  return moderation.clean;
}

export async function loadPendingBusinessSubmissions(
  expectedAccountId: string,
  offset = 0,
  limit = 25,
): Promise<BusinessSubmissionResult<PendingBusinessSubmissionPage>> {
  try {
    const client = await secureClient(expectedAccountId);
    const safeOffset = Math.min(Math.max(Math.floor(offset), 0), 10_000);
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const { data, error } = await client.rpc('list_pending_business_submissions', {
      result_limit: safeLimit,
      result_offset: safeOffset,
    });
    if (error) throw error;
    return { ok: true, data: mapPendingBusinessSubmissionPage(data, safeOffset) };
  } catch (error) {
    return failure(error, 'The business submission queue could not be loaded.');
  }
}

export async function loadPendingMobileSubmission(
  expectedAccountId: string,
  businessId: string,
): Promise<BusinessSubmissionResult<PendingMobileSubmission>> {
  try {
    if (!uuidPattern.test(businessId)) {
      return { ok: false, code: 'INVALID', reason: 'The business reference is invalid.' };
    }
    const client = await secureClient(expectedAccountId);
    const { data, error } = await client.rpc('get_pending_business_submission', {
      target_business_id: businessId,
    });
    if (error) throw error;
    const detail = mapPendingMobileSubmission(data);
    if (detail.businessId !== businessId) throw new Error('Mismatched mobile business detail');
    return { ok: true, data: detail };
  } catch (error) {
    return failure(error, 'The exact locations and stops could not be loaded.');
  }
}

export async function approveBusinessSubmission(
  expectedAccountId: string,
  submission: PendingBusinessSubmission,
  reason: string,
  mobile?: {
    detail: PendingMobileSubmission;
    approvedLocationIds: string[];
    approvedStopIds: string[];
  },
): Promise<BusinessSubmissionResult<void>> {
  try {
    const cleanReason = reviewReason(reason);
    if (!cleanReason) {
      return { ok: false, code: 'INVALID', reason: 'Record a professional review reason from 3 to 1,000 characters.' };
    }
    const mobileKind = submission.kind === 'food_truck' || submission.kind === 'pop_up';
    if (mobileKind) {
      if (!mobile || mobile.detail.businessId !== submission.businessId) {
        return { ok: false, code: 'INVALID', reason: 'Load and review the submitted locations before approval.' };
      }
      const selection = validateMobileReviewSelection(
        mobile.detail,
        mobile.approvedLocationIds,
        mobile.approvedStopIds,
      );
      if (!selection.ok) return { ok: false, code: 'INVALID', reason: selection.reason };
    }
    const client = await secureClient(expectedAccountId);
    const response = mobileKind && mobile
      ? await client.rpc('review_business_submission', {
          target_business_id: submission.businessId,
          approved_location_ids: mobile.approvedLocationIds,
          approved_stop_ids: mobile.approvedStopIds,
          moderation_reason: cleanReason,
        })
      : await client.rpc('set_business_publication', {
          target_business_id: submission.businessId,
          next_state: 'published',
          next_verification: 'verified',
          moderation_reason: cleanReason,
        });
    if (response.error) throw response.error;
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, 'This business is not ready for publication. Review its logo, contact, hours, payment, menu, and location data.');
  }
}

export async function returnBusinessSubmission(
  expectedAccountId: string,
  submission: PendingBusinessSubmission,
  reason: string,
): Promise<BusinessSubmissionResult<void>> {
  try {
    const cleanReason = reviewReason(reason);
    if (!cleanReason) {
      return { ok: false, code: 'INVALID', reason: 'Record a professional review reason from 3 to 1,000 characters.' };
    }
    const client = await secureClient(expectedAccountId);
    const { error } = await client.rpc('set_business_publication', {
      target_business_id: submission.businessId,
      next_state: 'draft',
      next_verification: 'rejected',
      moderation_reason: cleanReason,
    });
    if (error) throw error;
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error, 'This submission could not be returned for changes.');
  }
}
