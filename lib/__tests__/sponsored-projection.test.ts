import {
  isValidSponsoredPlacementProjection,
  parseSponsoredPlacementToken,
  splitSponsoredPlaces,
} from '@/lib/marketplace-api';
import type { Place, SponsoredPlace } from '@/types/marketplace';

const sponsoredLocationId = '41ab0000-0000-4a00-8000-000000000004';
const otherLocationId = '51ab0000-0000-4a00-8000-000000000005';
const place = (id: string, locationId = otherLocationId) => ({ id, locationId } as Place);
const sponsoredTokenExpirySeconds = 1790000000;
const sponsoredTokenPlacementId = '31ab0000-0000-4a00-8000-000000000003';
const sponsoredPlacement: SponsoredPlace['sponsoredPlacement'] = {
  id: sponsoredTokenPlacementId,
  locationId: sponsoredLocationId,
  disclosure: 'Sponsored ad',
  reason: 'Near your selected area',
  token: `${sponsoredTokenPlacementId}.${sponsoredTokenExpirySeconds}.${'a'.repeat(64)}`,
  expiresAt: new Date(sponsoredTokenExpirySeconds * 1000).toISOString(),
};

describe('sponsored discovery projection', () => {
  it('keeps a sponsor-only business out of organic places while returning the lane projection', () => {
    const organicPlace = place('organic-place');
    const sponsorOnlyPlace = place('sponsor-only-place');
    const sponsorExactLocation = place('sponsor-only-place', sponsoredLocationId);

    const result = splitSponsoredPlaces(
      [organicPlace, sponsorOnlyPlace],
      new Set([organicPlace.id]),
      sponsorOnlyPlace.id,
      sponsorExactLocation,
      sponsoredPlacement,
    );

    expect(result.places).toEqual([organicPlace]);
    expect(result.sponsoredPlace).toMatchObject({
      id: sponsorOnlyPlace.id,
      locationId: sponsoredLocationId,
      sponsoredPlacement,
    });
  });

  it('retains a nearby sponsored business in organic inventory when it was already present', () => {
    const nearbySponsoredPlace = place('nearby-sponsored-place');
    const sponsoredExactLocation = place(nearbySponsoredPlace.id, sponsoredLocationId);

    const result = splitSponsoredPlaces(
      [nearbySponsoredPlace],
      new Set([nearbySponsoredPlace.id]),
      nearbySponsoredPlace.id,
      sponsoredExactLocation,
      sponsoredPlacement,
    );

    expect(result.places).toEqual([nearbySponsoredPlace]);
    expect(result.sponsoredPlace?.id).toBe(nearbySponsoredPlace.id);
    expect(result.sponsoredPlace?.locationId).toBe(sponsoredLocationId);
  });

  it('fails closed when the sponsored candidate is not the server-selected branch', () => {
    const sponsor = place('sponsor-only-place');

    const result = splitSponsoredPlaces(
      [sponsor],
      new Set<string>(),
      sponsor.id,
      sponsor,
      sponsoredPlacement,
    );

    expect(result.places).toEqual([]);
    expect(result.sponsoredPlace).toBeUndefined();
  });

  it('accepts only an exact UUID/10-digit/fingerprint token with a matching future expiry', () => {
    const now = Date.parse('2026-08-29T00:00:00.000Z');

    expect(parseSponsoredPlacementToken(sponsoredPlacement.token, now)).toEqual({
      placementId: sponsoredTokenPlacementId,
      expiresAtSeconds: sponsoredTokenExpirySeconds,
    });
    expect(
      isValidSponsoredPlacementProjection(
        sponsoredPlacement.token,
        sponsoredPlacement.id,
        sponsoredPlacement.expiresAt,
        now,
      )
    ).toBe(true);
    expect(
      parseSponsoredPlacementToken(
        `31000000-0000-0000-8000-000000000003.${sponsoredTokenExpirySeconds}.${'a'.repeat(64)}`,
        now,
      )
    ).toBeNull();
    expect(
      parseSponsoredPlacementToken(
        `${sponsoredTokenPlacementId.toUpperCase()}.${sponsoredTokenExpirySeconds}.${'a'.repeat(64)}`,
        now,
      )
    ).toBeNull();
    expect(
      isValidSponsoredPlacementProjection(
        sponsoredPlacement.token,
        sponsoredPlacement.id,
        new Date((sponsoredTokenExpirySeconds + 1) * 1000).toISOString(),
        now,
      )
    ).toBe(false);
  });

  it('rejects an expired interaction token and projection', () => {
    const afterExpiry = (sponsoredTokenExpirySeconds + 1) * 1000;

    expect(parseSponsoredPlacementToken(sponsoredPlacement.token, afterExpiry)).toBeNull();
    expect(
      isValidSponsoredPlacementProjection(
        sponsoredPlacement.token,
        sponsoredPlacement.id,
        sponsoredPlacement.expiresAt,
        afterExpiry,
      )
    ).toBe(false);
  });
});
