import {
  categoryMarkerLabel,
  mapClusterCategorySignature,
  mapClusterCategorySummary,
  mapCategoryOrder,
  mapCategoryPresentation,
} from '@/lib/map-presentation';

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
});
