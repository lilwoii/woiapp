import {
  boundsForMapCoordinates,
  regionForMapCoordinates,
  type MapCameraRegion,
} from '@/lib/map-camera';

const fallback: MapCameraRegion = {
  latitude: 0,
  longitude: 0,
  latitudeDelta: 1,
  longitudeDelta: 1,
};

describe('regionForMapCoordinates', () => {
  it('centers a local result set instead of a fixed city fallback', () => {
    const region = regionForMapCoordinates([
      { latitude: 35.6762, longitude: 139.6503 },
      { latitude: 35.6895, longitude: 139.6917 },
    ], fallback);

    expect(region.latitude).toBeCloseTo(35.68285, 4);
    expect(region.longitude).toBeCloseTo(139.671, 3);
    expect(region.latitudeDelta).toBeGreaterThanOrEqual(0.08);
  });

  it('uses the short arc when results straddle the antimeridian', () => {
    const region = regionForMapCoordinates([
      { latitude: -17.7, longitude: 179.7 },
      { latitude: -17.8, longitude: -179.8 },
    ], fallback);

    expect(Math.abs(region.longitude)).toBeGreaterThan(179);
    expect(region.longitudeDelta).toBeLessThan(1);
    expect(region.longitude + region.longitudeDelta / 2).toBeGreaterThan(180);
  });

  it('falls back when no safe coordinates exist', () => {
    expect(regionForMapCoordinates([
      { latitude: Number.NaN, longitude: 20 },
      { latitude: 90, longitude: 20 },
    ], fallback)).toEqual(fallback);
  });

  it('keeps fit bounds inside the web map latitude limits', () => {
    const bounds = boundsForMapCoordinates([
      { latitude: 0, longitude: 10 },
      { latitude: 85, longitude: 20 },
    ], fallback);

    expect(bounds.north).toBeLessThanOrEqual(85.05112878);
    expect(bounds.south).toBeGreaterThanOrEqual(-85.05112878);
  });
});
