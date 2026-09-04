import { normalizeLongitude } from '@/lib/map-clustering';

export type MapCameraCoordinate = {
  latitude: number;
  longitude: number;
};

export type MapCameraRegion = MapCameraCoordinate & {
  latitudeDelta: number;
  longitudeDelta: number;
};

export type MapCameraBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

const MIN_DELTA = 0.08;
const MAX_LATITUDE = 85.05112878;

export function regionForMapCoordinates(
  coordinates: MapCameraCoordinate[],
  fallback: MapCameraRegion,
): MapCameraRegion {
  const valid = coordinates.filter(
    (coordinate) => Number.isFinite(coordinate.latitude)
      && Number.isFinite(coordinate.longitude)
      && Math.abs(coordinate.latitude) <= MAX_LATITUDE,
  );
  if (!valid.length) return fallback;

  const latitudes = valid.map((coordinate) => coordinate.latitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const longitudeRing = valid
    .map((coordinate) => (normalizeLongitude(coordinate.longitude) + 360) % 360)
    .sort((left, right) => left - right);

  let largestGap = -1;
  let arcStart = longitudeRing[0];
  for (let index = 0; index < longitudeRing.length; index += 1) {
    const current = longitudeRing[index];
    const next = index === longitudeRing.length - 1
      ? longitudeRing[0] + 360
      : longitudeRing[index + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      arcStart = next % 360;
    }
  }

  const longitudeSpan = longitudeRing.length === 1 ? 0 : 360 - largestGap;
  const centerLongitude = normalizeLongitude(arcStart + longitudeSpan / 2);
  return {
    latitude: (minLatitude + maxLatitude) / 2,
    longitude: centerLongitude,
    latitudeDelta: Math.min(170, Math.max(MIN_DELTA, (maxLatitude - minLatitude) * 1.35)),
    longitudeDelta: Math.min(359, Math.max(MIN_DELTA, longitudeSpan * 1.35)),
  };
}

export function boundsForMapCoordinates(
  coordinates: MapCameraCoordinate[],
  fallback: MapCameraRegion,
): MapCameraBounds {
  const region = regionForMapCoordinates(coordinates, fallback);
  return {
    west: region.longitude - region.longitudeDelta / 2,
    south: Math.max(-MAX_LATITUDE, region.latitude - region.latitudeDelta / 2),
    east: region.longitude + region.longitudeDelta / 2,
    north: Math.min(MAX_LATITUDE, region.latitude + region.latitudeDelta / 2),
  };
}
