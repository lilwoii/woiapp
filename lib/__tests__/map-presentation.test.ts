import {
  categoryMarkerLabel,
  mapClusterCategorySignature,
  mapClusterCategorySummary,
  mapCategoryOrder,
  mapCategoryPresentation,
  mapPlaceMarkerSignature,
} from '@/lib/map-presentation';
import { MOVING_TO_NEXT_LOCATION_LABEL } from '@/types/marketplace';

describe('map category presentation', () => {
  it('keeps food trucks first while assigning every venue a distinct marker shape and badge', () => {
    expect(mapCategoryOrder[0]).toBe('food_truck');
    expect(new Set(mapCategoryOrder.map((category) => mapCategoryPresentation[category].shape)).size)
      .toBe(mapCategoryOrder.length);
    expect(new Set(mapCategoryOrder.map((category) => mapCategoryPresentation[category].badge)).size)
      .toBe(mapCategoryOrder.length);
  });

  it('announces both the place and its venue type', () => {
    expect(categoryMarkerLabel('home_kitchen', 'Sunday Table'))
      .toBe('Sunday Table, Neighborhood kitchen');
  });

  it('summarizes mixed clusters by count while retaining food trucks as the tie break', () => {
    expect(mapClusterCategorySummary({ restaurant: 4, food_truck: 4, pop_up: 2 })).toEqual({
      badges: ['FT', 'R', 'POP'],
      accessibilityLabel: 'Food truck: 4, Restaurant: 4, Pop-up: 2',
    });
    expect(mapClusterCategorySignature({ restaurant: 4, food_truck: 4, pop_up: 2 }))
      .toBe('food_truck:4|restaurant:4|pop_up:2|cafe_bakery:0|home_kitchen:0');
  });

  it('changes a same-id fallback marker signature when moving turns on or off', () => {
    const stationary = {
      id: 'same-truck',
      name: 'Same Truck',
      category: 'food_truck' as const,
      logoUrl: 'https://cdn.example/truck.png',
      distanceMiles: 1.2,
      mobility: undefined,
    };
    const moving = {
      ...stationary,
      mobility: {
        state: 'moving_to_next_location' as const,
        label: MOVING_TO_NEXT_LOCATION_LABEL,
        nextStop: {
          locationId: '3b4db593-d099-4ec3-ab10-eb1e0528fdba',
          address: '100 Market Street',
          city: 'Los Angeles',
          startsAt: '2026-08-31T01:00:00.000Z',
          endsAt: '2026-08-31T03:00:00.000Z',
          timeWindow: 'Sun, Aug 30 · 6:00–8:00 PM PDT',
        },
      },
    };

    const stationarySignature = mapPlaceMarkerSignature(stationary);
    const movingSignature = mapPlaceMarkerSignature(moving);
    expect(movingSignature).not.toBe(stationarySignature);
    expect(mapPlaceMarkerSignature({ ...moving, mobility: undefined })).toBe(stationarySignature);
  });
});
