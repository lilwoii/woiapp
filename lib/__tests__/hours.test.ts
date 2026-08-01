import { buildHours } from '@/lib/marketplace-api';

describe('marketplace hours', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('derives open status in the business timezone', () => {
    jest.setSystemTime(new Date('2026-07-27T10:00:00.000Z'));
    const result = buildHours(
      [
        {
          business_id: 'business-1',
          weekday: 1,
          opens_at: '09:00:00',
          closes_at: '17:00:00',
          is_closed: false,
        },
      ],
      [],
      'business-1',
      'UTC'
    );

    expect(result.status).toBe('open');
    expect(result.todayHours).toBe('9:00 AM–5:00 PM');
  });

  it('carries an overnight service window into the following day', () => {
    jest.setSystemTime(new Date('2026-07-27T01:00:00.000Z'));
    const result = buildHours(
      [
        {
          business_id: 'business-1',
          weekday: 0,
          opens_at: '20:00:00',
          closes_at: '02:00:00',
          is_closed: false,
        },
        {
          business_id: 'business-1',
          weekday: 1,
          opens_at: null,
          closes_at: null,
          is_closed: true,
        },
      ],
      [],
      'business-1',
      'UTC'
    );

    expect(result.status).toBe('open');
    expect(result.todayHours).toBe('Open until 2:00 AM');
  });

  it('lets special closures override recurring weekly hours', () => {
    jest.setSystemTime(new Date('2026-07-27T10:00:00.000Z'));
    const result = buildHours(
      [
        {
          business_id: 'business-1',
          weekday: 1,
          opens_at: '09:00:00',
          closes_at: '17:00:00',
          is_closed: false,
        },
      ],
      [
        {
          business_id: 'business-1',
          service_date: '2026-07-27',
          opens_at: null,
          closes_at: null,
          is_closed: true,
        },
      ],
      'business-1',
      'UTC'
    );

    expect(result.status).toBe('closed');
    expect(result.todayHours).toBe('Closed today');
  });
});
