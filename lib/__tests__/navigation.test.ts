import {
  formatRouteDistance,
  formatRouteDuration,
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
  it('formats compact route guidance values', () => {
    expect(formatRouteDistance(1_550)).toBe('1.0 mi');
    expect(formatRouteDuration(3_900)).toBe('1 hr 5 min');
  });
  it('selects the nearest maneuver for live guidance', () => {
    const route = parseRoutePlan(valid, 'walk', now);
    expect(route && nearestRouteStep(route, { latitude: 34.041, longitude: -118.231 })?.instruction)
      .toBe('Turn right on Spring Street');
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
