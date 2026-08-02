import { mapPendingPickupSites, mapReportedChatMessages } from '../marketplace-operations';

const ids = {
  report: 'f0f0f0f0-1111-4111-8111-111111111111',
  message: 'f0f0f0f0-2222-4222-8222-222222222222',
  conversation: 'f0f0f0f0-3333-4333-8333-333333333333',
  business: 'f0f0f0f0-4444-4444-8444-444444444444',
  site: 'f0f0f0f0-5555-4555-8555-555555555555',
};

describe('marketplace trust queue contracts', () => {
  it('maps photo-only reports without exposing attachment paths', () => {
    const rows = mapReportedChatMessages([{ report_id: ids.report, report_state: 'open', report_reason: 'unsafe', report_detail: null, reported_at: '2026-08-01T00:00:00Z', message_public_id: ids.message, message_body: null, message_visibility: 'visible', message_moderation_version: 1, message_sent_at: '2026-08-01T00:00:00Z', sender_name: 'Member', sender_username: null, conversation_public_id: ids.conversation, business_id: ids.business, attachments: [{ storage_path: 'restricted/path' }] }]);
    expect(rows[0]).toMatchObject({ body: '[Photo attachment]', attachmentCount: 1, moderationVersion: 1 });
    expect(rows[0]).not.toHaveProperty('attachments');
  });

  it('rejects malformed chat and exact-site queue data', () => {
    expect(() => mapReportedChatMessages([{ report_id: 'bad' }])).toThrow();
    expect(() => mapPendingPickupSites([{ pickup_site_public_id: ids.site, business_id: ids.business, business_name: 'Kitchen', label: 'Library', site_kind: 'home', address_line: '1 Main', city: 'Austin', region: 'TX', postal_code: null, latitude: 30, longitude: -97, submitted_at: '2026-08-01T00:00:00Z' }])).toThrow('kind');
  });

  it('maps a bounded non-residential site', () => {
    expect(mapPendingPickupSites([{ pickup_site_public_id: ids.site, business_id: ids.business, business_name: 'Kitchen', label: 'Library', site_kind: 'public_meeting_place', address_line: '1 Main', city: 'Austin', region: 'TX', postal_code: null, latitude: 30, longitude: -97, submitted_at: '2026-08-01T00:00:00Z' }])[0]).toMatchObject({ publicId: ids.site, latitude: 30 });
  });
});
