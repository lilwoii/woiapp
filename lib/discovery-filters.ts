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

const normalizeSearchText = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');

type DiscoverySearchField = {
  text: string;
  weight: number;
};

function discoverySearchFields(place: Place): DiscoverySearchField[] {
  return [
    { text: place.name, weight: 120 },
    ...place.cuisines.map((text) => ({ text, weight: 90 })),
    ...place.menu.flatMap((section) => [
      { text: section.name, weight: 65 },
      ...section.items.flatMap((item) => [
        { text: item.name, weight: 80 },
        { text: item.description, weight: 30 },
        ...(item.dietary ?? []).map((text) => ({ text, weight: 50 })),
      ]),
    ]),
    { text: place.categoryLabel, weight: 60 },
    { text: place.category.replaceAll('_', ' '), weight: 60 },
    ...place.features.map((text) => ({ text, weight: 45 })),
    { text: place.description, weight: 35 },
    { text: place.city, weight: 55 },
    { text: place.postalCode, weight: 55 },
    { text: place.region ?? '', weight: 35 },
    { text: place.address, weight: 25 },
  ].flatMap((field) => {
    const text = normalizeSearchText(field.text);
    return text ? [{ ...field, text }] : [];
  });
}

function searchTokenMatchQuality(fieldToken: string, queryToken: string) {
  if (fieldToken === queryToken) return 4;
  if (queryToken.length >= 3 && fieldToken.startsWith(queryToken)) return 3;
  if (
    fieldToken.length >= 3 &&
    queryToken.length >= 4 &&
    queryToken.startsWith(fieldToken)
  ) {
    return 2;
  }
  return 0;
}

/**
 * Scores only public data already projected into a Place. Every query token
 * must match, which prevents a broad description hit from burying an exact
 * business, cuisine, or menu-item result. Menu fields participate whenever
 * they are already loaded; this helper never fetches or infers private data.
 */
export function discoverySearchScore(place: Place, rawQuery: string) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return 0;
  if (query.length > 120) return null;

  const queryTokens = [...new Set(query.split(' ').filter(Boolean))];
  const fields = discoverySearchFields(place).map((field) => ({
    ...field,
    tokens: field.text.split(' ').filter(Boolean),
  }));
  let score = 0;

  for (const queryToken of queryTokens) {
    let bestTokenScore = 0;
    for (const field of fields) {
      for (const fieldToken of field.tokens) {
        const quality = searchTokenMatchQuality(fieldToken, queryToken);
        if (quality) bestTokenScore = Math.max(bestTokenScore, field.weight * quality);
      }
    }
    if (!bestTokenScore) return null;
    score += bestTokenScore;
  }

  for (const field of fields) {
    if (field.text === query) score += field.weight * 12;
    else if (field.text.startsWith(query)) score += field.weight * 8;
    else if (field.text.includes(query)) score += field.weight * 5;
  }

  return score;
}

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
  const query = normalizeSearchText(filters.query);
  const areaTokens = normalizeSearchText(filters.area).split(' ').filter(Boolean);
  const cuisine = filters.cuisine ? normalize(filters.cuisine) : null;
  const selectedDietary = new Set(filters.dietary);
  const selectedPayments = new Set(filters.payments);
  const selectedPrices = new Set(filters.priceLevels);

  return places
    .map((rawPlace) => {
      const place = coordinates
        ? {
            ...rawPlace,
            distanceMiles: distanceMiles(coordinates, {
              latitude: rawPlace.latitude,
              longitude: rawPlace.longitude,
            }),
          }
        : rawPlace;
      return { place, queryScore: discoverySearchScore(place, query) };
    })
    .filter(({ place, queryScore }) => {
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

      if (query && queryScore === null) return false;

      const areaHaystack = normalizeSearchText(
        [place.city, place.region, place.postalCode, place.address]
          .filter(Boolean)
          .join(' ')
      );
      return areaTokens.every((token) => areaHaystack.includes(token));
    })
    .sort((leftEntry, rightEntry) => {
      const left = leftEntry.place;
      const right = rightEntry.place;
      let difference = 0;
      if (query) {
        difference = (rightEntry.queryScore ?? 0) - (leftEntry.queryScore ?? 0);
      }
      if (difference) return difference;
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
    })
    .map(({ place }) => place);
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
