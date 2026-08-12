import {
  categoryMarkerLabel,
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
});
