import {
  MOVING_TO_NEXT_LOCATION_LABEL,
  type MovingServiceState,
  type Place,
} from '@/types/marketplace';

type Row = Record<string, unknown>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatStopWindow(startsAt: Date, endsAt: Date, timeZone: string) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(startsAt);
  const start = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(startsAt);
  const end = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(endsAt);
  return `${date} · ${start}–${end}`;
}

/**
 * Accept only the narrow, server-produced public moving projection. Raw mobile
 * stops and member-visible business locations must never be used here because
 * they may contain private operational addresses.
 */
export function movingServiceFromPublicRow(
  row: Row | undefined,
  expectedBusinessId: string,
  timeZone: string,
  nowMs = Date.now(),
): MovingServiceState | undefined {
  if (
    !row ||
    row.mobility_state !== 'moving_to_next_location' ||
    stringValue(row.business_id) !== expectedBusinessId ||
    !uuidPattern.test(expectedBusinessId) ||
    row.is_approximate !== false
  ) return undefined;

  const locationId = stringValue(row.next_stop_location_id);
  const address = stringValue(row.next_stop_address_line);
  const city = stringValue(row.next_stop_city);
  const region = stringValue(row.next_stop_region);
  const postalCode = stringValue(row.next_stop_postal_code);
  const startsAtValue = stringValue(row.next_stop_starts_at);
  const endsAtValue = stringValue(row.next_stop_ends_at);
  const startsAt = new Date(startsAtValue);
  const endsAt = new Date(endsAtValue);
  if (
    !uuidPattern.test(locationId) ||
    !address ||
    !city ||
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    startsAt.getTime() <= nowMs ||
    endsAt.getTime() <= startsAt.getTime()
  ) return undefined;

  return {
    state: 'moving_to_next_location',
    label: MOVING_TO_NEXT_LOCATION_LABEL,
    nextStop: {
      locationId,
      address,
      city,
      ...(region ? { region } : {}),
      ...(postalCode ? { postalCode } : {}),
      startsAt: startsAtValue,
      endsAt: endsAtValue,
      timeWindow: formatStopWindow(startsAt, endsAt, timeZone),
    },
  };
}

export function earliestMovingServiceBoundary(
  places: readonly Pick<Place, 'id' | 'mobility'>[],
): { startsAtMs: number; placeIds: string[] } | null {
  let startsAtMs = Number.POSITIVE_INFINITY;
  const placeIds: string[] = [];

  for (const place of places) {
    if (!place.mobility || !uuidPattern.test(place.id)) continue;
    const candidate = Date.parse(place.mobility.nextStop.startsAt);
    if (!Number.isFinite(candidate)) continue;
    if (candidate < startsAtMs) {
      startsAtMs = candidate;
      placeIds.length = 0;
      placeIds.push(place.id);
    } else if (candidate === startsAtMs) {
      placeIds.push(place.id);
    }
  }

  return Number.isFinite(startsAtMs) && placeIds.length
    ? { startsAtMs, placeIds: [...new Set(placeIds)].sort() }
    : null;
}

export function expireMovingServiceStates(
  places: Place[],
  nowMs = Date.now(),
  eligiblePlaceIds?: ReadonlySet<string>,
): Place[] {
  let changed = false;
  const next = places.map((place) => {
    if (!place.mobility || (eligiblePlaceIds && !eligiblePlaceIds.has(place.id))) return place;
    const startsAtMs = Date.parse(place.mobility.nextStop.startsAt);
    if (!Number.isFinite(startsAtMs) || startsAtMs > nowMs) return place;
    changed = true;
    return { ...place, mobility: undefined };
  });
  return changed ? next : places;
}
