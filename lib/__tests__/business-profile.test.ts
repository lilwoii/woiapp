import {
  BUSINESS_LOGO_MAX_BYTES,
  buildBusinessProfileRevisionPatch,
  cuisineLabelsFromText,
  mapBusinessProfileWorkspace,
  proposedBusinessProfileValues,
  validateBusinessLogoSelection,
  validateBusinessProfileValues,
} from '../business-profile';

const businessId = '74c00da5-6f88-46a7-a28b-704029a7cfa5';
const revisionId = '53e70e98-ac80-4978-a7d2-4a1284c29f7b';

const values = {
  name: ' Night   Market Kitchen ',
  description: 'Seasonal bowls and dumplings.',
  cuisines: [' Asian Fusion ', 'Dumplings', 'asian fusion'],
  priceLevel: 2 as const,
  timezone: 'America/Los_Angeles',
  businessEmail: ' OWNER@EXAMPLE.COM ',
  businessPhone: '+1 (213) 555-0123',
  websiteUrl: 'https://nightmarket.example/menu',
  showPhonePublic: true,
  showWebsitePublic: true,
  logoAssetId: null,
};

describe('business profile contracts', () => {
  it('normalizes profile fields and builds only approved revision sections', () => {
    const clean = validateBusinessProfileValues(values);
    expect(clean).toMatchObject({
      name: 'Night Market Kitchen',
      cuisines: ['Asian Fusion', 'Dumplings'],
      businessEmail: 'owner@example.com',
    });
    expect(buildBusinessProfileRevisionPatch(values)).toEqual({
      profile: {
        name: 'Night Market Kitchen',
        description: 'Seasonal bowls and dumplings.',
        cuisine_labels: ['Asian Fusion', 'Dumplings'],
        price_level: 2,
        timezone: 'America/Los_Angeles',
        logo_asset_id: null,
      },
      contacts: {
        business_email: 'owner@example.com',
        business_phone: '+1 (213) 555-0123',
        website_url: 'https://nightmarket.example/menu',
        show_phone_public: true,
        show_website_public: true,
      },
    });
  });

  it('rejects unsafe contact, time zone, and public-toggle combinations', () => {
    expect(() =>
      validateBusinessProfileValues({ ...values, websiteUrl: 'http://example.com' })
    ).toThrow('HTTPS');
    expect(() =>
      validateBusinessProfileValues({ ...values, timezone: 'Mars/Olympus' })
    ).toThrow('IANA');
    expect(() =>
      validateBusinessProfileValues({
        ...values,
        websiteUrl: '',
        showWebsitePublic: true,
      })
    ).toThrow('before showing it publicly');
  });

  it('deduplicates cuisines and enforces the 12-label limit', () => {
    expect(cuisineLabelsFromText('Tacos, tacos, Vegan Bowls')).toEqual([
      'Tacos',
      'Vegan Bowls',
    ]);
    expect(() =>
      cuisineLabelsFromText(
        Array.from({ length: 13 }, (_, index) => `Cuisine ${index}`).join(',')
      )
    ).toThrow('no more than 12');
  });

  it('accepts only exact square, typed logos under five megabytes', () => {
    expect(
      validateBusinessLogoSelection({
        uri: 'file:///logo.png',
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
        fileSize: BUSINESS_LOGO_MAX_BYTES - 1,
      })
    ).toMatchObject({ width: 1024, height: 1024, mimeType: 'image/png' });
    expect(() =>
      validateBusinessLogoSelection({
        uri: 'file:///wide.png',
        mimeType: 'image/png',
        width: 1024,
        height: 1023,
        fileSize: 1000,
      })
    ).toThrow('square logo');
    expect(() =>
      validateBusinessLogoSelection({
        uri: 'file:///large.png',
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
        fileSize: BUSINESS_LOGO_MAX_BYTES,
      })
    ).toThrow('smaller than 5 MB');
  });

  it('maps no authentication identifiers and layers pending values over live data', () => {
    const workspace = mapBusinessProfileWorkspace({
      business: {
        id: businessId,
        kind: 'food_truck',
        name: 'Night Market Kitchen',
        description: 'Live description',
        cuisine_labels: ['Dumplings'],
        price_level: 2,
        state: 'published',
        verification: 'verified',
        timezone: 'America/Los_Angeles',
        logo_asset_id: null,
        created_by: 'private-auth-id-must-not-leak',
      },
      contacts: {
        business_id: businessId,
        business_email: 'owner@example.com',
        business_phone: '+1 213 555 0123',
        website_url: 'https://example.com',
        show_phone_public: false,
        show_website_public: true,
        legal_name: 'Private legal name must not leak',
      },
      membership: {
        role: 'owner',
        user_id: 'private-auth-id-must-not-leak',
      },
      pendingRevision: [
        {
          revision_id: revisionId,
          business_id: businessId,
          state: 'pending',
          sections: ['contacts', 'profile'],
          proposed_patch: {
            profile: { name: 'Proposed Kitchen' },
            contacts: { show_phone_public: true },
          },
          base_updated_at: '2026-07-30T10:00:00.000Z',
          created_at: '2026-07-30T11:00:00.000Z',
          updated_at: '2026-07-30T12:00:00.000Z',
        },
      ],
    });

    expect(workspace).not.toHaveProperty('userId');
    expect(workspace.live).not.toHaveProperty('legalName');
    expect(proposedBusinessProfileValues(workspace)).toMatchObject({
      name: 'Proposed Kitchen',
      businessPhone: '+1 213 555 0123',
      showPhonePublic: true,
    });
  });
});
