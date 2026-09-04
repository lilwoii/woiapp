import { findExactMarketplacePlace } from '@/lib/marketplace-api';

const businessId = '11111111-1111-4111-8111-111111111111';
const primaryLocationId = '22222222-2222-4222-8222-222222222222';
const secondaryLocationId = '33333333-3333-4333-8333-333333333333';
const modernLocationId = '77777777-7777-7777-8777-777777777777';

describe('marketplace branch selection', () => {
  const places = [
    { id: businessId, locationId: primaryLocationId },
    { id: businessId, locationId: secondaryLocationId },
    { id: businessId, locationId: modernLocationId },
  ];

  it('returns only the explicitly requested branch', () => {
    expect(findExactMarketplacePlace(places, businessId, secondaryLocationId)).toEqual(
      places[1],
    );
  });

  it('shares the public v1-v8 branch UUID boundary used by route links', () => {
    expect(findExactMarketplacePlace(places, businessId, modernLocationId.toUpperCase()))
      .toEqual(places[2]);
  });

  it('never falls back to primary for an unrelated valid location UUID', () => {
    expect(findExactMarketplacePlace(
      places,
      businessId,
      '44444444-4444-4444-8444-444444444444',
    )).toBeUndefined();
  });

  it('rejects malformed location references and preserves business-only lookup', () => {
    expect(findExactMarketplacePlace(places, businessId, 'not-a-location')).toBeUndefined();
    expect(findExactMarketplacePlace(places, businessId)).toEqual(places[0]);
  });
});
