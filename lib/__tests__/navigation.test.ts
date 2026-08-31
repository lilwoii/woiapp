import {
  advanceRouteProgress,
  advanceRouteStepIndex,
  createRouteLiveProgress,
  externalDirectionsProviderUrl,
  externalDirectionsUrl,
  formatRouteArrivalTime,
  formatRouteDistance,
  formatRouteDuration,
  inferTravelMode,
  nearestRouteStep,
  parseRoutePlan,
  ROUTE_PROJECTION_MAX_INSPECTED_SEGMENTS,
  ROUTE_RECOVERY_MAX_INSPECTED_SEGMENTS,
  routeProgressMetrics,
  shouldRequestAutomaticReroute,
} from '../navigation';

const now = Date.parse('2026-08-11T18:00:00.000Z');
const valid = {
  provider: 'mapbox', mode: 'walk', distanceMeters: 1_550, durationSeconds: 840,
  coordinates: [{ latitude: 34.05, longitude: -118.24 }, { latitude: 34.04, longitude: -118.23 }],
  steps: [{ instruction: 'Turn right on Spring Street', distanceMeters: 100, durationSeconds: 60, maneuver: { latitude: 34.04, longitude: -118.23 } }],
  attribution: '© Mapbox', attributionUrl: 'https://www.mapbox.com/about/maps/',
  generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
};

describe('route plan parsing', () => {
  it('accepts a bounded fresh provider route', () => {
    expect(parseRoutePlan(valid, 'walk', now)).toMatchObject({ mode: 'walk', distanceMeters: 1_550 });
  });
  it('fails closed for expired, mismatched, and out-of-range routes', () => {
    expect(parseRoutePlan({ ...valid, expiresAt: new Date(now).toISOString() }, 'walk', now)).toBeNull();
    expect(parseRoutePlan(valid, 'drive', now)).toBeNull();
    expect(parseRoutePlan({ ...valid, coordinates: [{ latitude: 91, longitude: 0 }, valid.coordinates[1]] }, 'walk', now)).toBeNull();
  });
  it('builds validated HTTPS directions URLs for Apple and Google Maps', () => {
    const destination = { latitude: 34.05, longitude: -118.24 };
    expect(externalDirectionsUrl(destination, 'ios'))
      .toBe('https://maps.apple.com/?daddr=34.05%2C-118.24');
    expect(externalDirectionsUrl(destination, 'android'))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=34.05%2C-118.24');
    expect(externalDirectionsUrl(destination, 'ios', 'walk'))
      .toBe('https://maps.apple.com/?daddr=34.05%2C-118.24&dirflg=w');
    expect(externalDirectionsUrl(destination, 'android', 'drive'))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=34.05%2C-118.24&travelmode=driving');
    expect(externalDirectionsUrl(destination, 'android', 'bike'))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=34.05%2C-118.24&travelmode=bicycling');
    expect(externalDirectionsProviderUrl(destination, 'google', 'walk'))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=34.05%2C-118.24&travelmode=walking');
    expect(externalDirectionsProviderUrl(destination, 'apple', 'drive'))
      .toBe('https://maps.apple.com/?daddr=34.05%2C-118.24&dirflg=d');
    expect(externalDirectionsUrl({ latitude: 91, longitude: 0 }, 'ios')).toBeNull();
  });
  it('formats compact route guidance values', () => {
    expect(formatRouteDistance(1_550)).toBe('1.0 mi');
    expect(formatRouteDuration(3_900)).toBe('1 hr 5 min');
    const route = parseRoutePlan(valid, 'walk', now);
    expect(route && formatRouteArrivalTime(route, 'en-US')).toMatch(/\d/);
    expect(route && formatRouteArrivalTime(route, 'en-US', 60, now)).toMatch(/\d/);
  });
  it('detects walking or driving conservatively on-device', () => {
    expect(inferTravelMode({ speedMetersPerSecond: 0.8, horizontalAccuracyMeters: 12, distanceMeters: 8_000 }))
      .toBe('walk');
    expect(inferTravelMode({ speedMetersPerSecond: 12, horizontalAccuracyMeters: 18, distanceMeters: 500 }))
      .toBe('drive');
    expect(inferTravelMode({ speedMetersPerSecond: -1, horizontalAccuracyMeters: 12, distanceMeters: 1_000 }))
      .toBe('walk');
    expect(inferTravelMode({ speedMetersPerSecond: 0, horizontalAccuracyMeters: 8, distanceMeters: 9_000 }))
      .toBe('drive');
    expect(inferTravelMode({ speedMetersPerSecond: 0, horizontalAccuracyMeters: 8, distanceMeters: 1_200 }))
      .toBe('walk');
    expect(inferTravelMode({ speedMetersPerSecond: 9, horizontalAccuracyMeters: 250, distanceMeters: 5_000 }))
      .toBe('drive');
  });
  it('selects the nearest maneuver for live guidance', () => {
    const route = parseRoutePlan(valid, 'walk', now);
    expect(route && nearestRouteStep(route, { latitude: 34.041, longitude: -118.231 })?.instruction)
      .toBe('Turn right on Spring Street');
  });
  it('advances guidance one step at a time and never jumps backward', () => {
    const route = parseRoutePlan({
      ...valid,
      coordinates: [
        { latitude: 34.05, longitude: -118.24 },
        { latitude: 34.049, longitude: -118.239 },
        { latitude: 34.048, longitude: -118.238 },
        { latitude: 34.047, longitude: -118.237 },
      ],
      steps: [
        { ...valid.steps[0], instruction: 'First turn', maneuver: { latitude: 34.05, longitude: -118.24 } },
        { ...valid.steps[0], instruction: 'Second turn', maneuver: { latitude: 34.049, longitude: -118.239 } },
        { ...valid.steps[0], instruction: 'Third turn', maneuver: { latitude: 34.048, longitude: -118.238 } },
      ],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;
    expect(advanceRouteStepIndex(route, { latitude: 34.05, longitude: -118.24 }, 0)).toBe(0);
    expect(advanceRouteStepIndex(route, { latitude: 34.049, longitude: -118.239 }, 0)).toBe(1);
    expect(advanceRouteStepIndex(route, { latitude: 34.0475, longitude: -118.2375 }, 0)).toBe(2);
    expect(advanceRouteStepIndex(route, { latitude: 35, longitude: -117 }, 0)).toBe(0);
    expect(advanceRouteStepIndex(route, { latitude: 34.05, longitude: -118.24 }, 2)).toBe(2);
  });
  it('does not skip a folded-route maneuver just because its endpoints are close', () => {
    const route = parseRoutePlan({
      ...valid,
      coordinates: [
        { latitude: 34, longitude: -118 },
        { latitude: 34.0002, longitude: -118 },
        { latitude: 34.0002, longitude: -117.9998 },
        { latitude: 34, longitude: -117.9998 },
        { latitude: 33.9995, longitude: -117.9998 },
      ],
      steps: [
        { ...valid.steps[0], instruction: 'Enter the roundabout', maneuver: { latitude: 34, longitude: -118 } },
        { ...valid.steps[0], instruction: 'Exit the roundabout', maneuver: { latitude: 34, longitude: -117.9998 } },
      ],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;
    expect(advanceRouteStepIndex(route, route.coordinates[0], 0)).toBe(0);
    expect(advanceRouteStepIndex(route, route.coordinates[3], 0)).toBe(1);
  });
  it('does not snap from an earlier leg to a later leg where a route crosses itself', () => {
    const route = parseRoutePlan({
      ...valid,
      distanceMeters: 850,
      durationSeconds: 510,
      coordinates: [
        { latitude: 33.999, longitude: -118.001 },
        { latitude: 34.001, longitude: -117.999 },
        { latitude: 34.001, longitude: -118.001 },
        { latitude: 33.999, longitude: -117.999 },
      ],
      steps: [
        { ...valid.steps[0], distanceMeters: 425, durationSeconds: 255, maneuver: { latitude: 33.999, longitude: -118.001 } },
        { ...valid.steps[0], instruction: 'Take the later crossing', distanceMeters: 425, durationSeconds: 255, maneuver: { latitude: 34.001, longitude: -118.001 } },
      ],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;

    const initial = createRouteLiveProgress(route);
    const firstCrossing = advanceRouteProgress(
      route,
      { latitude: 34, longitude: -118 },
      initial,
    );
    expect(firstCrossing.matched).toBe(true);
    expect(firstCrossing.stepIndex).toBe(0);
    expect(firstCrossing.progressMeters).toBeLessThan(300);

    const laterLeg = advanceRouteProgress(route, route.coordinates[2], firstCrossing);
    const secondCrossing = advanceRouteProgress(
      route,
      { latitude: 34, longitude: -118 },
      laterLeg,
    );
    expect(secondCrossing.stepIndex).toBe(1);
    expect(secondCrossing.progressMeters).toBeGreaterThan(laterLeg.progressMeters);
  });
  it('bounds each live projection even for the maximum accepted geometry', () => {
    const coordinates = Array.from({ length: 20_000 }, (_, index) => ({
      latitude: 34,
      longitude: -118 + index * 0.00001,
    }));
    const route = parseRoutePlan({
      ...valid,
      distanceMeters: 2_000,
      durationSeconds: 1_200,
      coordinates,
      steps: [
        { ...valid.steps[0], distanceMeters: 1_000, durationSeconds: 600, maneuver: coordinates[0] },
        { ...valid.steps[0], instruction: 'Continue east', distanceMeters: 1_000, durationSeconds: 600, maneuver: coordinates[10_000] },
      ],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;

    const first = advanceRouteProgress(route, coordinates[400], createRouteLiveProgress(route));
    expect(first.inspectedSegmentCount).toBeLessThanOrEqual(ROUTE_PROJECTION_MAX_INSPECTED_SEGMENTS);
    expect(first.matched).toBe(true);
    const distantFix = advanceRouteProgress(route, coordinates[10_000], first);
    expect(distantFix.inspectedSegmentCount).toBeLessThanOrEqual(ROUTE_PROJECTION_MAX_INSPECTED_SEGMENTS);
    expect(distantFix.matched).toBe(false);
    expect(distantFix.progressMeters).toBe(first.progressMeters);

    const gapWithoutRecovery = advanceRouteProgress(
      route,
      coordinates[800],
      createRouteLiveProgress(route),
    );
    expect(gapWithoutRecovery.matched).toBe(false);
    const recoveredGap = advanceRouteProgress(
      route,
      coordinates[800],
      createRouteLiveProgress(route),
      { allowBoundedRecovery: true },
    );
    expect(recoveredGap.matched).toBe(true);
    expect(recoveredGap.recovered).toBe(true);
    expect(recoveredGap.inspectedSegmentCount)
      .toBeLessThanOrEqual(ROUTE_RECOVERY_MAX_INSPECTED_SEGMENTS);
  });
  it('refuses bounded recovery when later route legs are spatially ambiguous', () => {
    const approach = Array.from({ length: 514 }, (_, index) => ({
      latitude: 34 + index * 0.00000001,
      longitude: -118.01,
    }));
    const coordinates = [
      ...approach,
      { latitude: 33.999, longitude: -118.001 },
      { latitude: 34.001, longitude: -117.999 },
      { latitude: 34.001, longitude: -118.001 },
      { latitude: 33.999, longitude: -117.999 },
    ];
    const route = parseRoutePlan({
      ...valid,
      distanceMeters: 2_000,
      durationSeconds: 1_200,
      coordinates,
      steps: [
        { ...valid.steps[0], distanceMeters: 1_000, durationSeconds: 600, maneuver: coordinates[0] },
        { ...valid.steps[0], instruction: 'Later crossing', distanceMeters: 1_000, durationSeconds: 600, maneuver: coordinates[514] },
      ],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;

    const result = advanceRouteProgress(
      route,
      { latitude: 34, longitude: -118 },
      createRouteLiveProgress(route),
      { allowBoundedRecovery: true },
    );
    expect(result.matched).toBe(false);
    expect(result.recovered).toBe(false);
    expect(result.inspectedSegmentCount)
      .toBeLessThanOrEqual(ROUTE_RECOVERY_MAX_INSPECTED_SEGMENTS);
  });
  it('reports conservative remaining route metrics from current progress', () => {
    const route = parseRoutePlan({
      ...valid,
      distanceMeters: 300,
      durationSeconds: 180,
      coordinates: [
        { latitude: 34.05, longitude: -118.24 },
        { latitude: 34.048, longitude: -118.238 },
      ],
      steps: [
        {
          ...valid.steps[0],
          distanceMeters: 100,
          durationSeconds: 60,
          maneuver: { latitude: 34.05, longitude: -118.24 },
        },
        {
          ...valid.steps[0],
          instruction: 'Continue',
          distanceMeters: 200,
          durationSeconds: 120,
          maneuver: { latitude: 34.049, longitude: -118.239 },
        },
      ],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;
    expect(routeProgressMetrics(route, 0, route.coordinates[0])).toEqual({
      distanceMeters: 300,
      durationSeconds: 180,
    });
    expect(routeProgressMetrics(route, 1, null)).toEqual({
      distanceMeters: 200,
      durationSeconds: 120,
    });
    expect(routeProgressMetrics(route, 1, route.coordinates[1])).toEqual({
      distanceMeters: 0,
      durationSeconds: 0,
    });
  });
  it('uses route geometry instead of a straight-line chord on curved steps', () => {
    const route = parseRoutePlan({
      ...valid,
      distanceMeters: 300,
      durationSeconds: 180,
      coordinates: [
        { latitude: 34, longitude: -118 },
        { latitude: 34.001, longitude: -118 },
        { latitude: 34.001, longitude: -117.999 },
        { latitude: 34, longitude: -117.999 },
      ],
      steps: [{
        ...valid.steps[0],
        distanceMeters: 300,
        durationSeconds: 180,
        maneuver: { latitude: 34, longitude: -118 },
      }],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;
    const progress = routeProgressMetrics(route, 0, route.coordinates[2]);
    expect(progress.distanceMeters).toBeGreaterThan(90);
    expect(progress.distanceMeters).toBeLessThan(120);
    expect(progress.durationSeconds).toBeGreaterThan(54);
    expect(progress.durationSeconds).toBeLessThan(72);
  });
  it('never shares a refreshed origin unless automatic rerouting is explicitly enabled', () => {
    const request = {
      previousOrigin: { latitude: 34.0522, longitude: -118.2437 },
      currentOrigin: { latitude: 34.0508, longitude: -118.2437 },
      lastRequestAt: now - 120_000,
      now,
    };
    expect(shouldRequestAutomaticReroute({ ...request, enabled: false })).toBe(false);
    expect(shouldRequestAutomaticReroute({ ...request, enabled: true })).toBe(true);
    expect(shouldRequestAutomaticReroute({ ...request, enabled: true, lastRequestAt: now - 60_000 })).toBe(false);
    expect(shouldRequestAutomaticReroute({
      ...request,
      enabled: true,
      currentOrigin: { latitude: 34.0516, longitude: -118.2437 },
    })).toBe(false);
  });
});
