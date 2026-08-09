import type { MapInventoryFeature } from '@/types/map';
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

export function normalizeLongitude(longitude: number) {
  if (!Number.isFinite(longitude)) return 0;
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

export function viewportIsLiveInventoryEligible(bounds: {
  west: number;
  south: number;
  east: number;
  north: number;
}) {
  if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) return false;
  const longitudeSpan = bounds.west <= bounds.east
    ? bounds.east - bounds.west
    : (180 - bounds.west) + (bounds.east + 180);
  return bounds.north > bounds.south && bounds.north - bounds.south <= 12 && longitudeSpan <= 12;
}

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

/**
 * Binds rendered annotation count without discarding inventory. Dense point and
 * server-cluster features are folded into larger public clusters until the map
 * can render them predictably on low-end devices.
 */
export function clusterInventoryFeatures(
  features: MapInventoryFeature[],
  zoom: number,
  maximumRenderedFeatures = 300
): MapInventoryFeature[] {
  if (features.length <= maximumRenderedFeatures) return features;

  const renderedLimit = Math.max(1, Math.floor(maximumRenderedFeatures));
  let radiusPixels = 58;
  let clustered = features;
  while (clustered.length > renderedLimit) {
    const buckets = new Map<string, MapInventoryFeature[]>();
    for (const feature of features) {
      if (!Number.isFinite(feature.latitude) || !Number.isFinite(feature.longitude)) continue;
      const pixel = worldPixel(feature.latitude, feature.longitude, zoom);
      const key = `${Math.floor(pixel.x / radiusPixels)}:${Math.floor(pixel.y / radiusPixels)}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(feature);
      else buckets.set(key, [feature]);
    }

    clustered = [...buckets.entries()].map(([key, bucket]) => {
      if (bucket.length === 1) return bucket[0];
      const categoryCounts: MapInventoryFeature['categoryCounts'] = {};
      let count = 0;
      let latitude = 0;
      let sinLongitude = 0;
      let cosLongitude = 0;
      for (const feature of bucket) {
        count += feature.count;
        latitude += feature.latitude * feature.count;
        const radians = (feature.longitude * Math.PI) / 180;
        sinLongitude += Math.sin(radians) * feature.count;
        cosLongitude += Math.cos(radians) * feature.count;
        for (const [category, categoryCount] of Object.entries(feature.categoryCounts)) {
          const typedCategory = category as BusinessCategory;
          categoryCounts[typedCategory] = (categoryCounts[typedCategory] ?? 0) + (categoryCount ?? 0);
        }
      }
      const dominantCategory = (Object.entries(categoryCounts) as [BusinessCategory, number][])
        .sort((left, right) => right[1] - left[1])[0]?.[0] ?? bucket[0].dominantCategory;
      return {
        type: 'cluster' as const,
        id: `dense:${zoom.toFixed(2)}:${Math.round(radiusPixels)}:${key}`,
        count,
        latitude: latitude / count,
        longitude: (Math.atan2(sinLongitude, cosLongitude) * 180) / Math.PI,
        categoryCounts,
        dominantCategory,
      };
    });
    radiusPixels *= 1.6;
  }
  return clustered;
}
export function zoomFromLongitudeDelta(longitudeDelta: number) {
  if (!Number.isFinite(longitudeDelta) || longitudeDelta <= 0) return 2;
  return Math.max(2, Math.min(18, Math.log2(360 / longitudeDelta)));
}
