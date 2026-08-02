import type { BusinessCategory, Place } from '@/types/marketplace';

export type PlaceMapFeature = {
  kind: 'place';
  id: string;
  latitude: number;
  longitude: number;
  place: Place;
};

export type ClusterMapFeature = {
  kind: 'cluster';
  id: string;
  latitude: number;
  longitude: number;
  count: number;
  categories: Partial<Record<BusinessCategory, number>>;
  places: Place[];
};

export type MapFeature = PlaceMapFeature | ClusterMapFeature;

const tileSize = 512;
const maxMercatorLatitude = 85.05112878;

function worldPixel(latitude: number, longitude: number, zoom: number) {
  const scale = tileSize * 2 ** Math.max(0, zoom);
  const clampedLatitude = Math.max(-maxMercatorLatitude, Math.min(maxMercatorLatitude, latitude));
  const sin = Math.sin((clampedLatitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/**
 * Deterministic screen-space clustering shared by native and web maps. The API
 * intentionally accepts only public Place projections, so exact private home
 * kitchen coordinates can never enter the renderer.
 */
export function clusterPlaces(
  places: Place[],
  zoom: number,
  radiusPixels = 58
): MapFeature[] {
  if (zoom >= 16 || places.length < 2) {
    return places.map((place) => ({
      kind: 'place',
      id: `place:${place.id}`,
      latitude: place.latitude,
      longitude: place.longitude,
      place,
    }));
  }

  const buckets = new Map<string, Place[]>();
  for (const place of places) {
    if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
    const pixel = worldPixel(place.latitude, place.longitude, zoom);
    const key = `${Math.floor(pixel.x / radiusPixels)}:${Math.floor(pixel.y / radiusPixels)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(place);
    else buckets.set(key, [place]);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    if (bucket.length === 1) {
      const place = bucket[0];
      return {
        kind: 'place' as const,
        id: `place:${place.id}`,
        latitude: place.latitude,
        longitude: place.longitude,
        place,
      };
    }

    const categories: Partial<Record<BusinessCategory, number>> = {};
    let latitude = 0;
    let sinLongitude = 0;
    let cosLongitude = 0;
    for (const place of bucket) {
      categories[place.category] = (categories[place.category] ?? 0) + 1;
      latitude += place.latitude;
      const longitudeRadians = (place.longitude * Math.PI) / 180;
      sinLongitude += Math.sin(longitudeRadians);
      cosLongitude += Math.cos(longitudeRadians);
    }

    const longitude = (Math.atan2(sinLongitude, cosLongitude) * 180) / Math.PI;
    return {
      kind: 'cluster' as const,
      id: `cluster:${zoom.toFixed(2)}:${key}`,
      latitude: latitude / bucket.length,
      longitude,
      count: bucket.length,
      categories,
      places: bucket,
    };
  });
}

export function zoomFromLongitudeDelta(longitudeDelta: number) {
  if (!Number.isFinite(longitudeDelta) || longitudeDelta <= 0) return 2;
  return Math.max(2, Math.min(18, Math.log2(360 / longitudeDelta)));
}

