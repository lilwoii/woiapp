export const ROUTE_PLAN_MAX_BYTES = 2048;
export const ROUTE_PLAN_MAX_DISTANCE_METERS = 250_000;
export const routeModes = ['drive', 'walk', 'bike'] as const;
export type RouteMode = typeof routeModes[number];

export class RouteContractError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Coordinate = { latitude: number; longitude: number };

function coordinate(value: unknown): Coordinate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteContractError('INVALID_COORDINATE');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.latitude !== 'number' || !Number.isFinite(candidate.latitude) ||
    candidate.latitude < -85.05112878 || candidate.latitude > 85.05112878 ||
    typeof candidate.longitude !== 'number' || !Number.isFinite(candidate.longitude) ||
    candidate.longitude < -180 || candidate.longitude > 180
  ) {
    throw new RouteContractError('INVALID_COORDINATE');
  }
  return {
    latitude: Math.round(candidate.latitude * 1_000_000) / 1_000_000,
    longitude: Math.round(candidate.longitude * 1_000_000) / 1_000_000,
  };
}

export function haversineMeters(left: Coordinate, right: Coordinate): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function validateRouteRequest(value: unknown): {
  origin: Coordinate;
  destination: Coordinate;
  mode: RouteMode;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteContractError('INVALID_ROUTE_REQUEST');
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join(',');
  if (keys !== 'destination,mode,origin') throw new RouteContractError('INVALID_ROUTE_REQUEST');
  const origin = coordinate(candidate.origin);
  const destination = coordinate(candidate.destination);
  if (!routeModes.includes(candidate.mode as RouteMode)) {
    throw new RouteContractError('INVALID_TRAVEL_MODE');
  }
  const distance = haversineMeters(origin, destination);
  if (distance < 10 || distance > ROUTE_PLAN_MAX_DISTANCE_METERS) {
    throw new RouteContractError('ROUTE_DISTANCE_UNAVAILABLE');
  }
  return { origin, destination, mode: candidate.mode as RouteMode };
}
