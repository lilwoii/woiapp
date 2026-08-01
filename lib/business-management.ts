import type { SupabaseClient } from '@supabase/supabase-js';

import { checkProfessionalText } from '@/lib/moderation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export type BusinessMemberRole = 'owner' | 'manager';
export type BusinessKind =
  | 'food_truck'
  | 'restaurant'
  | 'pop_up'
  | 'cafe_bakery'
  | 'home_kitchen';
export type BusinessState = 'draft' | 'pending' | 'published' | 'suspended' | 'archived';
export type PaymentKind =
  | 'cash'
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'apple_pay'
  | 'google_pay'
  | 'cash_app'
  | 'venmo';

export type ManagedBusiness = {
  id: string;
  name: string;
  kind: BusinessKind;
  state: BusinessState;
  verification: 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';
  role: BusinessMemberRole;
  timezone: string;
};

export type ManagedLocation = {
  id: string | null;
  isPrimary: boolean;
  label: string;
  addressLine: string;
  city: string;
  region: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  shareStreetAddress: boolean;
  isApproximate: boolean;
};

export type ManagedWeeklyHour = {
  weekday: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
  configured: boolean;
};

export type ManagedMenuItem = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  availability: 'available' | 'sold_out' | 'hidden';
  isPublished: boolean;
  sortOrder: number;
};

export type ManagedMenuSection = {
  id: string;
  name: string;
  isPublished: boolean;
  sortOrder: number;
  items: ManagedMenuItem[];
};

export type ManagedSpecialHour = {
  id: string;
  serviceDate: string;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
  note: string;
};

export type ManagedMobileStop = {
  id: string;
  locationId: string;
  startsOn: string;
  startsAt: string;
  endsOn: string;
  endsAt: string;
};

export type PublishedMobileStop = {
  id: string | null;
  state: 'draft' | 'scheduled' | 'live';
  locationId: string;
  startsOn: string;
  startsAt: string;
  endsOn: string;
  endsAt: string;
};

export type PublishedMobileSchedule = {
  business: ManagedBusiness;
  locations: ManagedLocation[];
  stops: PublishedMobileStop[];
};

export type BusinessConfiguration = {
  business: ManagedBusiness;
  location: ManagedLocation | null;
  locations: ManagedLocation[];
  hours: ManagedWeeklyHour[];
  payments: PaymentKind[];
  menuSections: ManagedMenuSection[];
  specialHours: ManagedSpecialHour[];
  mobileStops: ManagedMobileStop[];
  submissionRequirements: {
    contacts: boolean;
    homeKitchenPermit: boolean;
  };
};

type ResultCode = 'AUTH_REQUIRED' | 'CONFIG_REQUIRED' | 'FORBIDDEN' | 'INVALID' | 'NETWORK' | 'UNKNOWN';

export type BusinessManagementResult<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; code: ResultCode; reason: string; partial?: boolean };

type BusinessRow = {
  id: string;
  name: string;
  kind: BusinessKind;
  state: BusinessState;
  verification: ManagedBusiness['verification'];
  timezone: string;
};

type MembershipRow = {
  role: BusinessMemberRole | 'staff';
  status: 'invited' | 'active' | 'revoked';
};

type LocationRow = {
  id: string;
  label: string;
  address_line: string | null;
  city: string;
  region: string;
  postal_code: string | null;
  point: unknown;
  is_primary: boolean;
  public_address: boolean;
  is_approximate: boolean;
};

type HourRow = {
  weekday: number;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
};

type PaymentRow = { payment: PaymentKind };

type MenuSectionRow = {
  id: string;
  name: string;
  sort_order: number;
  is_published: boolean;
};

type MenuItemRow = {
  id: string;
  section_id: string;
  name: string;
  description: string;
  price_minor: number;
  availability: ManagedMenuItem['availability'];
  sort_order: number;
  is_published: boolean;
};

type SpecialHourRow = {
  id: string;
  service_date: string;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
  note: string | null;
};

type MobileStopRow = {
  id: string;
  location_id: string;
  starts_at: string;
  ends_at: string;
  state?: string;
};

class ValidationError extends Error {}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const paymentOptions: { id: PaymentKind; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'visa', label: 'Visa' },
  { id: 'mastercard', label: 'Mastercard' },
  { id: 'amex', label: 'Amex' },
  { id: 'apple_pay', label: 'Apple Pay' },
  { id: 'google_pay', label: 'Google Pay' },
  { id: 'cash_app', label: 'Cash App' },
  { id: 'venmo', label: 'Venmo' },
];

const allowedPayments = new Set<PaymentKind>(paymentOptions.map((payment) => payment.id));

function cleanProfessional(value: string, maxLength: number, label: string) {
  const result = checkProfessionalText(value, maxLength);
  if (!result.ok) throw new ValidationError(`${label}: ${result.reason}`);
  return result.clean;
}

function cleanOptionalProfessional(value: string, maxLength: number, label: string) {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return cleanProfessional(trimmed, maxLength, label);
}

function normalizeTime(value: string | null) {
  return value ? value.slice(0, 5) : '';
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDateOnly(value: string) {
  const match = value.match(datePattern);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function zonedParts(timeZone: string, value: Date) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new ValidationError('The business time zone is invalid.');
  }
  const parts = formatter.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

function localDateTimeToIso(date: string, time: string, timeZone: string) {
  if (!validDateOnly(date) || !timePattern.test(time)) {
    throw new ValidationError('Use dates like 2026-08-15 and 24-hour times like 17:30.');
  }
  const dateMatch = date.match(datePattern)!;
  const [hour, minute] = time.split(':').map(Number);
  const target = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour,
    minute,
  };
  const targetMillis = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute
  );
  let candidateMillis = targetMillis;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = zonedParts(timeZone, new Date(candidateMillis));
    const actualMillis = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute
    );
    candidateMillis += targetMillis - actualMillis;
  }
  const resolved = zonedParts(timeZone, new Date(candidateMillis));
  const matchesTarget = (parts: ReturnType<typeof zonedParts>) =>
    parts.year === target.year &&
    parts.month === target.month &&
    parts.day === target.day &&
    parts.hour === target.hour &&
    parts.minute === target.minute;
  if (!matchesTarget(resolved)) {
    throw new ValidationError(
      'That local time does not exist because of a daylight-saving clock change.'
    );
  }
  const ambiguous = [30, 60, 90, 120].some(
    (offsetMinutes) =>
      matchesTarget(
        zonedParts(timeZone, new Date(candidateMillis - offsetMinutes * 60 * 1000))
      ) ||
      matchesTarget(
        zonedParts(timeZone, new Date(candidateMillis + offsetMinutes * 60 * 1000))
      )
  );
  if (ambiguous) {
    throw new ValidationError(
      'That local time is ambiguous because of a daylight-saving clock change. Choose another time.'
    );
  }
  return new Date(candidateMillis).toISOString();
}

function isoToLocalDateTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ValidationError('A saved stop has an invalid date.');
  }
  const parts = zonedParts(timeZone, date);
  const two = (number: number) => String(number).padStart(2, '0');
  return {
    date: `${parts.year}-${two(parts.month)}-${two(parts.day)}`,
    time: `${two(parts.hour)}:${two(parts.minute)}`,
  };
}

function todayInZone(timeZone: string) {
  const parts = zonedParts(timeZone, new Date());
  const two = (number: number) => String(number).padStart(2, '0');
  return `${parts.year}-${two(parts.month)}-${two(parts.day)}`;
}

export function businessDateAfter(timeZone: string, days: number) {
  if (!Number.isInteger(days) || days < 0 || days > 730) {
    throw new ValidationError('Choose a date within the next two years.');
  }
  const today = new Date(`${todayInZone(timeZone)}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() + days);
  return today.toISOString().slice(0, 10);
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message.toLocaleLowerCase('en-US') : '';
  return message.includes('network') || message.includes('fetch') || message.includes('offline');
}

function failure(error: unknown, fallback: string, partial = false): BusinessManagementResult<never> {
  if (error instanceof ValidationError) {
    return { ok: false, code: 'INVALID', reason: error.message, partial };
  }

  const candidate = error as { code?: string; message?: string; status?: number } | null;
  const message = candidate?.message?.toLocaleLowerCase('en-US') ?? '';
  if (candidate?.code === 'CONFIG_REQUIRED') {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Connect Spottr live services before changing this business.',
      partial,
    };
  }
  if (isNetworkError(error) || candidate?.status === 0) {
    return {
      ok: false,
      code: 'NETWORK',
      reason: partial
        ? 'The connection stopped during saving. Some changes may be saved; reload before trying again.'
        : 'Spottr could not connect. Check your connection and try again.',
      partial,
    };
  }
  if (
    candidate?.status === 401 ||
    message.includes('jwt') ||
    message.includes('not authenticated')
  ) {
    return { ok: false, code: 'AUTH_REQUIRED', reason: 'Sign in again to continue.', partial };
  }
  if (message.includes('aal2') || message.includes('authenticator verification required')) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'Verify a current authenticator code in Security, then try again.',
      partial,
    };
  }
  if (
    candidate?.status === 403 ||
    candidate?.code === '42501' ||
    message.includes('permission') ||
    message.includes('row-level security') ||
    message.includes('owner role required')
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'An active owner or manager account is required for this business.',
      partial,
    };
  }
  if (
    candidate?.code === '22023' ||
    candidate?.code === '23514' ||
    candidate?.code === '23P01' ||
    message.includes('content_policy_violation')
  ) {
    return {
      ok: false,
      code: 'INVALID',
      reason:
        candidate?.code === '23P01' || message.includes('mobile_stop_time_overlap')
          ? 'This stop overlaps another upcoming stop.'
          : message.includes('content')
            ? 'Use professional, customer-safe wording and try again.'
            : fallback,
      partial,
    };
  }
  return { ok: false, code: 'UNKNOWN', reason: fallback, partial };
}

function assertBusinessId(businessId: string) {
  if (!uuidPattern.test(businessId)) {
    throw new ValidationError('This business link is invalid.');
  }
}

async function authorizeBusiness(businessId: string) {
  assertBusinessId(businessId);
  if (!isSupabaseConfigured || !supabase) {
    throw Object.assign(new Error('Live services are not configured.'), { code: 'CONFIG_REQUIRED' });
  }

  const client = supabase;
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    throw Object.assign(userError ?? new Error('Not authenticated'), { status: 401 });
  }
  const { data: assurance, error: assuranceError } =
    await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError) throw assuranceError;
  if (assurance.currentLevel !== 'aal2') {
    throw Object.assign(new Error('Authenticator verification required (AAL2).'), {
      code: '42501',
      status: 403,
    });
  }

  const { data: allowed, error: accessError } = await client.rpc('is_business_member', {
    target_business_id: businessId,
    allowed_roles: ['owner', 'manager'],
  });
  if (accessError) throw accessError;
  if (!allowed) {
    throw Object.assign(new Error('Owner or manager access required'), { status: 403 });
  }

  const [{ data: membershipData, error: membershipError }, { data: businessData, error: businessError }] =
    await Promise.all([
      client
        .from('business_members')
        .select('role, status')
        .eq('business_id', businessId)
        .eq('user_id', userData.user.id)
        .eq('status', 'active')
        .maybeSingle(),
      client
        .from('businesses')
        .select('id, name, kind, state, verification, timezone')
        .eq('id', businessId)
        .maybeSingle(),
    ]);

  if (membershipError) throw membershipError;
  if (businessError) throw businessError;
  const membership = membershipData as MembershipRow | null;
  const business = businessData as BusinessRow | null;
  if (
    !membership ||
    membership.status !== 'active' ||
    (membership.role !== 'owner' && membership.role !== 'manager') ||
    !business
  ) {
    throw Object.assign(new Error('Owner or manager access required'), { status: 403 });
  }

  return {
    client,
    userId: userData.user.id,
    role: membership.role,
    business,
  };
}

async function submitPublishedRevision(
  access: Awaited<ReturnType<typeof authorizeBusiness>>,
  businessId: string,
  proposedPatch: Record<string, unknown>
) {
  const { error } = await access.client.rpc('submit_business_revision', {
    target_business_id: businessId,
    proposed_patch: proposedPatch,
  });
  if (error) throw error;
}

function revisionLocation(
  location: ManagedLocation,
  publicationState: 'published' | 'archived' = 'published'
) {
  validateCoordinates(location.latitude, location.longitude);
  return {
    location_id: location.id,
    label: location.label,
    address_line: location.addressLine || null,
    city: location.city,
    region: location.region,
    postal_code: location.postalCode || null,
    latitude: location.latitude,
    longitude: location.longitude,
    is_primary: location.isPrimary,
    is_approximate: location.isApproximate,
    public_address: location.shareStreetAddress,
    publication_state: publicationState,
  };
}

function parseHexPoint(value: string): { latitude: number; longitude: number } | null {
  const normalized = value.replace(/^\\x/i, '');
  if (
    !/^[0-9a-f]+$/i.test(normalized) ||
    normalized.length < 42 ||
    normalized.length % 2 !== 0
  ) {
    return null;
  }
  try {
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(
        normalized.slice(index * 2, index * 2 + 2),
        16
      );
    }
    const view = new DataView(bytes.buffer);
    const littleEndian = view.getUint8(0) === 1;
    const geometryType = view.getUint32(1, littleEndian);
    let offset = 5;
    if ((geometryType & 0x20000000) !== 0) offset += 4;
    if (bytes.length < offset + 16) return null;
    const longitude = view.getFloat64(offset, littleEndian);
    const latitude = view.getFloat64(offset + 8, littleEndian);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }
    return { latitude, longitude };
  } catch {
    return null;
  }
}

function parsePoint(value: unknown): { latitude: number; longitude: number } | null {
  if (value && typeof value === 'object' && 'coordinates' in value) {
    const coordinates = (value as { coordinates?: unknown }).coordinates;
    if (
      Array.isArray(coordinates) &&
      typeof coordinates[0] === 'number' &&
      typeof coordinates[1] === 'number'
    ) {
      const [longitude, latitude] = coordinates;
      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180
      ) {
        return { longitude, latitude };
      }
      return null;
    }
  }
  if (typeof value !== 'string') return null;
  const pointMatch = value.match(
    /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i
  );
  if (pointMatch) {
    return { longitude: Number(pointMatch[1]), latitude: Number(pointMatch[2]) };
  }
  if (value.trim().startsWith('{')) {
    try {
      return parsePoint(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return parseHexPoint(value);
}

async function queryMenu(client: SupabaseClient, businessId: string) {
  const { data: sectionData, error: sectionError } = await client
    .from('menu_sections')
    .select('id, name, sort_order, is_published')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (sectionError) throw sectionError;
  const sections = (sectionData ?? []) as MenuSectionRow[];
  if (!sections.length) return [] as ManagedMenuSection[];

  const { data: itemData, error: itemError } = await client
    .from('menu_items')
    .select('id, section_id, name, description, price_minor, availability, sort_order, is_published')
    .in(
      'section_id',
      sections.map((section) => section.id)
    )
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (itemError) throw itemError;
  const items = (itemData ?? []) as MenuItemRow[];

  return sections.map((section) => ({
    id: section.id,
    name: section.name,
    isPublished: section.is_published,
    sortOrder: section.sort_order,
    items: items
      .filter((item) => item.section_id === section.id)
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        priceMinor: item.price_minor,
        availability: item.availability,
        isPublished: item.is_published,
        sortOrder: item.sort_order,
      })),
  }));
}

async function loadAuthorizedConfiguration(
  access: Awaited<ReturnType<typeof authorizeBusiness>>
): Promise<BusinessConfiguration> {
  const { client, business, role } = access;
  const today = todayInZone(business.timezone);
  const [
    locationResponse,
    hoursResponse,
    paymentResponse,
    privateDetailsResponse,
    permitResponse,
    specialHoursResponse,
    mobileStopsResponse,
    menuSections,
  ] = await Promise.all([
      client
        .from('business_locations')
        .select(
          'id, label, address_line, city, region, postal_code, point, is_primary, public_address, is_approximate'
        )
        .eq('business_id', business.id)
        .neq('publication_state', 'archived')
        .order('is_primary', { ascending: false })
        .order('updated_at', { ascending: false }),
      client
        .from('weekly_hours')
        .select('weekday, opens_at, closes_at, is_closed')
        .eq('business_id', business.id)
        .order('weekday', { ascending: true }),
      client
        .from('business_payments')
        .select('payment')
        .eq('business_id', business.id)
        .order('payment', { ascending: true }),
      client
        .from('business_private_details')
        .select('business_email, business_phone')
        .eq('business_id', business.id)
        .maybeSingle(),
      client
        .from('home_kitchen_permits')
        .select('business_id')
        .eq('business_id', business.id)
        .maybeSingle(),
      client
        .from('special_hours')
        .select('id, service_date, opens_at, closes_at, is_closed, note')
        .eq('business_id', business.id)
        .gte('service_date', today)
        .order('service_date', { ascending: true }),
      client
        .from('mobile_stops')
        .select('id, location_id, starts_at, ends_at')
        .eq('business_id', business.id)
        .eq('state', 'draft')
        .gte('ends_at', new Date().toISOString())
        .order('starts_at', { ascending: true }),
      queryMenu(client, business.id),
    ]);

  if (locationResponse.error) throw locationResponse.error;
  if (hoursResponse.error) throw hoursResponse.error;
  if (paymentResponse.error) throw paymentResponse.error;
  if (privateDetailsResponse.error) throw privateDetailsResponse.error;
  if (permitResponse.error) throw permitResponse.error;
  if (specialHoursResponse.error) throw specialHoursResponse.error;
  if (mobileStopsResponse.error) throw mobileStopsResponse.error;

  const locationRows = (locationResponse.data ?? []) as LocationRow[];
  const locations = locationRows.map((locationRow) => {
    const coordinates = parsePoint(locationRow.point);
    return {
      id: locationRow.id,
      isPrimary: locationRow.is_primary,
      label: locationRow.label,
      addressLine: locationRow.address_line ?? '',
      city: locationRow.city,
      region: locationRow.region,
      postalCode: locationRow.postal_code ?? '',
      latitude: coordinates?.latitude ?? null,
      longitude: coordinates?.longitude ?? null,
      shareStreetAddress: locationRow.public_address,
      isApproximate: locationRow.is_approximate,
    };
  });
  const primaryLocation = locations.find((entry) => entry.isPrimary) ?? null;
  const hours = (hoursResponse.data ?? []) as HourRow[];
  const payments = (paymentResponse.data ?? []) as PaymentRow[];
  const privateDetails = privateDetailsResponse.data as {
    business_email?: string | null;
    business_phone?: string | null;
  } | null;
  const specialHours = (specialHoursResponse.data ?? []) as SpecialHourRow[];
  const mobileStops = (mobileStopsResponse.data ?? []) as MobileStopRow[];

  return {
    business: { ...business, role },
    location: primaryLocation,
    locations,
    hours: hours.map((hour) => ({
      weekday: hour.weekday,
      opensAt: normalizeTime(hour.opens_at),
      closesAt: normalizeTime(hour.closes_at),
      isClosed: hour.is_closed,
      configured: true,
    })),
    payments: payments.map((payment) => payment.payment),
    menuSections,
    specialHours: specialHours.map((entry) => ({
      id: entry.id,
      serviceDate: entry.service_date,
      opensAt: normalizeTime(entry.opens_at),
      closesAt: normalizeTime(entry.closes_at),
      isClosed: entry.is_closed,
      note: entry.note ?? '',
    })),
    mobileStops: mobileStops.map((entry) => {
      const starts = isoToLocalDateTime(entry.starts_at, business.timezone);
      const ends = isoToLocalDateTime(entry.ends_at, business.timezone);
      return {
        id: entry.id,
        locationId: entry.location_id,
        startsOn: starts.date,
        startsAt: starts.time,
        endsOn: ends.date,
        endsAt: ends.time,
      };
    }),
    submissionRequirements: {
      contacts: Boolean(
        privateDetails?.business_email?.trim() && privateDetails.business_phone?.trim()
      ),
      homeKitchenPermit:
        business.kind !== 'home_kitchen' || Boolean(permitResponse.data),
    },
  };
}

export async function loadBusinessConfiguration(
  businessId: string
): Promise<BusinessManagementResult<BusinessConfiguration>> {
  if (!isSupabaseConfigured || !supabase) {
    return {
      ok: false,
      code: 'CONFIG_REQUIRED',
      reason: 'Connect Spottr live services before configuring a business.',
    };
  }
  try {
    const access = await authorizeBusiness(businessId);
    return { ok: true, data: await loadAuthorizedConfiguration(access) };
  } catch (error) {
    return failure(error, 'This business setup could not be loaded.');
  }
}

function validCoordinates(latitude: number | null, longitude: number | null) {
  return (
    latitude !== null &&
    longitude !== null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function validateCoordinates(latitude: number | null, longitude: number | null) {
  if (
    !validCoordinates(latitude, longitude)
  ) {
    throw new ValidationError('Add a valid latitude and longitude for the service pin.');
  }
}

function sanitizeManagedLocation(
  input: ManagedLocation,
  isHomeKitchen: boolean,
  isPrimary: boolean
): ManagedLocation {
  validateCoordinates(input.latitude, input.longitude);
  return {
    id: input.id,
    isPrimary,
    label: cleanProfessional(input.label, 120, 'Location label'),
    addressLine: cleanProfessional(input.addressLine, 300, 'Street address'),
    city: cleanProfessional(input.city, 120, 'City'),
    region: cleanProfessional(input.region, 80, 'State or region').toLocaleUpperCase(
      'en-US'
    ),
    postalCode: cleanProfessional(input.postalCode, 24, 'ZIP or postal code'),
    latitude: input.latitude,
    longitude: input.longitude,
    shareStreetAddress: isHomeKitchen ? false : input.shareStreetAddress,
    isApproximate: isHomeKitchen || input.isApproximate,
  };
}

function locationPayload(
  businessId: string,
  location: ManagedLocation,
  id?: string
) {
  return {
    ...(id ? { id } : {}),
    business_id: businessId,
    label: location.label,
    address_line: location.addressLine,
    city: location.city,
    region: location.region,
    postal_code: location.postalCode,
    point: `SRID=4326;POINT(${location.longitude} ${location.latitude})`,
    is_primary: location.isPrimary,
    is_approximate: location.isApproximate,
    public_address: location.shareStreetAddress,
    publication_state: 'private' as const,
  };
}

export async function savePrimaryLocation(
  businessId: string,
  input: ManagedLocation
): Promise<BusinessManagementResult<ManagedLocation>> {
  try {
    const access = await authorizeBusiness(businessId);
    if (access.business.state !== 'draft' && access.business.state !== 'published') {
      throw new ValidationError('This listing cannot accept setup changes in its current state.');
    }

    const isHomeKitchen = access.business.kind === 'home_kitchen';
    const location = sanitizeManagedLocation(input, isHomeKitchen, true);
    const payload = locationPayload(businessId, location);

    const { data: currentData, error: currentError } = await access.client
      .from('business_locations')
      .select('id')
      .eq('business_id', businessId)
      .eq('is_primary', true)
      .neq('publication_state', 'archived')
      .limit(1)
      .maybeSingle();
    if (currentError) throw currentError;

    const currentId = (currentData as { id?: string } | null)?.id ?? null;
    if (access.business.state === 'published') {
      const revisedLocation = {
        ...location,
        id: currentId ?? location.id,
      };
      await submitPublishedRevision(access, businessId, {
        locations: [revisionLocation(revisedLocation)],
      });
      return {
        ok: true,
        data: revisedLocation,
        message: 'Service-pin changes were submitted for verification. The live listing is unchanged until approval.',
      };
    }

    let savedId = currentId;
    if (currentId) {
      const { data, error } = await access.client
        .from('business_locations')
        .update(payload)
        .eq('id', currentId)
        .eq('business_id', businessId)
        .select('id')
        .single();
      if (error) throw error;
      savedId = (data as { id: string }).id;
    } else {
      const { data, error } = await access.client
        .from('business_locations')
        .insert(payload)
        .select('id')
        .single();
      if (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        const { data: racedData, error: racedError } = await access.client
          .from('business_locations')
          .select('id')
          .eq('business_id', businessId)
          .eq('is_primary', true)
          .neq('publication_state', 'archived')
          .single();
        if (racedError) throw racedError;
        const racedId = (racedData as { id: string }).id;
        const { error: retryError } = await access.client
          .from('business_locations')
          .update(payload)
          .eq('id', racedId)
          .eq('business_id', businessId);
        if (retryError) throw retryError;
        savedId = racedId;
      } else {
        savedId = (data as { id: string }).id;
      }
    }

    return {
      ok: true,
      data: {
        ...location,
        id: savedId,
      },
      message: isHomeKitchen
        ? 'Private home-kitchen service area saved. The street address will not be public.'
        : 'Private service pin saved.',
    };
  } catch (error) {
    return failure(error, 'The service pin could not be saved.');
  }
}

export async function saveDraftServiceLocations(
  businessId: string,
  input: ManagedLocation[]
): Promise<BusinessManagementResult<ManagedLocation[]>> {
  let wroteData = false;
  try {
    const access = await authorizeBusiness(businessId);
    if (access.business.state !== 'draft' && access.business.state !== 'published') {
      throw new ValidationError('This listing cannot accept service-pin changes in its current state.');
    }
    if (
      !input.length ||
      input.length > 30 ||
      input.filter((entry) => entry.isPrimary).length !== 1
    ) {
      throw new ValidationError(
        'Keep one primary service pin and no more than 29 additional stop pins.'
      );
    }
    if (access.business.kind === 'home_kitchen' && input.length !== 1) {
      throw new ValidationError('Home kitchens can save only one private service area.');
    }
    const suppliedIds = input
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id));
    if (
      suppliedIds.some((id) => !uuidPattern.test(id)) ||
      new Set(suppliedIds).size !== suppliedIds.length
    ) {
      throw new ValidationError('Each service pin must have a valid unique identifier.');
    }

    const { data: existingData, error: existingError } = await access.client
      .from('business_locations')
      .select(
        'id, label, address_line, city, region, postal_code, point, is_primary, public_address, is_approximate'
      )
      .eq('business_id', businessId)
      .neq('publication_state', 'archived');
    if (existingError) throw existingError;
    const existing = (existingData ?? []) as LocationRow[];
    const existingPrimary = existing.find((entry) => entry.is_primary);
    const requestedPrimary = input.find((entry) => entry.isPrimary)!;
    if (existingPrimary && requestedPrimary.id !== existingPrimary.id) {
      throw new ValidationError('The existing primary pin cannot be replaced from setup.');
    }

    const isHomeKitchen = access.business.kind === 'home_kitchen';
    const locations = input.map((entry) => {
      const location = sanitizeManagedLocation(
        entry,
        isHomeKitchen,
        entry.isPrimary
      );
      return {
        ...location,
        id:
          location.id ??
          (access.business.state === 'published' ? null : newUuid()),
      };
    });
    const nextIds = new Set(
      locations.map((entry) => entry.id).filter((id): id is string => Boolean(id))
    );
    const removedIds = existing
      .map((entry) => entry.id)
      .filter((id) => !nextIds.has(id));

    if (removedIds.length) {
      const { data: referencedData, error: referencedError } = await access.client
        .from('mobile_stops')
        .select('location_id')
        .eq('business_id', businessId)
        .in('location_id', removedIds)
        .limit(1);
      if (referencedError) throw referencedError;
      if (referencedData?.length) {
        throw new ValidationError(
          'Reassign or remove stops that use this pin, save the stops, then remove the pin.'
        );
      }
    }

    if (access.business.state === 'published') {
      const archivedLocations = existing
        .filter((entry) => removedIds.includes(entry.id))
        .map((entry) => {
          const coordinates = parsePoint(entry.point);
          if (!coordinates) {
            throw new ValidationError('Reload service pins before removing one.');
          }
          return revisionLocation(
            {
              id: entry.id,
              isPrimary: entry.is_primary,
              label: entry.label,
              addressLine: entry.address_line ?? '',
              city: entry.city,
              region: entry.region,
              postalCode: entry.postal_code ?? '',
              latitude: coordinates.latitude,
              longitude: coordinates.longitude,
              shareStreetAddress: entry.public_address,
              isApproximate: entry.is_approximate,
            },
            'archived'
          );
        });
      await submitPublishedRevision(access, businessId, {
        locations: [
          ...locations.map((entry) => revisionLocation(entry)),
          ...archivedLocations,
        ],
      });
      return {
        ok: true,
        data: locations,
        message: 'Service-pin changes were submitted for verification. The live map is unchanged until approval.',
      };
    }

    const { error: upsertError } = await access.client
      .from('business_locations')
      .upsert(
        locations.map((entry) => locationPayload(businessId, entry, entry.id!)),
        { onConflict: 'id', defaultToNull: false }
      );
    if (upsertError) throw upsertError;
    wroteData = true;

    if (removedIds.length) {
      const { error: deleteError } = await access.client
        .from('business_locations')
        .delete()
        .eq('business_id', businessId)
        .eq('is_primary', false)
        .in('id', removedIds);
      if (deleteError) throw deleteError;
    }

    return {
      ok: true,
      data: locations,
      message:
        locations.length === 1
          ? 'Private service pin saved.'
          : `${locations.length} private service pins saved.`,
    };
  } catch (error) {
    return failure(error, 'Service pins could not be saved.', wroteData);
  }
}

export function validateWeeklyHours(hours: ManagedWeeklyHour[]) {
  if (
    hours.length !== 7 ||
    new Set(hours.map((hour) => hour.weekday)).size !== 7 ||
    hours.some(
      (hour) =>
        !Number.isInteger(hour.weekday) ||
        hour.weekday < 0 ||
        hour.weekday > 6 ||
        !hour.configured
    )
  ) {
    throw new ValidationError('Confirm hours for all seven days, including closed days.');
  }

  return [...hours]
    .sort((left, right) => left.weekday - right.weekday)
    .map((hour) => {
      if (hour.isClosed) {
        return {
          weekday: hour.weekday,
          opensAt: '',
          closesAt: '',
          isClosed: true,
          configured: true,
        };
      }
      if (!timePattern.test(hour.opensAt) || !timePattern.test(hour.closesAt)) {
        throw new ValidationError('Use 24-hour times such as 09:00 or 17:30.');
      }
      if (hour.opensAt === hour.closesAt) {
        throw new ValidationError('Opening and closing times must be different.');
      }
      return { ...hour, configured: true };
    });
}

export async function saveWeeklyHours(
  businessId: string,
  input: ManagedWeeklyHour[]
): Promise<BusinessManagementResult<ManagedWeeklyHour[]>> {
  try {
    const access = await authorizeBusiness(businessId);
    if (access.business.state !== 'draft' && access.business.state !== 'published') {
      throw new ValidationError('This listing cannot accept hours changes in its current state.');
    }
    const hours = validateWeeklyHours(input);
    if (access.business.state === 'published') {
      await submitPublishedRevision(access, businessId, {
        weekly_hours: hours.map((hour) => ({
          weekday: hour.weekday,
          opens_at: hour.isClosed ? null : hour.opensAt,
          closes_at: hour.isClosed ? null : hour.closesAt,
          is_closed: hour.isClosed,
        })),
      });
      return {
        ok: true,
        data: hours,
        message: 'Weekly-hours changes were submitted for verification. Current public hours remain live until approval.',
      };
    }
    const { error } = await access.client.from('weekly_hours').upsert(
      hours.map((hour) => ({
        business_id: businessId,
        weekday: hour.weekday,
        opens_at: hour.isClosed ? null : hour.opensAt,
        closes_at: hour.isClosed ? null : hour.closesAt,
        is_closed: hour.isClosed,
      })),
      { onConflict: 'business_id,weekday', defaultToNull: false }
    );
    if (error) throw error;
    return { ok: true, data: hours, message: 'Weekly hours saved.' };
  } catch (error) {
    return failure(error, 'Weekly hours could not be saved.');
  }
}

export async function saveBusinessPayments(
  businessId: string,
  input: PaymentKind[]
): Promise<BusinessManagementResult<PaymentKind[]>> {
  let changed = false;
  try {
    const access = await authorizeBusiness(businessId);
    if (access.business.state !== 'draft' && access.business.state !== 'published') {
      throw new ValidationError('This listing cannot accept payment changes in its current state.');
    }
    const payments = [...new Set(input)];
    if (!payments.length || payments.some((payment) => !allowedPayments.has(payment))) {
      throw new ValidationError('Select at least one accepted payment method.');
    }
    if (access.business.state === 'published') {
      await submitPublishedRevision(access, businessId, { payments });
      return {
        ok: true,
        data: payments,
        message: 'Payment changes were submitted for verification. Current public methods remain live until approval.',
      };
    }

    const { data, error } = await access.client
      .from('business_payments')
      .select('payment')
      .eq('business_id', businessId);
    if (error) throw error;
    const current = ((data ?? []) as PaymentRow[]).map((row) => row.payment);
    const additions = payments.filter((payment) => !current.includes(payment));
    const removals = current.filter((payment) => !payments.includes(payment));

    if (additions.length) {
      const { error: insertError } = await access.client.from('business_payments').upsert(
        additions.map((payment) => ({ business_id: businessId, payment })),
        {
          onConflict: 'business_id,payment',
          ignoreDuplicates: true,
          defaultToNull: false,
        }
      );
      if (insertError) throw insertError;
      changed = true;
    }
    if (removals.length) {
      const { error: deleteError } = await access.client
        .from('business_payments')
        .delete()
        .eq('business_id', businessId)
        .in('payment', removals);
      if (deleteError) throw deleteError;
      changed = true;
    }

    return { ok: true, data: payments, message: 'Accepted payments saved.' };
  } catch (error) {
    return failure(error, 'Accepted payments could not be saved.', changed);
  }
}

function newUuid() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

export function createMenuSectionDraft(sortOrder = 0): ManagedMenuSection {
  return {
    id: newUuid(),
    name: '',
    isPublished: true,
    sortOrder,
    items: [],
  };
}

export function createMenuItemDraft(sortOrder = 0): ManagedMenuItem {
  return {
    id: newUuid(),
    name: '',
    description: '',
    priceMinor: 0,
    availability: 'available',
    isPublished: true,
    sortOrder,
  };
}

export function createSpecialHourDraft(serviceDate = ''): ManagedSpecialHour {
  return {
    id: newUuid(),
    serviceDate,
    opensAt: '09:00',
    closesAt: '17:00',
    isClosed: false,
    note: '',
  };
}

export function createMobileStopDraft(
  locationId: string,
  serviceDate = ''
): ManagedMobileStop {
  return {
    id: newUuid(),
    locationId,
    startsOn: serviceDate,
    startsAt: '11:00',
    endsOn: serviceDate,
    endsAt: '14:00',
  };
}

export function validateSpecialHours(
  input: ManagedSpecialHour[],
  minimumDate: string
) {
  if (!validDateOnly(minimumDate)) {
    throw new ValidationError('The business date could not be determined.');
  }
  if (input.length > 60) {
    throw new ValidationError('Add no more than 60 upcoming special-hour dates.');
  }
  const horizon = new Date(`${minimumDate}T00:00:00.000Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 730);
  const maximumDate = horizon.toISOString().slice(0, 10);
  const ids = new Set<string>();
  const dates = new Set<string>();

  return [...input]
    .map((entry) => {
      if (!uuidPattern.test(entry.id) || ids.has(entry.id)) {
        throw new ValidationError('Each special-hours entry must have a unique identifier.');
      }
      ids.add(entry.id);
      if (
        !validDateOnly(entry.serviceDate) ||
        entry.serviceDate < minimumDate ||
        entry.serviceDate > maximumDate
      ) {
        throw new ValidationError(
          'Special hours must use a valid date within the next two years.'
        );
      }
      if (dates.has(entry.serviceDate)) {
        throw new ValidationError('Add only one special-hours entry for each date.');
      }
      dates.add(entry.serviceDate);
      if (typeof entry.isClosed !== 'boolean') {
        throw new ValidationError('Reload special hours and try again.');
      }
      if (
        !entry.isClosed &&
        (!timePattern.test(entry.opensAt) ||
          !timePattern.test(entry.closesAt) ||
          entry.opensAt === entry.closesAt)
      ) {
        throw new ValidationError(
          'Open special-hour dates need different 24-hour opening and closing times.'
        );
      }
      return {
        ...entry,
        opensAt: entry.isClosed ? '' : entry.opensAt,
        closesAt: entry.isClosed ? '' : entry.closesAt,
        note: cleanOptionalProfessional(entry.note, 240, 'Special-hours note'),
      };
    })
    .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
}

export async function saveBusinessSpecialHours(
  businessId: string,
  input: ManagedSpecialHour[]
): Promise<BusinessManagementResult<ManagedSpecialHour[]>> {
  let wroteData = false;
  try {
    const access = await authorizeBusiness(businessId);
    if (access.business.state !== 'draft' && access.business.state !== 'published') {
      throw new ValidationError('This listing cannot accept special-hours changes in its current state.');
    }
    const minimumDate = todayInZone(access.business.timezone);
    const entries = validateSpecialHours(input, minimumDate);
    if (access.business.state === 'published') {
      await submitPublishedRevision(access, businessId, {
        special_hours: entries.map((entry) => ({
          service_date: entry.serviceDate,
          opens_at: entry.isClosed ? null : entry.opensAt,
          closes_at: entry.isClosed ? null : entry.closesAt,
          is_closed: entry.isClosed,
          note: entry.note || null,
        })),
      });
      return {
        ok: true,
        data: entries,
        message: 'Special-hours changes were submitted for verification. Current public exceptions remain live until approval.',
      };
    }
    const { data: existingData, error: existingError } = await access.client
      .from('special_hours')
      .select('id')
      .eq('business_id', businessId)
      .gte('service_date', minimumDate);
    if (existingError) throw existingError;
    const existingIds = ((existingData ?? []) as { id: string }[]).map((entry) => entry.id);

    if (entries.length) {
      const { error } = await access.client.from('special_hours').upsert(
        entries.map((entry) => ({
          id: entry.id,
          business_id: businessId,
          service_date: entry.serviceDate,
          opens_at: entry.isClosed ? null : entry.opensAt,
          closes_at: entry.isClosed ? null : entry.closesAt,
          is_closed: entry.isClosed,
          note: entry.note || null,
        })),
        { onConflict: 'id', defaultToNull: false }
      );
      if (error) throw error;
      wroteData = true;
    }

    const nextIds = new Set(entries.map((entry) => entry.id));
    const removedIds = existingIds.filter((id) => !nextIds.has(id));
    if (removedIds.length) {
      const { error } = await access.client
        .from('special_hours')
        .delete()
        .eq('business_id', businessId)
        .gte('service_date', minimumDate)
        .in('id', removedIds);
      if (error) throw error;
      wroteData = true;
    }

    return { ok: true, data: entries, message: 'Special hours saved.' };
  } catch (error) {
    return failure(error, 'Special hours could not be saved.', wroteData);
  }
}

export function validateMobileStopSchedule(
  input: ManagedMobileStop[],
  timeZone: string,
  now = new Date()
) {
  if (input.length > 60) {
    throw new ValidationError('Add no more than 60 upcoming stops.');
  }
  const ids = new Set<string>();
  const maximumStart = now.getTime() + 366 * 24 * 60 * 60 * 1000;
  const earliestStart = now.getTime() - 5 * 60 * 1000;
  const entries = input.map((entry) => {
    if (
      !uuidPattern.test(entry.id) ||
      ids.has(entry.id) ||
      !uuidPattern.test(entry.locationId)
    ) {
      throw new ValidationError('Each upcoming stop must have a valid unique identifier.');
    }
    ids.add(entry.id);
    const startsIso = localDateTimeToIso(entry.startsOn, entry.startsAt, timeZone);
    const endsIso = localDateTimeToIso(entry.endsOn, entry.endsAt, timeZone);
    const startsMillis = Date.parse(startsIso);
    const endsMillis = Date.parse(endsIso);
    if (startsMillis < earliestStart || startsMillis > maximumStart) {
      throw new ValidationError('Upcoming stops must start within the next year.');
    }
    if (endsMillis <= startsMillis) {
      throw new ValidationError('Each stop must end after it starts.');
    }
    if (endsMillis - startsMillis > 7 * 24 * 60 * 60 * 1000) {
      throw new ValidationError('A stop cannot last longer than seven days.');
    }
    return { ...entry, startsIso, endsIso, startsMillis, endsMillis };
  });

  entries.sort((left, right) => left.startsMillis - right.startsMillis);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].startsMillis < entries[index - 1].endsMillis) {
      throw new ValidationError('Upcoming stops for one business cannot overlap.');
    }
  }
  return entries;
}

export async function saveDraftMobileStops(
  businessId: string,
  input: ManagedMobileStop[]
): Promise<BusinessManagementResult<ManagedMobileStop[]>> {
  let wroteData = false;
  try {
    const access = await authorizeBusiness(businessId);
    if (access.business.state !== 'draft') {
      throw new ValidationError('Only draft listings can change setup details.');
    }
    const entries = validateMobileStopSchedule(input, access.business.timezone);
    const locationIds = [...new Set(entries.map((entry) => entry.locationId))];
    if (locationIds.length) {
      const { data, error } = await access.client
        .from('business_locations')
        .select('id')
        .eq('business_id', businessId)
        .neq('publication_state', 'archived')
        .in('id', locationIds);
      if (error) throw error;
      const validIds = new Set(((data ?? []) as { id: string }[]).map((entry) => entry.id));
      if (locationIds.some((id) => !validIds.has(id))) {
        throw new ValidationError('Reload setup and choose a current business location.');
      }
    }

    const { data: existingData, error: existingError } = await access.client
      .from('mobile_stops')
      .select('id, state')
      .eq('business_id', businessId);
    if (existingError) throw existingError;
    const existing = (existingData ?? []) as { id: string; state: string }[];
    const nonDraftIds = new Set(
      existing.filter((entry) => entry.state !== 'draft').map((entry) => entry.id)
    );
    if (entries.some((entry) => nonDraftIds.has(entry.id))) {
      throw new ValidationError('A scheduled or live stop cannot be changed from draft setup.');
    }

    if (entries.length) {
      const { error } = await access.client.from('mobile_stops').upsert(
        entries.map((entry) => ({
          id: entry.id,
          business_id: businessId,
          location_id: entry.locationId,
          starts_at: entry.startsIso,
          ends_at: entry.endsIso,
          state: 'draft',
          confirmed_at: null,
        })),
        { onConflict: 'id', defaultToNull: false }
      );
      if (error) throw error;
      wroteData = true;
    }

    const nextIds = new Set(entries.map((entry) => entry.id));
    const removedIds = existing
      .filter((entry) => entry.state === 'draft' && !nextIds.has(entry.id))
      .map((entry) => entry.id);
    if (removedIds.length) {
      const { error } = await access.client
        .from('mobile_stops')
        .delete()
        .eq('business_id', businessId)
        .eq('state', 'draft')
        .in('id', removedIds);
      if (error) throw error;
      wroteData = true;
    }

    return {
      ok: true,
      data: entries.map(({ startsIso, endsIso, startsMillis, endsMillis, ...entry }) => entry),
      message: 'Upcoming draft stops saved for review.',
    };
  } catch (error) {
    return failure(error, 'Upcoming stops could not be saved.', wroteData);
  }
}

export function createPublishedMobileStop(
  locationId: string,
  serviceDate: string
): PublishedMobileStop {
  return {
    id: null,
    state: 'scheduled',
    locationId,
    startsOn: serviceDate,
    startsAt: '11:00',
    endsOn: serviceDate,
    endsAt: '14:00',
  };
}

export async function loadPublishedMobileSchedule(
  businessId: string
): Promise<BusinessManagementResult<PublishedMobileSchedule>> {
  try {
    const access = await authorizeBusiness(businessId);
    if (
      access.business.state !== 'published' ||
      !['food_truck', 'pop_up'].includes(access.business.kind)
    ) {
      throw new ValidationError(
        'Published scheduling is available for food trucks and pop-ups.'
      );
    }
    const [locationResponse, stopResponse] = await Promise.all([
      access.client
        .from('business_locations')
        .select(
          'id, label, address_line, city, region, postal_code, point, is_primary, public_address, is_approximate'
        )
        .eq('business_id', businessId)
        .eq('publication_state', 'published')
        .order('is_primary', { ascending: false })
        .order('label', { ascending: true }),
      access.client
        .from('mobile_stops')
        .select('id, location_id, starts_at, ends_at, state')
        .eq('business_id', businessId)
        .in('state', ['draft', 'scheduled', 'live'])
        .gte('ends_at', new Date().toISOString())
        .order('starts_at', { ascending: true }),
    ]);
    if (locationResponse.error) throw locationResponse.error;
    if (stopResponse.error) throw stopResponse.error;

    const locations = ((locationResponse.data ?? []) as LocationRow[]).map((entry) => {
      const coordinates = parsePoint(entry.point);
      return {
        id: entry.id,
        isPrimary: entry.is_primary,
        label: entry.label,
        addressLine: entry.address_line ?? '',
        city: entry.city,
        region: entry.region,
        postalCode: entry.postal_code ?? '',
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
        shareStreetAddress: entry.public_address,
        isApproximate: entry.is_approximate,
      };
    });
    const stops = ((stopResponse.data ?? []) as MobileStopRow[]).map<PublishedMobileStop>((entry) => {
      const starts = isoToLocalDateTime(entry.starts_at, access.business.timezone);
      const ends = isoToLocalDateTime(entry.ends_at, access.business.timezone);
      return {
        id: entry.id,
        state:
          entry.state === 'live'
            ? 'live'
            : entry.state === 'draft'
              ? 'draft'
              : 'scheduled',
        locationId: entry.location_id,
        startsOn: starts.date,
        startsAt: starts.time,
        endsOn: ends.date,
        endsAt: ends.time,
      };
    });

    return {
      ok: true,
      data: {
        business: { ...access.business, role: access.role },
        locations,
        stops,
      },
    };
  } catch (error) {
    return failure(error, 'Upcoming stops could not be loaded.');
  }
}

export async function schedulePublishedMobileStop(
  businessId: string,
  input: PublishedMobileStop
): Promise<BusinessManagementResult<PublishedMobileStop>> {
  try {
    const access = await authorizeBusiness(businessId);
    if (
      access.business.state !== 'published' ||
      !['food_truck', 'pop_up'].includes(access.business.kind)
    ) {
      throw new ValidationError(
        'Published scheduling is available for food trucks and pop-ups.'
      );
    }
    if (!uuidPattern.test(input.locationId) || (input.id && !uuidPattern.test(input.id))) {
      throw new ValidationError('Reload the schedule and choose a published service pin.');
    }
    const startsIso = localDateTimeToIso(
      input.startsOn,
      input.startsAt,
      access.business.timezone
    );
    const endsIso = localDateTimeToIso(
      input.endsOn,
      input.endsAt,
      access.business.timezone
    );
    const startsMillis = Date.parse(startsIso);
    const endsMillis = Date.parse(endsIso);
    const now = Date.now();
    const extendingLiveStop = Boolean(input.id) && input.state === 'live';
    if (
      (!extendingLiveStop && startsMillis < now - 15 * 60 * 1000) ||
      startsMillis > now + 90 * 24 * 60 * 60 * 1000
    ) {
      throw new ValidationError('Published stops must start within the next 90 days.');
    }
    if (
      endsMillis <= startsMillis ||
      endsMillis - startsMillis > 7 * 24 * 60 * 60 * 1000
    ) {
      throw new ValidationError(
        'A stop must end after it starts and cannot last longer than seven days.'
      );
    }

    const { data: existingData, error: existingError } = await access.client
      .from('mobile_stops')
      .select('id, starts_at, ends_at')
      .eq('business_id', businessId)
      .in('state', ['scheduled', 'live'])
      .gte('ends_at', new Date().toISOString());
    if (existingError) throw existingError;
    const overlaps = ((existingData ?? []) as {
      id: string;
      starts_at: string;
      ends_at: string;
    }[]).some(
      (entry) =>
        entry.id !== input.id &&
        Date.parse(entry.starts_at) < endsMillis &&
        Date.parse(entry.ends_at) > startsMillis
    );
    if (overlaps) {
      throw new ValidationError('Upcoming stops for one business cannot overlap.');
    }

    const { data, error } = await access.client.rpc('schedule_mobile_stop', {
      target_business_id: businessId,
      target_location_id: input.locationId,
      stop_starts_at: startsIso,
      stop_ends_at: endsIso,
      target_stop_id: input.id,
    });
    if (error) throw error;
    const savedId = typeof data === 'string' ? data : null;
    if (!savedId || !uuidPattern.test(savedId)) {
      throw new Error('Scheduled stop identifier was not returned');
    }
    return {
      ok: true,
      data: {
        ...input,
        id: savedId,
        state:
          Date.now() >= startsMillis && Date.now() < endsMillis
            ? 'live'
            : 'scheduled',
      },
      message: input.id ? 'Upcoming stop updated.' : 'Upcoming stop scheduled.',
    };
  } catch (error) {
    return failure(error, 'The upcoming stop could not be scheduled.');
  }
}

export async function cancelPublishedMobileStop(
  businessId: string,
  stopId: string
): Promise<BusinessManagementResult<null>> {
  try {
    assertBusinessId(businessId);
    if (!uuidPattern.test(stopId)) {
      throw new ValidationError('Reload the schedule and choose an upcoming stop.');
    }
    const access = await authorizeBusiness(businessId);
    if (
      access.business.state !== 'published' ||
      !['food_truck', 'pop_up'].includes(access.business.kind)
    ) {
      throw new ValidationError(
        'Published scheduling is available for food trucks and pop-ups.'
      );
    }
    const { error } = await access.client.rpc('cancel_mobile_stop', {
      target_stop_id: stopId,
    });
    if (error) throw error;
    return {
      ok: true,
      data: null,
      message: 'Upcoming stop cancelled.',
    };
  } catch (error) {
    return failure(error, 'The upcoming stop could not be cancelled.');
  }
}

export function validateMenuConfiguration(input: ManagedMenuSection[]) {
  if (input.length > 20) throw new ValidationError('Menus can contain up to 20 sections.');
  const totalItems = input.reduce((total, section) => total + section.items.length, 0);
  if (totalItems > 200) throw new ValidationError('Menus can contain up to 200 items.');

  const sectionNames = new Set<string>();
  const sectionIds = new Set<string>();
  const itemIds = new Set<string>();
  return input.map((section, sectionIndex) => {
    if (!uuidPattern.test(section.id)) throw new ValidationError('Reload this menu and try again.');
    if (sectionIds.has(section.id)) {
      throw new ValidationError('Each menu section must have a unique identifier.');
    }
    sectionIds.add(section.id);
    if (typeof section.isPublished !== 'boolean') {
      throw new ValidationError('Reload this menu and try again.');
    }
    const name = cleanProfessional(section.name, 80, 'Section name');
    const nameKey = name.toLocaleLowerCase('en-US');
    if (sectionNames.has(nameKey)) throw new ValidationError('Menu section names must be unique.');
    sectionNames.add(nameKey);
    const itemNames = new Set<string>();
    const items = section.items.map((item, itemIndex) => {
      if (!uuidPattern.test(item.id)) throw new ValidationError('Reload this menu and try again.');
      if (itemIds.has(item.id)) {
        throw new ValidationError('Each menu item must have a unique identifier.');
      }
      itemIds.add(item.id);
      if (
        typeof item.isPublished !== 'boolean' ||
        !['available', 'sold_out', 'hidden'].includes(item.availability)
      ) {
        throw new ValidationError('Reload this menu and try again.');
      }
      const itemName = cleanProfessional(item.name, 120, 'Item name');
      const itemKey = itemName.toLocaleLowerCase('en-US');
      if (itemNames.has(itemKey)) {
        throw new ValidationError(`Item names in ${name} must be unique.`);
      }
      itemNames.add(itemKey);
      if (!Number.isInteger(item.priceMinor) || item.priceMinor < 0 || item.priceMinor > 100000000) {
        throw new ValidationError(`${itemName} needs a valid price.`);
      }
      return {
        ...item,
        name: itemName,
        description: cleanOptionalProfessional(item.description, 1000, `${itemName} description`),
        sortOrder: itemIndex,
      };
    });
    return { ...section, name, sortOrder: sectionIndex, items };
  });
}

export async function saveBusinessMenu(
  businessId: string,
  input: ManagedMenuSection[]
): Promise<BusinessManagementResult<ManagedMenuSection[]>> {
  let wroteData = false;
  try {
    const access = await authorizeBusiness(businessId);
    if (access.business.state !== 'draft' && access.business.state !== 'published') {
      throw new ValidationError('This listing cannot accept menu changes in its current state.');
    }
    const menu = validateMenuConfiguration(input);
    if (access.business.state === 'published') {
      const publicMenu = menu
        .filter((section) => section.isPublished)
        .map((section) => ({
          name: section.name,
          sort_order: section.sortOrder,
          items: section.items
            .filter((item) => item.isPublished)
            .map((item) => ({
              name: item.name,
              description: item.description,
              price_minor: item.priceMinor,
              currency: 'USD',
              availability: item.availability,
              dietary_tags: [],
              allergen_note: null,
              sort_order: item.sortOrder,
            })),
        }));
      if (!publicMenu.length || publicMenu.some((section) => !section.items.length)) {
        throw new ValidationError(
          'A published menu needs at least one visible item in every visible section.'
        );
      }
      await submitPublishedRevision(access, businessId, { menu: publicMenu });
      return {
        ok: true,
        data: menu,
        message: 'Menu changes were submitted for verification. The current public menu remains live until approval.',
      };
    }
    const { data: existingSectionData, error: existingSectionError } = await access.client
      .from('menu_sections')
      .select('id')
      .eq('business_id', businessId);
    if (existingSectionError) throw existingSectionError;
    const existingSectionIds = ((existingSectionData ?? []) as { id: string }[]).map(
      (section) => section.id
    );

    let existingItems: { id: string; section_id: string }[] = [];
    if (existingSectionIds.length) {
      const { data, error } = await access.client
        .from('menu_items')
        .select('id, section_id')
        .in('section_id', existingSectionIds);
      if (error) throw error;
      existingItems = (data ?? []) as { id: string; section_id: string }[];
    }

    if (menu.length) {
      const { error } = await access.client
        .from('menu_sections')
        .upsert(
          menu.map((section) => ({
            id: section.id,
            business_id: businessId,
            name: section.name,
            sort_order: section.sortOrder,
            is_published: section.isPublished,
          })),
          { onConflict: 'id', defaultToNull: false }
        );
      if (error) throw error;
      wroteData = true;
    }

    const menuItems = menu.flatMap((section) =>
      section.items.map((item) => ({
              id: item.id,
              section_id: section.id,
              name: item.name,
              description: item.description,
              price_minor: item.priceMinor,
              currency: 'USD',
              availability: item.availability,
              dietary_tags: [],
              allergen_note: null,
              sort_order: item.sortOrder,
              is_published: item.isPublished,
            }))
    );
    if (menuItems.length) {
      const { error } = await access.client
        .from('menu_items')
        .upsert(menuItems, { onConflict: 'id', defaultToNull: false });
      if (error) throw error;
      wroteData = true;
    }

    const nextSectionIds = new Set(menu.map((section) => section.id));
    const nextItemIds = new Set(menu.flatMap((section) => section.items.map((item) => item.id)));
    const removedItemIds = existingItems
      .filter((item) => nextSectionIds.has(item.section_id) && !nextItemIds.has(item.id))
      .map((item) => item.id);
    if (removedItemIds.length) {
      const { error } = await access.client.from('menu_items').delete().in('id', removedItemIds);
      if (error) throw error;
      wroteData = true;
    }
    const removedSectionIds = existingSectionIds.filter((id) => !nextSectionIds.has(id));
    if (removedSectionIds.length) {
      const { error } = await access.client
        .from('menu_sections')
        .delete()
        .eq('business_id', businessId)
        .in('id', removedSectionIds);
      if (error) throw error;
      wroteData = true;
    }

    return { ok: true, data: menu, message: 'Menu saved.' };
  } catch (error) {
    return failure(error, 'The menu could not be saved.', wroteData);
  }
}

export function configurationReadiness(configuration: BusinessConfiguration) {
  const validHours =
    configuration.hours.length === 7 &&
    new Set(configuration.hours.map((hour) => hour.weekday)).size === 7 &&
    configuration.hours.every(
      (hour) =>
        hour.configured &&
        (hour.isClosed ||
          (timePattern.test(hour.opensAt) &&
            timePattern.test(hour.closesAt) &&
            hour.opensAt !== hour.closesAt))
    );
  const hasPublishedMenu = configuration.menuSections.some(
    (section) =>
      section.isPublished &&
      section.items.some((item) => item.isPublished && item.availability !== 'hidden')
  );
  const location = configuration.location;
  const locationReady =
    Boolean(location) &&
    Boolean(location?.label.trim()) &&
    Boolean(location?.addressLine.trim()) &&
    Boolean(location?.city.trim()) &&
    Boolean(location?.region.trim()) &&
    Boolean(location?.postalCode.trim()) &&
    validCoordinates(location?.latitude ?? null, location?.longitude ?? null) &&
    (configuration.business.kind !== 'home_kitchen' ||
      (!location?.shareStreetAddress && Boolean(location?.isApproximate)));
  return {
    location: locationReady,
    hours: validHours,
    payments:
      configuration.payments.length > 0 &&
      configuration.payments.every((payment) => allowedPayments.has(payment)),
    menu: hasPublishedMenu,
    contacts: configuration.submissionRequirements.contacts,
    permit: configuration.submissionRequirements.homeKitchenPermit,
  };
}

export async function submitBusinessConfiguration(
  businessId: string
): Promise<BusinessManagementResult<BusinessConfiguration>> {
  try {
    const access = await authorizeBusiness(businessId);
    if (access.role !== 'owner') {
      throw Object.assign(new Error('Business owner role required'), { status: 403 });
    }
    const configuration = await loadAuthorizedConfiguration(access);
    if (configuration.business.state === 'pending') {
      return {
        ok: true,
        data: configuration,
        message: 'This listing is already in the verification queue.',
      };
    }
    if (configuration.business.state !== 'draft') {
      throw new ValidationError('Only draft listings can be submitted for verification.');
    }
    const readiness = configurationReadiness(configuration);
    const missing = [
      !readiness.location && 'a private service pin',
      !readiness.hours && 'all seven days of hours',
      !readiness.payments && 'an accepted payment method',
      !readiness.menu && 'a published menu section and item',
      !readiness.contacts && 'a business email and phone number',
      !readiness.permit && 'a home-kitchen permit submission',
    ].filter(Boolean) as string[];
    if (missing.length) {
      throw new ValidationError(`Complete ${missing.join(', ')} before submitting.`);
    }

    const { error } = await access.client.rpc('submit_business_for_review', {
      target_business_id: businessId,
    });
    if (error) throw error;
    return {
      ok: true,
      data: {
        ...configuration,
        business: {
          ...configuration.business,
          state: 'pending',
          verification: 'pending',
        },
      },
      message: 'Submitted for verification. Setup is locked while the listing is reviewed.',
    };
  } catch (error) {
    return failure(error, 'This listing could not be submitted for verification.');
  }
}
