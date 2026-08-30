export const QUIET_HOURS_PRESETS = [
  {
    id: 'off',
    label: 'Off',
    detail: 'No quiet schedule',
    start: null,
    end: null,
  },
  {
    id: 'night_22_07',
    label: '10 PM–7 AM',
    detail: 'A balanced overnight window',
    start: '22:00',
    end: '07:00',
  },
  {
    id: 'early_21_07',
    label: '9 PM–7 AM',
    detail: 'Start quiet time a little earlier',
    start: '21:00',
    end: '07:00',
  },
  {
    id: 'late_23_08',
    label: '11 PM–8 AM',
    detail: 'A later overnight window',
    start: '23:00',
    end: '08:00',
  },
] as const;

export type QuietHoursPresetId = (typeof QUIET_HOURS_PRESETS)[number]['id'];
export type NotificationPreferenceState = 'none' | 'some' | 'all';

export type FollowNotificationPreference = {
  businessId: string;
  liveNearby: boolean;
  locationChange: boolean;
  ownerUpdate: boolean;
  menuReturn: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timeZone: string | null;
};

export type QuietHoursSummary = {
  state: 'off' | 'uniform' | 'mixed';
  presetId: QuietHoursPresetId | 'custom' | 'mixed';
  start: string | null;
  end: string | null;
  timeZone: string | null;
};

export type FollowAlertPreferenceSummary = {
  liveNearby: boolean;
  ownerUpdates: boolean;
  ownerUpdatesState: NotificationPreferenceState;
  quietHours: QuietHoursSummary;
  businesses: FollowNotificationPreference[];
};

export type QuietHoursUpdate = {
  presetId: QuietHoursPresetId;
  start: string | null;
  end: string | null;
  timeZone: string | null;
};

const DATABASE_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,6})?)?$/;

function normalizeDatabaseTime(value: string | null): string | null {
  if (value === null) return null;
  const match = DATABASE_TIME.exec(value);
  return match ? `${match[1]}:${match[2]}` : null;
}

export function canonicalIanaTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || value.trim() !== value) {
    return null;
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone;
    return canonical && canonical.length <= 64 ? canonical : null;
  } catch {
    return null;
  }
}

export function currentIanaTimeZone(): string | null {
  try {
    return canonicalIanaTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

export function quietHoursForPreset(
  presetId: QuietHoursPresetId,
  timeZone: string | null,
): { ok: true; data: QuietHoursUpdate } | { ok: false; reason: string } {
  const preset = QUIET_HOURS_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return { ok: false, reason: 'Choose a valid quiet-hours preset.' };
  if (preset.start === null) {
    return {
      ok: true,
      data: { presetId, start: null, end: null, timeZone: null },
    };
  }
  const canonicalTimeZone = canonicalIanaTimeZone(timeZone);
  if (!canonicalTimeZone) {
    return {
      ok: false,
      reason: 'Your current timezone could not be verified. Quiet hours were not changed.',
    };
  }
  return {
    ok: true,
    data: {
      presetId,
      start: preset.start,
      end: preset.end,
      timeZone: canonicalTimeZone,
    },
  };
}

export function quietHoursSummaryForUpdate(update: QuietHoursUpdate): QuietHoursSummary {
  return update.start === null
    ? { state: 'off', presetId: 'off', start: null, end: null, timeZone: null }
    : {
        state: 'uniform',
        presetId: update.presetId,
        start: update.start,
        end: update.end,
        timeZone: update.timeZone,
      };
}

function emptyPreference(businessId: string): FollowNotificationPreference {
  return {
    businessId,
    liveNearby: false,
    locationChange: false,
    ownerUpdate: false,
    menuReturn: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timeZone: null,
  };
}

function ownerPreferenceState(preference: FollowNotificationPreference): NotificationPreferenceState {
  const values = [
    preference.locationChange,
    preference.ownerUpdate,
    preference.menuReturn,
  ];
  if (values.every(Boolean)) return 'all';
  if (values.every((value) => !value)) return 'none';
  return 'some';
}

function summarizeQuietHours(preferences: FollowNotificationPreference[]): QuietHoursSummary {
  if (!preferences.length) {
    return { state: 'off', presetId: 'off', start: null, end: null, timeZone: null };
  }
  const schedules: {
    valid: boolean;
    key: string;
    start: string | null;
    end: string | null;
    timeZone: string | null;
    presetId: QuietHoursPresetId | 'custom';
  }[] = preferences.map((preference) => {
    const start = normalizeDatabaseTime(preference.quietHoursStart);
    const end = normalizeDatabaseTime(preference.quietHoursEnd);
    if (preference.quietHoursStart === null && preference.quietHoursEnd === null) {
      return {
        valid: true,
        key: 'off',
        start: null,
        end: null,
        timeZone: null,
        presetId: 'off' as const,
      };
    }
    if (!start || !end) {
      return {
        valid: false,
        key: `invalid:${preference.businessId}`,
        start,
        end,
        timeZone: null,
        presetId: 'custom' as const,
      };
    }
    const timeZone = preference.timeZone === null
      ? null
      : canonicalIanaTimeZone(preference.timeZone);
    if (preference.timeZone !== null && timeZone === null) {
      return {
        valid: false,
        key: `invalid:${preference.businessId}`,
        start,
        end,
        timeZone: null,
        presetId: 'custom' as const,
      };
    }
    const matchingPreset = QUIET_HOURS_PRESETS.find(
      (preset) => preset.start === start && preset.end === end,
    );
    return {
      valid: true,
      key: `${start}|${end}|${timeZone ?? ''}`,
      start,
      end,
      timeZone,
      presetId: matchingPreset?.id ?? 'custom',
    };
  });
  const first = schedules[0];
  if (!first.valid || schedules.some((schedule) => !schedule.valid || schedule.key !== first.key)) {
    return { state: 'mixed', presetId: 'mixed', start: null, end: null, timeZone: null };
  }
  if (first.key === 'off') {
    return { state: 'off', presetId: 'off', start: null, end: null, timeZone: null };
  }
  return {
    state: 'uniform',
    presetId: first.presetId,
    start: first.start,
    end: first.end,
    timeZone: first.timeZone,
  };
}

export function summarizeFollowAlertPreferences(
  businessIds: readonly string[],
  rows: readonly FollowNotificationPreference[],
): FollowAlertPreferenceSummary {
  const requestedIds = [...new Set(businessIds)];
  const byBusiness = new Map(rows.map((row) => [row.businessId, row]));
  const businesses = requestedIds.map(
    (businessId) => byBusiness.get(businessId) ?? emptyPreference(businessId),
  );
  const ownerStates = businesses.map(ownerPreferenceState);
  const ownerUpdatesState: NotificationPreferenceState = ownerStates.length > 0 && ownerStates.every(
    (state) => state === 'all',
  )
    ? 'all'
    : ownerStates.every((state) => state === 'none')
      ? 'none'
      : 'some';

  return {
    liveNearby: businesses.length > 0 && businesses.every((preference) => preference.liveNearby),
    ownerUpdates: ownerUpdatesState === 'all',
    ownerUpdatesState,
    quietHours: summarizeQuietHours(businesses),
    businesses,
  };
}
