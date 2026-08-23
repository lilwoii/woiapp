import type { MapInventoryFeature } from '@/types/map';
import type { BusinessCategory, Place } from '@/types/marketplace';

// The map renderer folds server responses down to at most 300 web markers (and
// 120 native markers). Keep optional logo signing bounded to that same shared
// upper budget; markers without a signed logo still render their category icon.
export const MAX_MAP_LOGO_URLS = 300;

export function mapLogoPaths(
  rows: ReadonlyArray<{ logo_path?: unknown }>,
): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.logo_path)
        .filter((path): path is string => typeof path === 'string' && path.length > 0),
    ),
  ].slice(0, MAX_MAP_LOGO_URLS);
}

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
