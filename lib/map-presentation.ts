import type FontAwesome6 from '@expo/vector-icons/FontAwesome6';

import type { BusinessCategory } from '@/types/marketplace';

export type MapMarkerShape = 'capsule' | 'circle' | 'market' | 'cup' | 'home';

export type MapCategoryPresentation = {
  label: string;
  shortLabel: string;
  badge: string;
  icon: keyof typeof FontAwesome6.glyphMap;
  shape: MapMarkerShape;
};

export const mapCategoryOrder: BusinessCategory[] = [
  'food_truck',
  'restaurant',
  'pop_up',
  'cafe_bakery',
  'home_kitchen',
];

export const mapCategoryPresentation: Record<BusinessCategory, MapCategoryPresentation> = {
  food_truck: {
    label: 'Food truck',
    shortLabel: 'Truck',
    badge: 'FT',
    icon: 'truck',
    shape: 'capsule',
  },
  restaurant: {
    label: 'Restaurant',
    shortLabel: 'Restaurant',
    badge: 'R',
    icon: 'utensils',
    shape: 'circle',
  },
  pop_up: {
    label: 'Pop-up',
    shortLabel: 'Pop-up',
    badge: 'POP',
    icon: 'store',
    shape: 'market',
  },
  cafe_bakery: {
    label: 'Café or bakery',
    shortLabel: 'Café',
    badge: 'CAF',
    icon: 'mug-hot',
    shape: 'cup',
  },
  home_kitchen: {
    label: 'Neighborhood kitchen',
    shortLabel: 'Kitchen',
    badge: 'NK',
    icon: 'house',
    shape: 'home',
  },
};

export function categoryMarkerLabel(category: BusinessCategory, name: string) {
  return `${name}, ${mapCategoryPresentation[category].label}`;
}

export function mapClusterCategorySummary(
  counts: Partial<Record<BusinessCategory, number>>,
  limit = 3
) {
  const ranked = mapCategoryOrder
    .map((category) => ({ category, count: counts[category] ?? 0 }))
    .filter((entry) => Number.isFinite(entry.count) && entry.count > 0)
    .sort((left, right) => right.count - left.count || mapCategoryOrder.indexOf(left.category) - mapCategoryOrder.indexOf(right.category));
  return {
    badges: ranked.slice(0, Math.max(1, limit)).map((entry) => mapCategoryPresentation[entry.category].badge),
    accessibilityLabel: ranked.map((entry) => `${mapCategoryPresentation[entry.category].label}: ${entry.count}`).join(', '),
  };
}

export function mapClusterCategorySignature(counts: Partial<Record<BusinessCategory, number>>) {
  return mapCategoryOrder.map((category) => `${category}:${counts[category] ?? 0}`).join('|');
}
