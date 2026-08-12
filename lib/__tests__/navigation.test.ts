import { formatRouteDistance, formatRouteDuration, nearestRouteStep, parseRoutePlan } from '../navigation';

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
});
