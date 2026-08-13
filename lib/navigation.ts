import { toActionError } from '@/lib/errors';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';
import type { NavigationCoordinate, RoutePlan, RouteStep, TravelMode } from '@/types/navigation';

const routeModes: TravelMode[] = ['drive', 'walk', 'bike'];

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

export async function requestRoutePlan(input: {
  origin: NavigationCoordinate;
  destination: NavigationCoordinate;
  mode: TravelMode;
}): Promise<ActionResult<RoutePlan>> {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, code: 'CONFIG_REQUIRED', reason: 'Live navigation is not configured for this build.' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('route-plan', { body: input });
    if (error) return toActionError(error, 'A route could not be created right now.');
    const route = parseRoutePlan(data, input.mode);
    return route ? { ok: true, data: route } : {
      ok: false, code: 'UNKNOWN', reason: 'The routing provider returned an invalid or expired route.',
    };
  } catch (error) {
    return toActionError(error, 'A route could not be created right now.');
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

export function navigationDistanceMeters(left: NavigationCoordinate, right: NavigationCoordinate): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
