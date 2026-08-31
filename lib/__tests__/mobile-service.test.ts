import {
  earliestMovingServiceBoundary,
  expireMovingServiceStates,
  movingServiceFromPublicRow,
} from '@/lib/mobile-service';
import type { Place } from '@/types/marketplace';

const businessId = '11111111-1111-4111-8111-111111111111';
const locationId = '22222222-2222-4222-8222-222222222222';
const now = Date.parse('2026-08-30T18:00:00.000Z');

const publicMovingRow = {
  business_id: businessId,
  mobility_state: 'moving_to_next_location',
  next_stop_location_id: locationId,
  next_stop_address_line: '1200 Market Street',
  next_stop_city: 'San Francisco',
  next_stop_region: 'CA',
  next_stop_postal_code: '94102',
  next_stop_starts_at: '2026-08-30T20:00:00.000Z',
  next_stop_ends_at: '2026-08-30T23:00:00.000Z',
  is_approximate: false,
};

describe('public mobile service projection', () => {
  it('maps a future exact public stop into the moving treatment', () => {
    expect(
      movingServiceFromPublicRow(
        publicMovingRow,
        businessId,
        'America/Los_Angeles',
        now,
      ),
    ).toEqual({
      state: 'moving_to_next_location',
      label: 'Moving to next location',
      nextStop: {
        locationId,
        address: '1200 Market Street',
        city: 'San Francisco',
        region: 'CA',
        postalCode: '94102',
        startsAt: '2026-08-30T20:00:00.000Z',
        endsAt: '2026-08-30T23:00:00.000Z',
        timeWindow: 'Sun, Aug 30 · 1:00 PM–4:00 PM PDT',
      },
    });
  });

  it.each([
    [{ ...publicMovingRow, business_id: '33333333-3333-4333-8333-333333333333' }],
    [{ ...publicMovingRow, is_approximate: true }],
    [{ ...publicMovingRow, next_stop_address_line: null }],
    [{ ...publicMovingRow, next_stop_starts_at: '2026-08-30T17:59:00.000Z' }],
    [{ ...publicMovingRow, mobility_state: 'live_tracking' }],
  ])('rejects unsafe or stale public projections', (row) => {
    expect(
      movingServiceFromPublicRow(row, businessId, 'America/Los_Angeles', now),
    ).toBeUndefined();
  });

  it('selects every place at the earliest authoritative moving-state boundary', () => {
    const first = movingServiceFromPublicRow(
      publicMovingRow,
      businessId,
      'America/Los_Angeles',
      now,
    );
    const secondBusinessId = '33333333-3333-4333-8333-333333333333';
    const second = movingServiceFromPublicRow(
      { ...publicMovingRow, business_id: secondBusinessId },
      secondBusinessId,
      'America/Los_Angeles',
      now,
    );
    const laterBusinessId = '44444444-4444-4444-8444-444444444444';
    const later = movingServiceFromPublicRow(
      {
        ...publicMovingRow,
        business_id: laterBusinessId,
        next_stop_starts_at: '2026-08-30T21:00:00.000Z',
      },
      laterBusinessId,
      'America/Los_Angeles',
      now,
    );

    expect(earliestMovingServiceBoundary([
      { id: laterBusinessId, mobility: later },
      { id: secondBusinessId, mobility: second },
      { id: businessId, mobility: first },
      { id: 'not-a-public-business-id', mobility: first },
    ])).toEqual({
      startsAtMs: Date.parse('2026-08-30T20:00:00.000Z'),
      placeIds: [businessId, secondBusinessId],
    });
    expect(earliestMovingServiceBoundary([{ id: businessId, mobility: undefined }])).toBeNull();
  });

  it('locally suppresses an elapsed destination after bounded refresh failure', () => {
    const places = [{
      id: businessId,
      mobility: movingServiceFromPublicRow(
        publicMovingRow,
        businessId,
        'America/Los_Angeles',
        now,
      ),
    }] as unknown as Place[];

    expect(expireMovingServiceStates(
      places,
      Date.parse('2026-08-30T19:59:59.000Z'),
      new Set([businessId]),
    )).toBe(places);
    expect(expireMovingServiceStates(
      places,
      Date.parse('2026-08-30T20:00:00.000Z'),
      new Set([businessId]),
    )[0].mobility).toBeUndefined();
  });
});
