import { assert, assertEquals, assertMatch, assertThrows } from 'jsr:@std/assert@1';

import { haversineMeters, validateRouteRequest } from '../functions/route-plan/contract.ts';

const index = await Deno.readTextFile(new URL('../functions/route-plan/index.ts', import.meta.url));
const migration = await Deno.readTextFile(new URL('../migrations/20260819000000_route_plan_quota.sql', import.meta.url));
const config = await Deno.readTextFile(new URL('../config.toml', import.meta.url));
const navigationScreen = await Deno.readTextFile(new URL('../../app/navigation/[id].tsx', import.meta.url));
const clientEnvironment = await Deno.readTextFile(new URL('../../.env.example', import.meta.url));

Deno.test('route requests are bounded to explicit supported modes and nearby coordinates', () => {
  const request = validateRouteRequest({
    origin: { latitude: 34.0522, longitude: -118.2437 },
    destination: { latitude: 34.0355, longitude: -118.2324 },
    mode: 'walk',
  });
  assertEquals(request.mode, 'walk');
  assert(haversineMeters(request.origin, request.destination) > 1_000);
  assertThrows(() => validateRouteRequest({ ...request, mode: 'motorcycle' }));
  assertThrows(() => validateRouteRequest({ ...request, extra: true }));
  assertThrows(() => validateRouteRequest({ ...request, destination: { latitude: 0, longitude: 0 } }));
});

Deno.test('routing token stays server-side and requests are authenticated and rate limited', () => {
  assertMatch(index, /MAPBOX_DIRECTIONS_TOKEN/);
  assertMatch(index, /authenticatedUser\(request\)/);
  assertMatch(index, /consume_route_plan_quota/);
  assertMatch(index, /SPOTTR_ROUTING_ENABLED/);
  assert(!index.includes('EXPO_PUBLIC_MAPBOX'));
  assertMatch(migration, /private\.consume_rate_limit\(actor, 'route_plan', 30, 900\)/);
  assertMatch(migration, /grant execute on function public\.consume_route_plan_quota\(\) to authenticated/);
  assertMatch(config, /\[functions\.route-plan\][\s\S]*verify_jwt = true/);
  assertMatch(clientEnvironment, /EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED=false/);
  assertMatch(navigationScreen, /requestForegroundPermissionsAsync/);
  assert(!navigationScreen.includes('requestBackgroundPermissionsAsync'));
  assert(!navigationScreen.includes('startLocationUpdatesAsync'));
  assertMatch(navigationScreen, /sends your selected starting point and this public destination to Mapbox/);
});
