import { seedPlaces } from '../../data/places';
import type { SponsoredPlace } from '../../types/marketplace';
import {
  cuisineFacets,
  discoverySearchScore,
  discoveryFilterCount,
  placeSupportsPickup,
  rankDiscoveryPlaces,
  type DiscoveryFilters,
} from '../discovery-filters';

const base: DiscoveryFilters = {
  query: '',
  area: '',
  category: 'all',
  openOnly: false,
  cuisine: null,
  dietary: [],
  payments: [],
  priceLevels: [],
  maxDistanceMiles: null,
  minimumRating: 0,
  pickupOnly: false,
  sort: 'nearby',
};

describe('discovery filters', () => {
  it('combines category, cuisine, dietary, payment, rating, price, and pickup filters', () => {
    const result = rankDiscoveryPlaces(
      seedPlaces,
      {
        ...base,
        category: 'food_truck',
        cuisine: 'Sonoran',
        dietary: ['Gluten-aware'],
        payments: ['Apple Pay'],
        priceLevels: [2],
        minimumRating: 4.5,
        pickupOnly: true,
      },
      null
    );
    expect(result.map((place) => place.id)).toEqual(['copper-coyote']);
  });

  it('uses live coordinates for distance limits and nearby ordering', () => {
    const result = rankDiscoveryPlaces(
      seedPlaces,
      { ...base, category: 'food_truck', maxDistanceMiles: 1 },
      { latitude: 34.0744, longitude: -118.3437 }
    );
    expect(result.map((place) => place.id)).toEqual(['copper-coyote']);
  });

  it('keeps food trucks first only as an organic tie-break, not a paid override', () => {
    const restaurant = { ...seedPlaces[3], distanceMiles: 1 };
    const truck = { ...seedPlaces[0], distanceMiles: 1 };
    expect(
      rankDiscoveryPlaces([restaurant, truck], base, null).map((place) => place.id)
    ).toEqual([truck.id, restaurant.id]);
  });

  it('never feeds sponsored metadata into organic ranking', () => {
    const organicFirst = { ...seedPlaces[0], distanceMiles: 1 };
    const sponsoredSecond: SponsoredPlace = {
      ...seedPlaces[1],
      distanceMiles: 2,
      sponsoredPlacement: {
        id: '31000000-0000-4000-8000-000000000003',
        locationId: '32000000-0000-4000-8000-000000000003',
        disclosure: 'Sponsored ad' as const,
        reason: 'Near your selected area',
        token: `${'32000000-0000-4000-8000-000000000003'}.${'1790000000'}.${'a'.repeat(64)}`,
        expiresAt: '2026-09-22T00:00:00.000Z',
      },
    };
    expect(
      rankDiscoveryPlaces([sponsoredSecond, organicFirst], base, null).map(
        (place) => place.id
      )
    ).toEqual([organicFirst.id, sponsoredSecond.id]);
  });

  it('builds deterministic cuisine facets and an accurate active-filter count', () => {
    expect(cuisineFacets(seedPlaces).some((facet) => facet.label === 'Tacos')).toBe(true);
    expect(
      discoveryFilterCount({
        ...base,
        openOnly: true,
        dietary: ['Vegan'],
        payments: ['Cash'],
        priceLevels: [1, 2],
        maxDistanceMiles: 5,
        pickupOnly: true,
      })
    ).toBe(7);
  });

  it('requires every selected payment and dietary accommodation', () => {
    expect(
      rankDiscoveryPlaces(
        seedPlaces,
        { ...base, payments: ['Cash', 'Amex'] },
        null
      )
    ).toEqual([]);
    expect(
      rankDiscoveryPlaces(
        seedPlaces,
        { ...base, dietary: ['Vegan', 'Vegetarian'] },
        null
      )
    ).toEqual([]);
  });

  it('falls back to a normalized feature label when pickup metadata is absent', () => {
    const place = {
      ...seedPlaces[0],
      pickup: undefined,
      features: ['Contactless PICKUP available'],
    };
    expect(placeSupportsPickup(place)).toBe(true);
    expect(placeSupportsPickup({ ...place, features: ['Outdoor seating'] })).toBe(false);
  });

  it.each([
    ['trending', 'trendingScore'],
    ['popular', 'popularityScore'],
    ['rating', 'rating'],
  ] as const)('sorts %s results by the requested organic signal', (sort, metric) => {
    const low = { ...seedPlaces[0], id: `${sort}-low`, [metric]: 1 };
    const high = { ...seedPlaces[1], id: `${sort}-high`, [metric]: 99 };
    expect(
      rankDiscoveryPlaces([low, high], { ...base, sort }, null).map(
        (place) => place.id
      )
    ).toEqual([high.id, low.id]);
  });

  it('uses reliability and then name as deterministic organic tie-breaks', () => {
    const basePlace = {
      ...seedPlaces[0],
      category: 'restaurant' as const,
      distanceMiles: 1,
    };
    const reliable = { ...basePlace, id: 'reliable', name: 'Zulu', reliabilityScore: 99 };
    const lessReliable = { ...basePlace, id: 'less', name: 'Alpha', reliabilityScore: 80 };
    expect(
      rankDiscoveryPlaces([lessReliable, reliable], base, null).map((place) => place.id)
    ).toEqual(['reliable', 'less']);

    const alpha = { ...basePlace, id: 'alpha', name: 'Alpha', reliabilityScore: 99 };
    expect(
      rankDiscoveryPlaces([reliable, alpha], base, null).map((place) => place.id)
    ).toEqual(['alpha', 'reliable']);
  });

  it('excludes unpublished records and applies search and area tokens together', () => {
    const published = { ...seedPlaces[0], publicationState: 'published' as const };
    const draft = { ...seedPlaces[1], publicationState: 'draft' as const };
    expect(
      rankDiscoveryPlaces(
        [draft, published],
        { ...base, query: 'sonoran', area: 'Los Angeles 90036' },
        null
      ).map((place) => place.id)
    ).toEqual([published.id]);
  });

  it('finds public menu items and dietary terms with tokens in any order', () => {
    expect(
      rankDiscoveryPlaces(
        seedPlaces,
        { ...base, query: 'vegan cauliflower' },
        null
      ).map((place) => place.id)
    ).toEqual(['ember-and-grain']);

    expect(
      rankDiscoveryPlaces(
        seedPlaces,
        { ...base, query: 'yuzu mushroom' },
        null
      ).map((place) => place.id)
    ).toEqual(['miso-mile']);
  });

  it('ranks an exact public name above incidental text without overriding filters', () => {
    const exact = {
      ...seedPlaces[3],
      id: 'exact-cafe',
      name: 'Café Sol',
      status: 'closed' as const,
      popularityScore: 1,
    };
    const incidental = {
      ...seedPlaces[0],
      id: 'incidental-cafe',
      name: 'Morning Table',
      description: 'A cafe sol inspired seasonal plate.',
      popularityScore: 999,
    };

    expect(discoverySearchScore(exact, 'cafe sol')).toBeGreaterThan(
      discoverySearchScore(incidental, 'cafe sol') ?? 0
    );
    expect(
      rankDiscoveryPlaces(
        [incidental, exact],
        { ...base, query: 'cafe sol', sort: 'popular' },
        null
      ).map((place) => place.id)
    ).toEqual([exact.id, incidental.id]);
    expect(
      rankDiscoveryPlaces(
        [incidental, exact],
        { ...base, query: 'cafe sol', openOnly: true },
        null
      ).map((place) => place.id)
    ).toEqual([incidental.id]);
  });

  it('matches useful prefixes but rejects vague short substrings', () => {
    expect(
      rankDiscoveryPlaces(seedPlaces, { ...base, query: 'sonor taco' }, null)
        .map((place) => place.id)
    ).toContain('copper-coyote');
    expect(
      rankDiscoveryPlaces(seedPlaces, { ...base, query: 'pp' }, null)
    ).toEqual([]);
  });

  it('matches city and area filters without requiring diacritics', () => {
    const saoPaulo = {
      ...seedPlaces[0],
      id: 'sao-paulo-truck',
      city: 'São Paulo',
      region: 'SP',
      address: 'Praça da Sé',
    };
    expect(
      rankDiscoveryPlaces([saoPaulo], { ...base, area: 'sao paulo' }, null)
        .map((place) => place.id)
    ).toEqual([saoPaulo.id]);
  });
});
