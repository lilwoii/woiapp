import { toActionError } from '@/lib/errors';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { ActionResult } from '@/types/marketplace';
import type { NavigationCoordinate, RoutePlan, RouteStep, TravelMode } from '@/types/navigation';

const routeModes: TravelMode[] = ['drive', 'walk', 'bike'];
const ROUTE_REQUEST_TIMEOUT_MS = 12_000;
export type ExternalMapProvider = 'apple' | 'google';

const ROUTE_PROJECTION_MAX_FORWARD_SEGMENTS = 512;
const ROUTE_PROJECTION_BACKTRACK_SEGMENTS = 2;
const ROUTE_PROJECTION_MAX_FORWARD_METERS = 2_000;
const ROUTE_RECOVERY_MAX_FORWARD_SEGMENTS = 512;
const ROUTE_RECOVERY_MAX_FORWARD_METERS = 10_000;
const ROUTE_PROJECTION_AMBIGUITY_METERS = 12;
const ROUTE_PROJECTION_AMBIGUITY_PROGRESS_METERS = 50;
const ROUTE_MATCH_MAX_DISTANCE_METERS = 120;
const ROUTE_STEP_REACHED_TOLERANCE_METERS = 15;

export const ROUTE_PROJECTION_MAX_INSPECTED_SEGMENTS =
  ROUTE_PROJECTION_MAX_FORWARD_SEGMENTS + ROUTE_PROJECTION_BACKTRACK_SEGMENTS + 1;
export const ROUTE_RECOVERY_MAX_INSPECTED_SEGMENTS =
  ROUTE_PROJECTION_MAX_INSPECTED_SEGMENTS + ROUTE_RECOVERY_MAX_FORWARD_SEGMENTS;

export type RouteLiveProgress = {
  distanceFromRouteMeters: number | null;
  inspectedSegmentCount: number;
  matched: boolean;
  progressMeters: number;
  recovered: boolean;
  segmentIndex: number;
  stepIndex: number;
};

type RouteGeometryIndex = {
  cumulativeMeters: number[];
  maneuverProgressMeters: number[];
  segmentMeters: number[];
  stepEndProgressMeters: number[];
  suffixDistanceMeters: number[];
  suffixDurationSeconds: number[];
  totalMeters: number;
};

const routeGeometryIndexes = new WeakMap<RoutePlan, RouteGeometryIndex>();

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

export function formatRouteArrivalTime(
  route: RoutePlan,
  locales?: string | string[],
  remainingDurationSeconds = route.durationSeconds,
  fromTime = Date.parse(route.generatedAt),
): string {
  const safeFromTime = Number.isFinite(fromTime) ? fromTime : Date.parse(route.generatedAt);
  const safeRemainingDuration = Number.isFinite(remainingDurationSeconds)
    ? Math.max(0, remainingDurationSeconds)
    : route.durationSeconds;
  const arrivalAt = safeFromTime + safeRemainingDuration * 1_000;
  return new Intl.DateTimeFormat(locales, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(arrivalAt));
}

export function routeProgressMetrics(
  route: RoutePlan,
  currentStepIndex: number,
  current: NavigationCoordinate | null,
  liveProgress?: RouteLiveProgress | null,
): { distanceMeters: number; durationSeconds: number } {
  const destination = route.coordinates.at(-1);
  if (!route.steps.length) {
    if (current && destination && navigationDistanceMeters(current, destination) <= 35) {
      return { distanceMeters: 0, durationSeconds: 0 };
    }
    return { distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds };
  }

  const geometry = routeGeometryIndex(route);
  const suppliedIndex = liveProgress?.stepIndex ?? currentStepIndex;
  const index = Math.min(route.steps.length - 1, Math.max(0, Math.trunc(suppliedIndex)));
  const currentStep = route.steps[index];
  const stepStartProgress = geometry.maneuverProgressMeters[index] ?? 0;
  const stepEndProgress = geometry.stepEndProgressMeters[index] ?? geometry.totalMeters;
  const stepGeometryMeters = Math.max(0, stepEndProgress - stepStartProgress);
  const progress = liveProgress ?? (
    current
      ? advanceRouteProgress(route, current, createRouteLiveProgress(route, index))
      : null
  );
  if (
    current &&
    destination &&
    progress?.matched &&
    geometry.totalMeters - progress.progressMeters <= 35 &&
    navigationDistanceMeters(current, destination) <= 35
  ) return { distanceMeters: 0, durationSeconds: 0 };
  // Provider maneuver coordinates describe the start of each step. Project the
  // foreground location onto the actual route geometry so curves and U-turns
  // do not collapse into a misleading straight-line ETA. An off-route sample
  // stays conservative until a refreshed provider route is available.
  const currentStepRatio = progress?.matched && stepGeometryMeters > 1
    ? Math.max(0, Math.min(
      1,
      (stepEndProgress - Math.max(stepStartProgress, progress.progressMeters)) /
        stepGeometryMeters,
    ))
    : 1;
  const distanceMeters = currentStep.distanceMeters * currentStepRatio +
    (geometry.suffixDistanceMeters[index + 1] ?? 0);
  const durationSeconds = currentStep.durationSeconds * currentStepRatio +
    (geometry.suffixDurationSeconds[index + 1] ?? 0);
  return {
    distanceMeters: Math.min(route.distanceMeters, distanceMeters),
    durationSeconds: Math.min(route.durationSeconds, durationSeconds),
  };
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

function normalizedLongitudeDelta(from: number, to: number) {
  return ((((to - from + 180) % 360) + 360) % 360) - 180;
}

function routeGeometryIndex(route: RoutePlan): RouteGeometryIndex {
  const cached = routeGeometryIndexes.get(route);
  if (cached) return cached;

  const segmentMeters: number[] = [];
  const cumulativeMeters = [0];
  for (let index = 0; index < route.coordinates.length - 1; index += 1) {
    const length = navigationDistanceMeters(route.coordinates[index], route.coordinates[index + 1]);
    segmentMeters.push(length);
    cumulativeMeters.push(cumulativeMeters[index] + length);
  }

  const totalMeters = cumulativeMeters.at(-1) ?? 0;
  const suffixDistanceMeters = new Array<number>(route.steps.length + 1).fill(0);
  const suffixDurationSeconds = new Array<number>(route.steps.length + 1).fill(0);
  for (let index = route.steps.length - 1; index >= 0; index -= 1) {
    suffixDistanceMeters[index] = suffixDistanceMeters[index + 1] + route.steps[index].distanceMeters;
    suffixDurationSeconds[index] = suffixDurationSeconds[index + 1] + route.steps[index].durationSeconds;
  }

  const maneuverProgressMeters: number[] = [];
  const stepEndProgressMeters: number[] = [];
  const totalStepDistance = suffixDistanceMeters[0];
  let traversedStepDistance = 0;
  for (let index = 0; index < route.steps.length; index += 1) {
    const startRatio = totalStepDistance > 0
      ? traversedStepDistance / totalStepDistance
      : index / Math.max(1, route.steps.length);
    maneuverProgressMeters.push(totalMeters * Math.max(0, Math.min(1, startRatio)));
    traversedStepDistance += route.steps[index].distanceMeters;
    const endRatio = totalStepDistance > 0
      ? traversedStepDistance / totalStepDistance
      : (index + 1) / Math.max(1, route.steps.length);
    stepEndProgressMeters.push(
      index === route.steps.length - 1
        ? totalMeters
        : totalMeters * Math.max(0, Math.min(1, endRatio)),
    );
  }

  const prepared = {
    cumulativeMeters,
    maneuverProgressMeters,
    segmentMeters,
    stepEndProgressMeters,
    suffixDistanceMeters,
    suffixDurationSeconds,
    totalMeters,
  };
  routeGeometryIndexes.set(route, prepared);
  return prepared;
}

function segmentIndexAtProgress(geometry: RouteGeometryIndex, progressMeters: number): number {
  if (!geometry.segmentMeters.length) return 0;
  const target = Math.max(0, Math.min(geometry.totalMeters, progressMeters));
  let low = 0;
  let high = geometry.segmentMeters.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (geometry.cumulativeMeters[middle + 1] + 0.001 < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

type RouteProjection = {
  ambiguous: boolean;
  distanceMeters: number;
  inspectedSegmentCount: number;
  progressMeters: number;
  segmentIndex: number;
};

function projectOntoRouteWindow(
  route: RoutePlan,
  point: NavigationCoordinate,
  previous: RouteLiveProgress,
  recovery = false,
): RouteProjection | null {
  const geometry = routeGeometryIndex(route);
  if (!geometry.segmentMeters.length) return null;
  const previousProgress = Math.max(0, Math.min(geometry.totalMeters, previous.progressMeters));
  const localMaximumProgress = Math.min(
    geometry.totalMeters,
    previousProgress + ROUTE_PROJECTION_MAX_FORWARD_METERS,
  );
  const anchorSegment = segmentIndexAtProgress(geometry, previousProgress);
  const localFinalSegment = Math.min(
    geometry.segmentMeters.length - 1,
    segmentIndexAtProgress(geometry, localMaximumProgress) + 1,
    anchorSegment + ROUTE_PROJECTION_MAX_FORWARD_SEGMENTS,
  );
  const firstSegment = recovery
    ? localFinalSegment + 1
    : Math.max(0, anchorSegment - ROUTE_PROJECTION_BACKTRACK_SEGMENTS);
  if (firstSegment >= geometry.segmentMeters.length) return null;
  const minimumProgress = recovery
    ? Math.max(previousProgress, geometry.cumulativeMeters[firstSegment])
    : previousProgress;
  const maximumProgress = recovery
    ? Math.min(geometry.totalMeters, previousProgress + ROUTE_RECOVERY_MAX_FORWARD_METERS)
    : localMaximumProgress;
  const finalSegment = recovery
    ? Math.min(
        geometry.segmentMeters.length - 1,
        segmentIndexAtProgress(geometry, maximumProgress) + 1,
        firstSegment + ROUTE_RECOVERY_MAX_FORWARD_SEGMENTS - 1,
      )
    : localFinalSegment;
  const candidates: Pick<RouteProjection, 'distanceMeters' | 'progressMeters' | 'segmentIndex'>[] = [];
  let inspectedSegmentCount = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = firstSegment; index <= finalSegment; index += 1) {
    inspectedSegmentCount += 1;
    const segmentMeters = geometry.segmentMeters[index];
    if (segmentMeters <= 0) continue;
    const segmentStartProgress = geometry.cumulativeMeters[index];
    const segmentEndProgress = geometry.cumulativeMeters[index + 1];
    if (segmentEndProgress + 0.001 < minimumProgress) continue;
    if (segmentStartProgress - 0.001 > maximumProgress) break;

    const start = route.coordinates[index];
    const end = route.coordinates[index + 1];
    const referenceLatitude = ((start.latitude + end.latitude + point.latitude) / 3) * Math.PI / 180;
    const longitudeScale = Math.max(0.01, Math.cos(referenceLatitude));
    const longitudeDelta = normalizedLongitudeDelta(start.longitude, end.longitude);
    const segmentX = longitudeDelta * longitudeScale;
    const segmentY = end.latitude - start.latitude;
    const pointX = normalizedLongitudeDelta(start.longitude, point.longitude) * longitudeScale;
    const pointY = point.latitude - start.latitude;
    const squaredLength = segmentX ** 2 + segmentY ** 2;
    if (squaredLength <= 0) continue;

    const minimumT = Math.max(0, Math.min(1, (minimumProgress - segmentStartProgress) / segmentMeters));
    const maximumT = Math.max(0, Math.min(1, (maximumProgress - segmentStartProgress) / segmentMeters));
    if (maximumT + 0.000001 < minimumT) continue;
    const rawT = (pointX * segmentX + pointY * segmentY) / squaredLength;
    const t = Math.max(minimumT, Math.min(maximumT, rawT));
    const projected: NavigationCoordinate = {
      latitude: start.latitude + (end.latitude - start.latitude) * t,
      longitude: start.longitude + longitudeDelta * t,
    };
    const distanceMeters = navigationDistanceMeters(point, projected);
    nearestDistance = Math.min(nearestDistance, distanceMeters);
    candidates.push({
      distanceMeters,
      progressMeters: segmentStartProgress + segmentMeters * t,
      segmentIndex: index,
    });
  }

  if (!candidates.length || !Number.isFinite(nearestDistance)) return null;
  // At an overpass, roundabout, or folded route, several route legs can be
  // spatially indistinguishable. Prefer the earliest plausible forward match;
  // later legs become eligible after the earlier leg is no longer nearby.
  const plausibleDistance = nearestDistance + ROUTE_PROJECTION_AMBIGUITY_METERS;
  const plausibleCandidates = candidates
    .filter((candidate) => candidate.distanceMeters <= plausibleDistance);
  const best = plausibleCandidates
    .reduce((earliest, candidate) =>
      !earliest || candidate.progressMeters < earliest.progressMeters ? candidate : earliest,
    null as Pick<RouteProjection, 'distanceMeters' | 'progressMeters' | 'segmentIndex'> | null);
  const plausibleProgress = plausibleCandidates.map((candidate) => candidate.progressMeters);
  const ambiguous = plausibleProgress.length > 1 &&
    Math.max(...plausibleProgress) - Math.min(...plausibleProgress) >
      ROUTE_PROJECTION_AMBIGUITY_PROGRESS_METERS;
  return best ? { ...best, ambiguous, inspectedSegmentCount } : null;
}

export function createRouteLiveProgress(
  route: RoutePlan,
  currentStepIndex = 0,
): RouteLiveProgress {
  const geometry = routeGeometryIndex(route);
  const stepIndex = route.steps.length
    ? Math.min(route.steps.length - 1, Math.max(0, Math.trunc(currentStepIndex)))
    : 0;
  const progressMeters = geometry.maneuverProgressMeters[stepIndex] ?? 0;
  return {
    distanceFromRouteMeters: 0,
    inspectedSegmentCount: 0,
    matched: true,
    progressMeters,
    recovered: false,
    segmentIndex: segmentIndexAtProgress(geometry, progressMeters),
    stepIndex,
  };
}

export function advanceRouteProgress(
  route: RoutePlan,
  current: NavigationCoordinate,
  previous: RouteLiveProgress | null = null,
  options: { allowBoundedRecovery?: boolean } = {},
): RouteLiveProgress {
  const geometry = routeGeometryIndex(route);
  const safePrevious = previous ?? createRouteLiveProgress(route);
  const localProjection = projectOntoRouteWindow(route, current, safePrevious);
  let projection = localProjection;
  let inspectedSegmentCount = localProjection?.inspectedSegmentCount ?? 0;
  let recovered = false;
  if (
    (!localProjection || localProjection.distanceMeters > ROUTE_MATCH_MAX_DISTANCE_METERS) &&
    options.allowBoundedRecovery
  ) {
    const recoveryProjection = projectOntoRouteWindow(route, current, safePrevious, true);
    inspectedSegmentCount += recoveryProjection?.inspectedSegmentCount ?? 0;
    if (
      recoveryProjection &&
      !recoveryProjection.ambiguous &&
      recoveryProjection.distanceMeters <= ROUTE_MATCH_MAX_DISTANCE_METERS
    ) {
      projection = recoveryProjection;
      recovered = true;
    }
  }
  if (!projection || projection.distanceMeters > ROUTE_MATCH_MAX_DISTANCE_METERS) {
    return {
      ...safePrevious,
      distanceFromRouteMeters: projection?.distanceMeters ?? null,
      inspectedSegmentCount,
      matched: false,
      recovered: false,
    };
  }

  const progressMeters = Math.max(
    safePrevious.progressMeters,
    Math.min(geometry.totalMeters, projection.progressMeters),
  );
  let stepIndex = route.steps.length
    ? Math.min(route.steps.length - 1, Math.max(0, safePrevious.stepIndex))
    : 0;
  while (
    stepIndex + 1 < route.steps.length &&
    progressMeters + ROUTE_STEP_REACHED_TOLERANCE_METERS >=
      (geometry.maneuverProgressMeters[stepIndex + 1] ?? Number.POSITIVE_INFINITY)
  ) stepIndex += 1;

  return {
    distanceFromRouteMeters: projection.distanceMeters,
    inspectedSegmentCount,
    matched: true,
    progressMeters,
    recovered,
    segmentIndex: segmentIndexAtProgress(geometry, progressMeters),
    stepIndex,
  };
}
