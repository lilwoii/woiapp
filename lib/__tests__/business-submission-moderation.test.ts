import {
  mapPendingBusinessSubmissionPage,
  mapPendingMobileSubmission,
  validateMobileReviewSelection,
} from '@/lib/business-submission-moderation';

const ids = {
  business: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  primary: '33333333-3333-4333-8333-333333333333',
  secondary: '44444444-4444-4444-8444-444444444444',
  other: '55555555-5555-4555-8555-555555555555',
  firstStop: '66666666-6666-4666-8666-666666666666',
  secondStop: '77777777-7777-4777-8777-777777777777',
};

function mobileDetail() {
  return mapPendingMobileSubmission({
    business_id: ids.business,
    business_name: 'Careful Routes',
    kind: 'food_truck',
    state: 'pending',
    locations: [
      {
        id: ids.primary,
        label: 'Primary route',
        address_line: '1 Market Street',
        city: 'Los Angeles',
        region: 'CA',
        postal_code: '90001',
        latitude: 34.05,
        longitude: -118.24,
        is_primary: true,
        is_approximate: false,
        public_address: true,
        publication_state: 'private',
      },
      {
        id: ids.secondary,
        label: 'Evening market',
        address_line: null,
        city: 'Los Angeles',
        region: 'CA',
        postal_code: null,
        latitude: 34.06,
        longitude: -118.25,
        is_primary: false,
        is_approximate: true,
        public_address: false,
        publication_state: 'private',
      },
    ],
    draft_stops: [
      {
        id: ids.firstStop,
        location_id: ids.secondary,
        starts_at: '2030-01-01T18:00:00.000Z',
        ends_at: '2030-01-01T20:00:00.000Z',
        state: 'draft',
      },
      {
        id: ids.secondStop,
        location_id: ids.primary,
        starts_at: '2030-01-01T19:00:00.000Z',
        ends_at: '2030-01-01T21:00:00.000Z',
        state: 'draft',
      },
    ],
  });
}

describe('business submission moderation contracts', () => {
  test('maps the protected queue into bounded launch-readiness fields', () => {
    const page = mapPendingBusinessSubmissionPage([
      {
        business_id: ids.business,
        business_name: 'Careful Routes',
        kind: 'food_truck',
        verification: 'pending',
        owner_public_ids: [ids.owner],
        submitted_at: '2030-01-01T12:00:00.000Z',
        has_more: true,
        submission_snapshot: {
          description: 'A reviewed route.',
          cuisine_labels: ['Tacos'],
          price_level: 2,
          timezone: 'America/Los_Angeles',
          location_count: 2,
          weekly_day_count: 7,
          payments: ['cash', 'card'],
          published_menu_item_count: 4,
          logo: { quarantine_state: 'clean', moderation: 'approved' },
          contacts: {
            legal_name: 'Careful Routes LLC',
            business_email: 'owner@example.invalid',
            business_phone: '+12135550110',
            website_url: null,
            show_phone_public: false,
            show_website_public: false,
          },
        },
      },
    ]);

    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(1);
    expect(page.items[0]).toMatchObject({
      businessId: ids.business,
      logoReady: true,
      locationCount: 2,
      weeklyDayCount: 7,
      publishedMenuItemCount: 4,
      contact: { email: 'owner@example.invalid', phone: '+12135550110' },
    });
  });

  test('requires exactly one primary location in a mobile detail response', () => {
    expect(() => mapPendingMobileSubmission({
      business_id: ids.business,
      business_name: 'Invalid Routes',
      kind: 'food_truck',
      state: 'pending',
      locations: [],
      draft_stops: [],
    })).toThrow('Invalid primary mobile location');
  });

  test('defaults to a valid primary-only selection with no stops', () => {
    expect(validateMobileReviewSelection(mobileDetail(), [ids.primary], [])).toEqual({ ok: true });
  });

  test('requires the primary and each selected stop location', () => {
    expect(validateMobileReviewSelection(mobileDetail(), [ids.secondary], [])).toEqual({
      ok: false,
      reason: 'The primary location must be approved.',
    });
    expect(validateMobileReviewSelection(mobileDetail(), [ids.primary], [ids.firstStop])).toEqual({
      ok: false,
      reason: 'Approve a stop’s location before approving the stop.',
    });
  });

  test('rejects overlapping initial stop selections before the server call', () => {
    expect(validateMobileReviewSelection(
      mobileDetail(),
      [ids.primary, ids.secondary],
      [ids.firstStop, ids.secondStop],
    )).toEqual({ ok: false, reason: 'Approved stop times cannot overlap.' });
  });

  test('rejects unknown and duplicate selections', () => {
    expect(validateMobileReviewSelection(mobileDetail(), [ids.primary, ids.primary], [])).toEqual({
      ok: false,
      reason: 'Choose each approved location only once.',
    });
    expect(validateMobileReviewSelection(mobileDetail(), [ids.primary, ids.other], [])).toEqual({
      ok: false,
      reason: 'A selected location is no longer part of this submission.',
    });
  });
});
