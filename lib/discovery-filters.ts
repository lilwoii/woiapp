import type {
  BusinessCategory,
  DietaryTag,
  PaymentMethod,
  Place,
} from '@/types/marketplace';

export type DiscoveryCategory = BusinessCategory | 'all';
export type DiscoverySort = 'nearby' | 'trending' | 'popular' | 'rating';

export type DiscoveryFilters = {
  query: string;
  area: string;
  category: DiscoveryCategory;
  openOnly: boolean;
  cuisine: string | null;
  dietary: DietaryTag[];
  payments: PaymentMethod[];
  priceLevels: (1 | 2 | 3 | 4)[];
  maxDistanceMiles: number | null;
  minimumRating: number;
  pickupOnly: boolean;
  sort: DiscoverySort;
};

export type DiscoveryCoordinates = {
  latitude: number;
  longitude: number;
};

const normalize = (value: string) =>
  value.normalize('NFKC').trim().toLocaleLowerCase('en-US');

export function distanceMiles(
  origin: DiscoveryCoordinates,
  destination: DiscoveryCoordinates
) {
  const earthRadiusMiles = 3958.8;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(destination.latitude - origin.latitude);
  const longitudeDelta = radians(destination.longitude - origin.longitude);
  const startLatitude = radians(origin.latitude);
  const endLatitude = radians(destination.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return (
    earthRadiusMiles *
    2 *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

export function placeSupportsPickup(place: Place) {
  if (place.pickup?.enabled) return true;
  return place.features.some((feature) => normalize(feature).includes('pickup'));
}

export function dietaryTagsForPlace(place: Place) {
  return new Set(
    place.menu.flatMap((section) =>
      section.items.flatMap((item) => item.dietary ?? [])
    )
  );
}

function organicTieBreak(left: Place, right: Place) {
  const truckDifference =
    Number(right.category === 'food_truck') - Number(left.category === 'food_truck');
  if (truckDifference) return truckDifference;
  const reliabilityDifference =
    (right.reliabilityScore ?? 0) - (left.reliabilityScore ?? 0);
  if (reliabilityDifference) return reliabilityDifference;
  return left.name.localeCompare(right.name, 'en-US');
}

export function rankDiscoveryPlaces(
  places: Place[],
  filters: DiscoveryFilters,
  coordinates: DiscoveryCoordinates | null
) {
  const query = normalize(filters.query);
  const areaTokens = normalize(filters.area).split(/[\s,]+/).filter(Boolean);
  const cuisine = filters.cuisine ? normalize(filters.cuisine) : null;
  const selectedDietary = new Set(filters.dietary);
  const selectedPayments = new Set(filters.payments);
  const selectedPrices = new Set(filters.priceLevels);

  return places
    .map((place) =>
      coordinates
        ? {
            ...place,
            distanceMiles: distanceMiles(coordinates, {
              latitude: place.latitude,
              longitude: place.longitude,
            }),
          }
        : place
    )
    .filter((place) => {
      if (place.publicationState && place.publicationState !== 'published') return false;
      if (filters.category !== 'all' && place.category !== filters.category) return false;
      if (filters.openOnly && place.status !== 'open') return false;
      if (place.rating < filters.minimumRating) return false;
      if (selectedPrices.size && !selectedPrices.has(place.priceLevel)) return false;
      if (
        filters.maxDistanceMiles !== null &&
        (place.distanceMiles === null || place.distanceMiles > filters.maxDistanceMiles)
      ) {
        return false;
      }
      if (filters.pickupOnly && !placeSupportsPickup(place)) return false;
      if (cuisine && !place.cuisines.some((label) => normalize(label) === cuisine)) {
        return false;
      }
      if (
        selectedPayments.size &&
        ![...selectedPayments].every((payment) => place.payments.includes(payment))
      ) {
        return false;
      }
      if (selectedDietary.size) {
        const availableDietary = dietaryTagsForPlace(place);
        if (![...selectedDietary].every((tag) => availableDietary.has(tag))) {
          return false;
        }
      }

      const searchable = normalize(
        [
          place.name,
          place.categoryLabel,
          place.cuisines.join(' '),
          place.features.join(' '),
          place.address,
          place.city,
          place.region,
          place.postalCode,
        ]
          .filter(Boolean)
          .join(' ')
      );
      if (query && !searchable.includes(query)) return false;

      const areaHaystack = normalize(
        [place.city, place.region, place.postalCode, place.address]
          .filter(Boolean)
          .join(' ')
      );
      return areaTokens.every((token) => areaHaystack.includes(token));
    })
    .sort((left, right) => {
      let difference = 0;
      if (filters.sort === 'trending') {
        difference = right.trendingScore - left.trendingScore;
      } else if (filters.sort === 'popular') {
        difference = right.popularityScore - left.popularityScore;
      } else if (filters.sort === 'rating') {
        difference = right.rating - left.rating || right.reviewCount - left.reviewCount;
      } else {
        difference =
          (left.distanceMiles ?? Number.MAX_SAFE_INTEGER) -
          (right.distanceMiles ?? Number.MAX_SAFE_INTEGER);
      }
      return difference || organicTieBreak(left, right);
    });
}

export function cuisineFacets(places: Place[]) {
  const counts = new Map<string, { label: string; count: number }>();
  for (const place of places) {
    for (const rawLabel of place.cuisines) {
      const label = rawLabel.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      const key = normalize(label);
      const current = counts.get(key);
      counts.set(key, { label: current?.label ?? label, count: (current?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label)
  );
}

export function discoveryFilterCount(filters: DiscoveryFilters) {
  return (
    Number(filters.openOnly) +
    Number(Boolean(filters.cuisine)) +
    filters.dietary.length +
    filters.payments.length +
    filters.priceLevels.length +
    Number(filters.maxDistanceMiles !== null) +
    Number(filters.minimumRating > 0) +
    Number(filters.pickupOnly)
  );
}
