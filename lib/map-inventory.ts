import type { MapInventoryFeature } from '@/types/map';
import type { BusinessCategory, Place } from '@/types/marketplace';

export function filterPlacesForEnabledCategories(
  places: Place[],
  allowedCategories: ReadonlySet<BusinessCategory>,
) {
  return places.filter((place) => allowedCategories.has(place.category));
}

export function filterMapInventoryCategories(
  features: MapInventoryFeature[],
  allowedCategories: ReadonlySet<BusinessCategory>,
) {
  return features.flatMap((feature): MapInventoryFeature[] => {
    if (feature.type === 'place') {
      return allowedCategories.has(feature.dominantCategory) ? [feature] : [];
    }

    const categoryCounts = Object.fromEntries(
      Object.entries(feature.categoryCounts).filter(([category, count]) =>
        allowedCategories.has(category as BusinessCategory) && (count ?? 0) > 0
      ),
    ) as MapInventoryFeature['categoryCounts'];
    const rankedCategories = (Object.entries(categoryCounts) as [BusinessCategory, number][])
      .sort((left, right) => right[1] - left[1]);
    const count = rankedCategories.reduce((sum, [, categoryCount]) => sum + categoryCount, 0);
    if (!count) return [];
    return [{
      ...feature,
      categoryCounts,
      count,
      dominantCategory: rankedCategories[0][0],
    }];
  });
}
