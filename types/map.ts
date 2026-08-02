import type { BusinessCategory, Place } from '@/types/marketplace';

export type MapViewport = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  zoom: number;
  bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
};

export type MapInventoryFeature = {
  type: 'cluster' | 'place';
  id: string;
  count: number;
  latitude: number;
  longitude: number;
  categoryCounts: Partial<Record<BusinessCategory, number>>;
  dominantCategory: BusinessCategory;
  businessId?: string;
  locationId?: string;
  name?: string;
  logoUrl?: string;
  sourceLabel?: Place['sourceLabel'];
};
