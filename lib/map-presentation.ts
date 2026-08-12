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
