import { seedPlaces } from '@/data/places';
import {
  clusterInventoryFeatures,
  clusterPlaces,
  normalizeLongitude,
  shouldRenderMapInventory,
  viewportIsLiveInventoryEligible,
  zoomFromLongitudeDelta,
} from '@/lib/map-clustering';

describe('map clustering', () => {
  it('groups close listings at city zoom and expands them at street zoom', () => {
    const close = [
      { ...seedPlaces[0], id: 'one', latitude: 34.05, longitude: -118.25 },
      { ...seedPlaces[1], id: 'two', latitude: 34.0501, longitude: -118.2501 },
    ];

    const city = clusterPlaces(close, 10);
    expect(city).toHaveLength(1);
    expect(city[0]).toMatchObject({ kind: 'cluster', count: 2 });

    const street = clusterPlaces(close, 16);
    expect(street).toHaveLength(2);
    expect(street.every((feature) => feature.kind === 'place')).toBe(true);
  });

  it('preserves category counts and handles the antimeridian centroid', () => {
    const places = [
      { ...seedPlaces[0], id: 'east', latitude: 0, longitude: 179.99 },
      { ...seedPlaces[3], id: 'west', latitude: 0, longitude: -179.99 },
    ];
    const feature = clusterPlaces(places, 2, 10_000)[0];
    expect(feature.kind).toBe('cluster');
    if (feature.kind !== 'cluster') return;
    expect(Math.abs(feature.longitude)).toBeGreaterThan(179);
    expect(feature.categories.food_truck).toBe(1);
    expect(feature.categories.restaurant).toBe(1);
  });

  it('derives a bounded zoom from native longitude deltas', () => {
    expect(zoomFromLongitudeDelta(360)).toBe(2);
    expect(zoomFromLongitudeDelta(0.01)).toBeLessThanOrEqual(18);
    expect(zoomFromLongitudeDelta(0)).toBe(2);
  });

  it('normalizes wrapped longitudes for antimeridian viewports', () => {
    expect(normalizeLongitude(181)).toBe(-179);
    expect(normalizeLongitude(-181)).toBe(179);
  });

  it('bounds live inventory requests while supporting antimeridian viewports', () => {
    expect(viewportIsLiveInventoryEligible({ west: 170, south: -2, east: -178, north: 2 })).toBe(true);
    expect(viewportIsLiveInventoryEligible({ west: -20, south: -2, east: 20, north: 2 })).toBe(false);
  });

  it.each([
    { viewportEligible: true, inventorySuppressed: false, expected: true },
    { viewportEligible: true, inventorySuppressed: true, expected: false },
    { viewportEligible: false, inventorySuppressed: false, expected: false },
    { viewportEligible: false, inventorySuppressed: true, expected: false },
  ])(
    'renders markers only for a current eligible viewport: %o',
    ({ expected, ...state }) => {
      expect(shouldRenderMapInventory(state)).toBe(expected);
    }
  );

  it('bounds a 1,200-feature viewport without losing represented places', () => {
    const features = Array.from({ length: 1_200 }, (_, index) => ({
      type: 'place' as const,
      id: `place:${index}`,
      count: 1,
      latitude: 34.02 + (index % 40) * 0.001,
      longitude: -118.28 + Math.floor(index / 40) * 0.001,
      categoryCounts: { food_truck: 1 },
      dominantCategory: 'food_truck' as const,
      businessId: `business:${index}`,
      name: `Truck ${index}`,
    }));

    const rendered = clusterInventoryFeatures(features, 14, 300);
    expect(rendered.length).toBeLessThanOrEqual(300);
    expect(rendered.reduce((count, feature) => count + feature.count, 0)).toBe(1_200);

    const nativeRendered = clusterInventoryFeatures(features, 14, 120);
    expect(nativeRendered.length).toBeLessThanOrEqual(120);
    expect(nativeRendered.reduce((count, feature) => count + feature.count, 0)).toBe(1_200);
  });
});
