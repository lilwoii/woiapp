import {
  authenticatedUser,
  corsHeaders,
  HttpError,
  jsonResponse,
  optionsResponse,
  publicError,
  readJson,
} from '../_shared/http.ts';
import {
  ROUTE_PLAN_MAX_BYTES,
  RouteContractError,
  type RouteMode,
  validateRouteRequest,
} from './contract.ts';

const providerProfiles: Record<RouteMode, string> = {
  drive: 'mapbox/driving-traffic',
  walk: 'mapbox/walking',
  bike: 'mapbox/cycling',
};

function requiredProviderToken(): string {
  const token = Deno.env.get('MAPBOX_DIRECTIONS_TOKEN')?.trim() ?? '';
  if (!token || token.length < 20) throw new HttpError(503, 'ROUTING_NOT_CONFIGURED');
  return token;
}

function number(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
  }
  return value;
}

function providerCoordinate(value: unknown): { latitude: number; longitude: number } {
  if (
    !Array.isArray(value) || value.length < 2 ||
    typeof value[0] !== 'number' || !Number.isFinite(value[0]) || value[0] < -180 || value[0] > 180 ||
    typeof value[1] !== 'number' || !Number.isFinite(value[1]) || value[1] < -85.05112878 || value[1] > 85.05112878
  ) throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
  return { latitude: value[1], longitude: value[0] };
}

function providerRoute(value: unknown, mode: RouteMode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
  }
  const payload = value as Record<string, unknown>;
  if (payload.code === 'NoRoute' || payload.code === 'NoSegment') {
    throw new HttpError(422, 'ROUTE_NOT_FOUND');
  }
  const route = Array.isArray(payload.routes) ? payload.routes[0] : null;
  if (payload.code !== 'Ok' || !route || typeof route !== 'object' || Array.isArray(route)) {
    throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
  }
  const record = route as Record<string, unknown>;
  const geometry = record.geometry as Record<string, unknown> | null;
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
    throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
  }
  const coordinates = geometry.coordinates.slice(0, 20_000).map(providerCoordinate);
  if (coordinates.length < 2 || geometry.coordinates.length > 20_000) {
    throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
  }

  const firstLeg = Array.isArray(record.legs) ? record.legs[0] : null;
  const rawSteps = firstLeg && typeof firstLeg === 'object' && !Array.isArray(firstLeg)
    ? (firstLeg as Record<string, unknown>).steps
    : [];
  const steps = (Array.isArray(rawSteps) ? rawSteps : []).slice(0, 300).map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
    }
    const item = step as Record<string, unknown>;
    const maneuver = item.maneuver as Record<string, unknown> | null;
    const location = maneuver?.location;
    const instruction = typeof maneuver?.instruction === 'string'
      ? maneuver.instruction.replace(/\s+/g, ' ').trim().slice(0, 240)
      : '';
    if (
      !instruction
    ) throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
    return {
      instruction,
      distanceMeters: number(item.distance, 250_000),
      durationSeconds: number(item.duration, 172_800),
      maneuver: providerCoordinate(location),
    };
  });
  const generatedAt = new Date();
  return {
    provider: 'mapbox' as const,
    mode,
    distanceMeters: number(record.distance, 250_000),
    durationSeconds: number(record.duration, 172_800),
    coordinates,
    steps,
    attribution: '© Mapbox',
    attributionUrl: 'https://www.mapbox.com/about/maps/',
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 5 * 60_000).toISOString(),
  };
}

Deno.serve(async (request) => {
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return optionsResponse(request);
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    if (Deno.env.get('SPOTTR_ROUTING_ENABLED') !== 'true') {
      throw new HttpError(503, 'ROUTING_DISABLED');
    }
    const { client } = await authenticatedUser(request);
    const route = validateRouteRequest(await readJson(request, ROUTE_PLAN_MAX_BYTES));
    const { error: quotaError } = await client.rpc('consume_route_plan_quota');
    if (quotaError) {
      if (quotaError.message?.includes('RATE_LIMITED')) throw new HttpError(429, 'RATE_LIMITED');
      throw new HttpError(503, 'ROUTING_QUOTA_UNAVAILABLE');
    }
    const profile = providerProfiles[route.mode];
    const coordinates = `${route.origin.longitude},${route.origin.latitude};${route.destination.longitude},${route.destination.latitude}`;
    const url = new URL(`https://api.mapbox.com/directions/v5/${profile}/${coordinates}`);
    url.searchParams.set('access_token', requiredProviderToken());
    url.searchParams.set('alternatives', 'false');
    url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('overview', 'simplified');
    url.searchParams.set('steps', 'true');
    url.searchParams.set('language', 'en');
    if (route.mode === 'drive') url.searchParams.set('depart_at', 'now');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new HttpError(503, 'ROUTING_PROVIDER_UNAVAILABLE');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new HttpError(response.status >= 500 ? 503 : 502, 'ROUTING_PROVIDER_UNAVAILABLE');
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > 2_000_000) throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new HttpError(502, 'ROUTING_PROVIDER_INVALID');
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new HttpError(502, 'ROUTING_PROVIDER_INVALID'); }
    return jsonResponse(providerRoute(payload, route.mode), 200, cors);
  } catch (error) {
    if (error instanceof RouteContractError) {
      return publicError(new HttpError(400, error.code), cors);
    }
    return publicError(error, cors);
  }
});
