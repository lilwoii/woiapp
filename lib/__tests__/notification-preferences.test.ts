import {
  canonicalIanaTimeZone,
  quietHoursForPreset,
  summarizeFollowAlertPreferences,
  type FollowNotificationPreference,
} from '../notification-preferences';

function preference(
  businessId: string,
  overrides: Partial<FollowNotificationPreference> = {},
): FollowNotificationPreference {
  return {
    businessId,
    liveNearby: false,
    locationChange: false,
    ownerUpdate: false,
    menuReturn: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timeZone: null,
    ...overrides,
  };
}

describe('notification preferences', () => {
  it('accepts runtime-supported IANA zones and rejects offsets or malformed values', () => {
    expect(canonicalIanaTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(canonicalIanaTimeZone('UTC')).toBe('UTC');
    expect(canonicalIanaTimeZone('Etc/GMT+7')).toBe('Etc/GMT+7');
    expect(canonicalIanaTimeZone('PDT')).toBeNull();
    expect(canonicalIanaTimeZone('-07:00')).toBeNull();
    expect(canonicalIanaTimeZone('+05:30')).toBeNull();
    expect(canonicalIanaTimeZone('-0700')).toBeNull();
    expect(canonicalIanaTimeZone('+05')).toBeNull();
    expect(canonicalIanaTimeZone(' America/Los_Angeles')).toBeNull();
    expect(canonicalIanaTimeZone('Not/A_Zone')).toBeNull();
  });

  it('requires a verified timezone for active presets but always allows clearing', () => {
    expect(quietHoursForPreset('off', null)).toEqual({
      ok: true,
      data: { presetId: 'off', start: null, end: null, timeZone: null },
    });
    expect(quietHoursForPreset('night_22_07', null)).toEqual({
      ok: false,
      reason: 'Your current timezone could not be verified. Quiet hours were not changed.',
    });
    expect(quietHoursForPreset('night_22_07', '-07:00')).toEqual({
      ok: false,
      reason: 'Your current timezone could not be verified. Quiet hours were not changed.',
    });
    expect(quietHoursForPreset('night_22_07', 'America/Los_Angeles')).toEqual({
      ok: true,
      data: {
        presetId: 'night_22_07',
        start: '22:00',
        end: '07:00',
        timeZone: 'America/Los_Angeles',
      },
    });
  });

  it('reports per-business alert differences instead of flattening them', () => {
    const summary = summarizeFollowAlertPreferences(['a', 'b'], [
      preference('a', {
        locationChange: true,
        ownerUpdate: true,
        menuReturn: true,
      }),
      preference('b', { ownerUpdate: true }),
    ]);

    expect(summary.ownerUpdates).toBe(false);
    expect(summary.ownerUpdatesState).toBe('some');
    expect(summary.businesses).toHaveLength(2);
    expect(summary.businesses[0].ownerUpdate).toBe(true);
    expect(summary.businesses[1].locationChange).toBe(false);
  });

  it('recognizes uniform presets and treats missing or differing rows as mixed', () => {
    const overnight = {
      quietHoursStart: '22:00:00',
      quietHoursEnd: '07:00:00',
      timeZone: 'America/Los_Angeles',
    };
    expect(summarizeFollowAlertPreferences(['a', 'b'], [
      preference('a', overnight),
      preference('b', overnight),
    ]).quietHours).toEqual({
      state: 'uniform',
      presetId: 'night_22_07',
      start: '22:00',
      end: '07:00',
      timeZone: 'America/Los_Angeles',
    });

    expect(summarizeFollowAlertPreferences(['a', 'b'], [
      preference('a', overnight),
    ]).quietHours).toEqual({
      state: 'mixed',
      presetId: 'mixed',
      start: null,
      end: null,
      timeZone: null,
    });

    expect(summarizeFollowAlertPreferences(['a'], [
      preference('a', {
        quietHoursStart: '22:00:00',
        quietHoursEnd: '22:00:00',
        timeZone: 'UTC',
      }),
    ]).quietHours).toEqual({
      state: 'uniform',
      presetId: 'custom',
      start: '22:00',
      end: '22:00',
      timeZone: 'UTC',
    });
  });
});
