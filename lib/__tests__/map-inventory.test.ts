import { seedPlaces } from '@/data/places';
import { filterMapInventoryCategories, filterPlacesForEnabledCategories } from '@/lib/map-inventory';
import type { MapInventoryFeature } from '@/types/map';

describe('map inventory category gates', () => {
  const features: MapInventoryFeature[] = [
    {
      type: 'cluster',
      id: 'mixed',
      count: 9,
      latitude: 34,
      longitude: -118,
      categoryCounts: { food_truck: 4, home_kitchen: 5 },
      dominantCategory: 'home_kitchen',
    },
    {
      type: 'place',
      id: 'private-category',
      count: 1,
      latitude: 34.1,
      longitude: -118.1,
      categoryCounts: { home_kitchen: 1 },
      dominantCategory: 'home_kitchen',
    },
  ];

  it('removes disabled categories from both individual places and mixed clusters', () => {
    expect(filterMapInventoryCategories(features, new Set(['food_truck']))).toEqual([
      expect.objectContaining({
        id: 'mixed',
        count: 4,
        categoryCounts: { food_truck: 4 },
        dominantCategory: 'food_truck',
      }),
    ]);
  });

  it('removes disabled categories from directory cards and map fallback places', () => {
    const foodTruck = seedPlaces.find((place) => place.category === 'food_truck');
    const homeKitchen = seedPlaces.find((place) => place.category === 'home_kitchen');
    expect(foodTruck).toBeDefined();
    expect(homeKitchen).toBeDefined();
    expect(filterPlacesForEnabledCategories(
      [foodTruck!, homeKitchen!],
      new Set(['food_truck']),
    )).toEqual([foodTruck]);
  });
});
