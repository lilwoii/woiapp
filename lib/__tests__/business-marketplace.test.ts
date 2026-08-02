import { mapManagedPickupSites, mapMarketplaceControls, validatePickupSiteDraft } from '../business-marketplace';

const businessId = 'cf844b56-696c-48cf-9f72-715d823776f3';
const siteId = 'a418d851-2f2a-4ed8-8df8-52a1293c6211';

describe('business marketplace contracts', () => {
  it('maps strict eligible chat controls', () => {
    expect(mapMarketplaceControls([{ business_id: businessId, business_name: 'Neighborhood Table', business_kind: 'home_kitchen', chat_enabled: true, chat_required: true, can_toggle_chat: false }])).toMatchObject({ chatEnabled: true, chatRequired: true, canToggleChat: false });
    expect(() => mapMarketplaceControls([{ business_id: businessId, business_name: 'Restaurant', business_kind: 'restaurant', chat_enabled: false, chat_required: false, can_toggle_chat: false }])).toThrow();
  });

  it('maps exact site details only from the narrow manager projection', () => {
    const sites = mapManagedPickupSites([{ pickup_site_public_id: siteId, label: 'Market entrance', site_kind: 'public_meeting_place', state: 'submitted', address_line: '1 Market St', city: 'Austin', region: 'TX', postal_code: '78701', latitude: 30.2, longitude: -97.7, submitted_at: '2026-08-01T10:00:00Z', reviewed_at: null, updated_at: '2026-08-01T10:00:00Z' }]);
    expect(sites[0]).toMatchObject({ publicId: siteId, latitude: 30.2, state: 'submitted' });
    expect(() => mapManagedPickupSites([{ ...sites[0], pickup_site_public_id: 'bad' }])).toThrow();
  });

  it('normalizes a non-residential pickup draft and rejects invalid coordinates', () => {
    expect(validatePickupSiteDraft({ label: '  Central  Market ', kind: 'commercial_site', addressLine: ' 123 Market St ', city: ' Austin ', region: ' TX ', postalCode: '78701', latitude: '30.25', longitude: '-97.75' })).toMatchObject({ label: 'Central Market', latitude: 30.25 });
    expect(() => validatePickupSiteDraft({ label: 'Place', kind: 'commercial_site', addressLine: '123 Market', city: 'Austin', region: 'TX', postalCode: '', latitude: '91', longitude: '0' })).toThrow('valid latitude');
  });
});
