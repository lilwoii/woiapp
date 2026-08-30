import {
  advanceRouteStepIndex,
  externalDirectionsProviderUrl,
  externalDirectionsUrl,
  formatRouteArrivalTime,
  formatRouteDistance,
  formatRouteDuration,
  inferTravelMode,
  nearestRouteStep,
  parseRoutePlan,
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
      steps: [
        { ...valid.steps[0], instruction: 'First turn', maneuver: { latitude: 34.05, longitude: -118.24 } },
        { ...valid.steps[0], instruction: 'Second turn', maneuver: { latitude: 34.049, longitude: -118.239 } },
        { ...valid.steps[0], instruction: 'Third turn', maneuver: { latitude: 34.048, longitude: -118.238 } },
      ],
    }, 'walk', now);
    expect(route).not.toBeNull();
    if (!route) return;
    expect(advanceRouteStepIndex(route, { latitude: 34.05, longitude: -118.24 }, 0)).toBe(1);
    expect(advanceRouteStepIndex(route, { latitude: 34.05, longitude: -118.24 }, 2)).toBe(2);
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
