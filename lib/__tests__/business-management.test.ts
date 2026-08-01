import {
  BusinessConfiguration,
  configurationReadiness,
  validateMenuConfiguration,
  validateMobileStopSchedule,
  validateSpecialHours,
  validateWeeklyHours,
} from '../business-management';

const completeHours = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  opensAt: weekday === 0 ? '' : '09:00',
  closesAt: weekday === 0 ? '' : '17:00',
  isClosed: weekday === 0,
  configured: true,
}));

const configuration: BusinessConfiguration = {
  business: {
    id: '74c00da5-6f88-46a7-a28b-704029a7cfa5',
    name: 'Test Kitchen',
    kind: 'restaurant',
    state: 'draft',
    verification: 'pending',
    role: 'owner',
    timezone: 'America/Los_Angeles',
  },
  location: {
    id: '5b8ec91e-5015-4f16-8973-df5b5ecb8561',
    isPrimary: true,
    label: 'Main entrance',
    addressLine: '100 Market Street',
    city: 'Los Angeles',
    region: 'CA',
    postalCode: '90012',
    latitude: 34.0522,
    longitude: -118.2437,
    shareStreetAddress: true,
    isApproximate: false,
  },
  locations: [],
  hours: completeHours,
  payments: ['cash'],
  menuSections: [
    {
      id: 'd5c6c87c-bf14-4415-a5d8-6d069f06c04d',
      name: 'Mains',
      isPublished: true,
      sortOrder: 0,
      items: [
        {
          id: '44855403-5344-4dd8-8879-f1c8bc24495a',
          name: 'Veggie bowl',
          description: 'Seasonal vegetables and rice.',
          priceMinor: 1200,
          availability: 'available',
          isPublished: true,
          sortOrder: 0,
        },
      ],
    },
  ],
  specialHours: [],
  mobileStops: [],
  submissionRequirements: {
    contacts: true,
    homeKitchenPermit: true,
  },
};

describe('business setup validation', () => {
  it('accepts a complete seven-day schedule, including overnight service', () => {
    const hours = completeHours.map((hour) =>
      hour.weekday === 5
        ? { ...hour, opensAt: '18:00', closesAt: '02:00', isClosed: false }
        : hour
    );

    expect(validateWeeklyHours(hours)).toEqual(hours);
  });

  it('rejects non-integer weekdays before sending them to the database', () => {
    const hours = completeHours.map((hour, index) =>
      index === 6 ? { ...hour, weekday: Number.NaN } : hour
    );

    expect(() => validateWeeklyHours(hours)).toThrow(
      'Confirm hours for all seven days'
    );
  });

  it('rejects duplicate menu item identifiers across sections', () => {
    const duplicateId = configuration.menuSections[0].items[0].id;
    const menu = [
      configuration.menuSections[0],
      {
        ...configuration.menuSections[0],
        id: 'f9347859-8b7c-4484-a3e8-d74dccf7d5ca',
        name: 'Drinks',
        items: [
          {
            ...configuration.menuSections[0].items[0],
            id: duplicateId,
            name: 'Lemonade',
          },
        ],
      },
    ];

    expect(() => validateMenuConfiguration(menu)).toThrow(
      'Each menu item must have a unique identifier'
    );
  });

  it('does not count hidden items as a publishable menu', () => {
    const hiddenOnly: BusinessConfiguration = {
      ...configuration,
      menuSections: configuration.menuSections.map((section) => ({
        ...section,
        items: section.items.map((item) => ({ ...item, availability: 'hidden' })),
      })),
    };

    expect(configurationReadiness(hiddenOnly).menu).toBe(false);
  });

  it('requires home-kitchen pins to stay approximate and private', () => {
    const unsafeHomeKitchen: BusinessConfiguration = {
      ...configuration,
      business: { ...configuration.business, kind: 'home_kitchen' },
      location: {
        ...configuration.location!,
        shareStreetAddress: true,
        isApproximate: false,
      },
    };

    expect(configurationReadiness(unsafeHomeKitchen).location).toBe(false);
  });

  it('rejects duplicate special-hour dates', () => {
    const entries = [
      {
        id: '99e06516-f1ba-47ad-a765-cea278937bfb',
        serviceDate: '2026-08-15',
        opensAt: '09:00',
        closesAt: '17:00',
        isClosed: false,
        note: '',
      },
      {
        id: 'af491761-147b-498d-983e-c8753e645acd',
        serviceDate: '2026-08-15',
        opensAt: '',
        closesAt: '',
        isClosed: true,
        note: 'Closed for maintenance',
      },
    ];

    expect(() => validateSpecialHours(entries, '2026-08-01')).toThrow(
      'only one special-hours entry'
    );
  });

  it('rejects overlapping mobile stops in the business time zone', () => {
    const stops = [
      {
        id: '8ad16fde-2a55-41f6-accc-129f1dac04c4',
        locationId: configuration.location!.id!,
        startsOn: '2026-08-02',
        startsAt: '10:00',
        endsOn: '2026-08-02',
        endsAt: '14:00',
      },
      {
        id: '0828bc53-1854-4a1e-881b-4878f63e9d28',
        locationId: configuration.location!.id!,
        startsOn: '2026-08-02',
        startsAt: '13:00',
        endsOn: '2026-08-02',
        endsAt: '16:00',
      },
    ];

    expect(() =>
      validateMobileStopSchedule(
        stops,
        configuration.business.timezone,
        new Date('2026-08-01T00:00:00.000Z')
      )
    ).toThrow('cannot overlap');
  });

  it('rejects a stop time skipped by daylight-saving time', () => {
    const stop = {
      id: '52f380ee-417b-4ab9-98f7-1c0a53bfe30b',
      locationId: configuration.location!.id!,
      startsOn: '2026-03-08',
      startsAt: '02:30',
      endsOn: '2026-03-08',
      endsAt: '04:00',
    };

    expect(() =>
      validateMobileStopSchedule(
        [stop],
        configuration.business.timezone,
        new Date('2026-03-01T00:00:00.000Z')
      )
    ).toThrow('daylight-saving');
  });

  it('rejects an ambiguous stop time during the fall clock change', () => {
    const stop = {
      id: '263ae7fc-6ad4-4ffd-9a67-c4a8fa2884c3',
      locationId: configuration.location!.id!,
      startsOn: '2026-11-01',
      startsAt: '01:30',
      endsOn: '2026-11-01',
      endsAt: '03:00',
    };

    expect(() =>
      validateMobileStopSchedule(
        [stop],
        configuration.business.timezone,
        new Date('2026-10-20T00:00:00.000Z')
      )
    ).toThrow('ambiguous');
  });
});
