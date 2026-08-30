import { toActionError } from '@/lib/errors';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';
import type { NavigationCoordinate, RoutePlan, RouteStep, TravelMode } from '@/types/navigation';

const routeModes: TravelMode[] = ['drive', 'walk', 'bike'];
const ROUTE_REQUEST_TIMEOUT_MS = 12_000;
export type ExternalMapProvider = 'apple' | 'google';

function coordinate(value: unknown): NavigationCoordinate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.latitude !== 'number' || !Number.isFinite(candidate.latitude) ||
    candidate.latitude < -85.05112878 || candidate.latitude > 85.05112878 ||
    typeof candidate.longitude !== 'number' || !Number.isFinite(candidate.longitude) ||
    candidate.longitude < -180 || candidate.longitude > 180
  ) return null;
  return { latitude: candidate.latitude, longitude: candidate.longitude };
}

function boundedNumber(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

export function parseRoutePlan(value: unknown, expectedMode?: TravelMode, now = Date.now()): RoutePlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const mode = routeModes.includes(candidate.mode as TravelMode) ? candidate.mode as TravelMode : null;
  const distanceMeters = boundedNumber(candidate.distanceMeters, 250_000);
  const durationSeconds = boundedNumber(candidate.durationSeconds, 172_800);
  const generatedAt = typeof candidate.generatedAt === 'string' ? Date.parse(candidate.generatedAt) : NaN;
  const expiresAt = typeof candidate.expiresAt === 'string' ? Date.parse(candidate.expiresAt) : NaN;
  if (
    candidate.provider !== 'mapbox' || !mode || (expectedMode && mode !== expectedMode) ||
    distanceMeters === null || durationSeconds === null || !Number.isFinite(generatedAt) ||
    !Number.isFinite(expiresAt) || generatedAt > now + 60_000 || expiresAt <= now ||
    expiresAt > generatedAt + 6 * 60_000 || candidate.attribution !== '© Mapbox' ||
    candidate.attributionUrl !== 'https://www.mapbox.com/about/maps/' ||
    !Array.isArray(candidate.coordinates) || candidate.coordinates.length < 2 ||
    candidate.coordinates.length > 20_000 || !Array.isArray(candidate.steps) || candidate.steps.length > 300
  ) return null;
  const coordinates = candidate.coordinates.map(coordinate);
  if (coordinates.some((entry) => entry === null)) return null;
  const steps: RouteStep[] = [];
  for (const value of candidate.steps) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const step = value as Record<string, unknown>;
    const maneuver = coordinate(step.maneuver);
    const stepDistance = boundedNumber(step.distanceMeters, 250_000);
    const stepDuration = boundedNumber(step.durationSeconds, 172_800);
    if (
      typeof step.instruction !== 'string' || !step.instruction.trim() || step.instruction.length > 240 ||
      !maneuver || stepDistance === null || stepDuration === null
    ) return null;
    steps.push({ instruction: step.instruction.trim(), distanceMeters: stepDistance, durationSeconds: stepDuration, maneuver });
  }
  return {
    provider: 'mapbox', mode, distanceMeters, durationSeconds,
    coordinates: coordinates as NavigationCoordinate[], steps,
    attribution: '© Mapbox', attributionUrl: 'https://www.mapbox.com/about/maps/',
    generatedAt: new Date(generatedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function externalDirectionsUrl(
  destination: NavigationCoordinate,
  platform: string,
  mode?: TravelMode | null,
): string | null {
  return externalDirectionsProviderUrl(
    destination,
    platform === 'ios' ? 'apple' : 'google',
    mode,
  );
}

export function externalDirectionsProviderUrl(
  destination: NavigationCoordinate,
  provider: ExternalMapProvider,
  mode?: TravelMode | null,
): string | null {
  const validDestination = coordinate(destination);
  if (!validDestination) return null;
  const encodedDestination = encodeURIComponent(
    `${validDestination.latitude},${validDestination.longitude}`,
  );
  if (provider === 'apple') {
    const appleMode = mode === 'drive' ? '&dirflg=d' : mode === 'walk' ? '&dirflg=w' : '';
    return `https://maps.apple.com/?daddr=${encodedDestination}${appleMode}`;
  }
  const googleMode = mode === 'drive' ? 'driving' : mode === 'walk' ? 'walking' : mode === 'bike' ? 'bicycling' : null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodedDestination}${
    googleMode ? `&travelmode=${googleMode}` : ''
  }`;
}

export async function requestRoutePlan(input: {
  origin: NavigationCoordinate;
  destination: NavigationCoordinate;
  mode: TravelMode;
}): Promise<ActionResult<RoutePlan>> {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, code: 'CONFIG_REQUIRED', reason: 'Live navigation is not configured for this build.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTE_REQUEST_TIMEOUT_MS);
  try {
    const { data, error } = await supabase.functions.invoke('route-plan', {
      body: input,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      return { ok: false, code: 'UNKNOWN', reason: 'The routing provider took too long to respond. Try again.' };
    }
    if (error) return toActionError(error, 'A route could not be created right now.');
    const route = parseRoutePlan(data, input.mode);
    return route ? { ok: true, data: route } : {
      ok: false, code: 'UNKNOWN', reason: 'The routing provider returned an invalid or expired route.',
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, code: 'UNKNOWN', reason: 'The routing provider took too long to respond. Try again.' };
    }
    return toActionError(error, 'A route could not be created right now.');
  } finally {
    clearTimeout(timeout);
  }
}

export function formatRouteDistance(meters: number): string {
  if (meters < 1_000) return `${Math.max(1, Math.round(meters))} m`;
  return `${(meters / 1_609.344).toFixed(meters < 16_093 ? 1 : 0)} mi`;
}

export function formatRouteDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
}

export function formatRouteArrivalTime(route: RoutePlan, locales?: string | string[]): string {
  const generatedAt = Date.parse(route.generatedAt);
  const arrivalAt = generatedAt + route.durationSeconds * 1_000;
  return new Intl.DateTimeFormat(locales, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(arrivalAt));
}

export function navigationDistanceMeters(left: NavigationCoordinate, right: NavigationCoordinate): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function inferTravelMode(input: {
  speedMetersPerSecond?: number | null;
  horizontalAccuracyMeters?: number | null;
  distanceMeters: number;
}): Extract<TravelMode, 'drive' | 'walk'> {
  const speed = input.speedMetersPerSecond;
  const accuracy = input.horizontalAccuracyMeters;
  const speedIsUsable = typeof speed === 'number' && Number.isFinite(speed) &&
    speed >= 0 && speed <= 70 &&
    (accuracy === null || accuracy === undefined ||
      (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 65));

  if (speedIsUsable && speed >= 3.6) return 'drive';
  // A near-zero reading is common while someone is still choosing a route in
  // a parked car. Treat it as ambiguous and let trip distance decide instead
  // of confidently labelling every stationary start as walking.
  if (speedIsUsable && speed >= 0.55 && speed <= 2.2) return 'walk';

  const distance = Number.isFinite(input.distanceMeters)
    ? Math.max(0, input.distanceMeters)
    : Number.POSITIVE_INFINITY;
  return distance <= 2_400 ? 'walk' : 'drive';
}

export function shouldRequestAutomaticReroute(input: {
  enabled: boolean;
  previousOrigin: NavigationCoordinate | null;
  currentOrigin: NavigationCoordinate;
  lastRequestAt: number;
  now?: number;
}): boolean {
  if (!input.enabled || !input.previousOrigin) return false;
  const now = input.now ?? Date.now();
  return now - input.lastRequestAt >= 90_000 &&
    navigationDistanceMeters(input.previousOrigin, input.currentOrigin) >= 100;
}

export function nearestRouteStep(route: RoutePlan, current: NavigationCoordinate): RouteStep | null {
  let nearest: RouteStep | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const step of route.steps) {
    const distance = navigationDistanceMeters(current, step.maneuver);
    if (distance < nearestDistance) {
      nearest = step;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function advanceRouteStepIndex(
  route: RoutePlan,
  current: NavigationCoordinate,
  previousIndex: number,
): number {
  if (!route.steps.length) return 0;
  const index = Math.min(route.steps.length - 1, Math.max(0, Math.trunc(previousIndex)));
  const nextIndex = index + 1;
  if (nextIndex >= route.steps.length) return index;
  const currentDistance = navigationDistanceMeters(current, route.steps[index].maneuver);
  const nextDistance = navigationDistanceMeters(current, route.steps[nextIndex].maneuver);
  return currentDistance <= 35 || nextDistance + 25 < currentDistance ? nextIndex : index;
}
