import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { OwnerUpdate } from '@/components/owner-update';
import { PageShell } from '@/components/page-shell';
import { PlaceCard } from '@/components/place-card';
import { SectionHeading } from '@/components/section-heading';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { featureFlags, filterHomeKitchenPlaces } from '@/lib/features';
import {
  currentIanaTimeZone,
  QUIET_HOURS_PRESETS,
  quietHoursForPreset,
  quietHoursSummaryForUpdate,
  type NotificationPreferenceState,
  type QuietHoursPresetId,
  type QuietHoursSummary,
} from '@/lib/notification-preferences';
import {
  registerPushNotificationDevice,
  revokeAllPushNotificationDevices,
  revokePushNotificationDevice,
} from '@/lib/push-notifications';
import {
  fetchFollowAlertPreferences,
  updateFollowAlertPreference,
  updateFollowQuietHours,
} from '@/lib/marketplace-api';

type SavedFilter = 'all' | 'food_truck' | 'restaurant';
type AlertPreference = 'owner_bundle';
type PreferenceOperation = AlertPreference | 'quiet_hours';

const QUIET_HOURS_OFF: QuietHoursSummary = {
  state: 'off',
  presetId: 'off',
  start: null,
  end: null,
  timeZone: null,
};

export default function SavedScreen() {
  const { followedIds, places, publicPlaces, toggleFollow } = useMarketplaceStore();
  const auth = useAuth();
  const accountId = auth.status === 'authenticated' ? auth.account?.id : undefined;
  const [filter, setFilter] = useState<SavedFilter>('all');
  const [ownerUpdatesState, setOwnerUpdatesState] = useState<NotificationPreferenceState>('none');
  const [quietHours, setQuietHours] = useState<QuietHoursSummary>(QUIET_HOURS_OFF);
  const [loadedPreferenceScope, setLoadedPreferenceScope] = useState<string | null>(null);
  const [preferenceBusy, setPreferenceBusy] = useState<PreferenceOperation | 'loading' | null>(null);
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryMessage, setDeliveryMessage] = useState('');
  const preferenceGeneration = useRef(0);
  const deliveryGeneration = useRef(0);
  const nativePushDeliveryAvailable =
    featureFlags.pushNotifications && (Platform.OS === 'ios' || Platform.OS === 'android');
  const deviceTimeZone = useMemo(() => currentIanaTimeZone(), []);

  const followedKey = [...followedIds].sort().join(',');
  const hasFollowedPlaces = followedIds.length > 0;
  const preferenceScope = accountId && hasFollowedPlaces ? `${accountId}:${followedKey}` : null;
  const preferenceContext = useRef({ accountId, followedKey, preferenceScope });
  const preferenceIsCurrent =
    Boolean(preferenceScope) &&
    loadedPreferenceScope === preferenceScope &&
    preferenceBusy !== 'loading';
  const visibleOwnerUpdatesState = preferenceIsCurrent ? ownerUpdatesState : 'none';
  const visibleOwnerUpdates = visibleOwnerUpdatesState !== 'none';
  const visibleQuietHours = preferenceIsCurrent ? quietHours : QUIET_HOURS_OFF;

  useEffect(() => {
    preferenceContext.current = { accountId, followedKey, preferenceScope };
  }, [accountId, followedKey, preferenceScope]);

  useEffect(() => {
    const generation = ++preferenceGeneration.current;
    let active = true;
    const requestedAccountId = accountId ?? '';
    const requestedFollowedIds = [...followedIds];
    const requestedScope = `${requestedAccountId}:${followedKey}`;
    const timer = setTimeout(() => {
      if (!active || generation !== preferenceGeneration.current) return;
      if (!auth.isConfigured || !accountId || !hasFollowedPlaces) {
        setLoadedPreferenceScope(null);
        setPreferenceBusy(null);
        if (!hasFollowedPlaces) setPreferenceMessage('');
        return;
      }
      setLoadedPreferenceScope(null);
      setPreferenceBusy('loading');
      setPreferenceMessage('');
      void fetchFollowAlertPreferences(requestedFollowedIds, requestedAccountId).then((result) => {
        if (!active || generation !== preferenceGeneration.current) return;
        if (result.ok && result.data) {
          setOwnerUpdatesState(result.data.ownerUpdatesState);
          setQuietHours(result.data.quietHours);
          setLoadedPreferenceScope(requestedScope);
        } else if (!result.ok) {
          setPreferenceMessage(result.reason);
        }
        setPreferenceBusy(null);
      });
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // The stable key prevents a new request when only the array identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, auth.isConfigured, followedKey, hasFollowedPlaces]);

  useEffect(() => {
    deliveryGeneration.current += 1;
    const timer = setTimeout(() => {
      setDeliveryBusy(false);
      setDeliveryMessage('');
    }, 0);
    return () => clearTimeout(timer);
  }, [accountId, auth.assuranceLevel, auth.securityStatus]);

  const savePreference = async (field: AlertPreference, next: boolean) => {
    if (auth.isConfigured && auth.status !== 'authenticated') {
      router.push('/auth');
      return;
    }

    if (!accountId) {
      router.push('/auth');
      return;
    }
    const requestedScope = preferenceScope;
    if (!requestedScope) return;
    const requestedAccountId = accountId;
    const requestedFollowedIds = [...followedIds];
    const generation = ++preferenceGeneration.current;
    const previous = visibleOwnerUpdatesState;
    setOwnerUpdatesState(next ? 'all' : 'none');
    setLoadedPreferenceScope(requestedScope);
    setPreferenceBusy(field);
    setPreferenceMessage('');

    const result = await updateFollowAlertPreference(
      requestedFollowedIds,
      field,
      next,
      requestedAccountId,
    );
    if (
      generation !== preferenceGeneration.current ||
      preferenceContext.current.preferenceScope !== requestedScope
    ) return;
    if (!result.ok) {
      setOwnerUpdatesState(previous);
      setPreferenceMessage(result.reason);
    } else {
      setPreferenceMessage(
        featureFlags.pushNotifications
          ? 'Alert preferences saved.'
          : 'Preferences saved. Delivery activates when secure push notifications are connected.'
      );
    }
    setPreferenceBusy(null);
  };

  const saveQuietHours = async (presetId: QuietHoursPresetId) => {
    if (auth.isConfigured && auth.status !== 'authenticated') {
      router.push('/auth');
      return;
    }
    if (!accountId) {
      router.push('/auth');
      return;
    }
    const requestedScope = preferenceScope;
    if (!requestedScope) return;
    const schedule = quietHoursForPreset(presetId, deviceTimeZone);
    if (!schedule.ok) {
      setPreferenceMessage(schedule.reason);
      return;
    }
    const requestedAccountId = accountId;
    const requestedFollowedIds = [...followedIds];
    const generation = ++preferenceGeneration.current;
    const previous = visibleQuietHours;
    setQuietHours(quietHoursSummaryForUpdate(schedule.data));
    setLoadedPreferenceScope(requestedScope);
    setPreferenceBusy('quiet_hours');
    setPreferenceMessage('');

    const result = await updateFollowQuietHours(
      requestedFollowedIds,
      presetId,
      deviceTimeZone,
      requestedAccountId,
    );
    if (
      generation !== preferenceGeneration.current ||
      preferenceContext.current.preferenceScope !== requestedScope
    ) return;
    if (!result.ok) {
      setQuietHours(previous);
      setPreferenceMessage(result.reason);
    } else {
      setPreferenceMessage(
        featureFlags.pushNotifications
          ? 'Quiet hours saved for the places you follow.'
          : 'Quiet hours saved to your account. Device push remains off for this release.'
      );
    }
    setPreferenceBusy(null);
  };

  const changeDeviceDelivery = async (mode: 'enable' | 'disable_device' | 'unsubscribe') => {
    if (auth.status !== 'authenticated' || !auth.account?.id) {
      router.push('/auth');
      return;
    }
    if (auth.assuranceLevel !== 'aal2') {
      setDeliveryMessage('Verify a current authenticator code in Security first.');
      router.push('/security');
      return;
    }
    const requestedAccountId = auth.account.id;
    const generation = ++deliveryGeneration.current;
    setDeliveryBusy(true);
    setDeliveryMessage('');
    const result = mode === 'enable'
      ? await registerPushNotificationDevice(requestedAccountId)
      : mode === 'disable_device'
        ? await revokePushNotificationDevice(requestedAccountId)
        : await revokeAllPushNotificationDevices(requestedAccountId);
    if (
      generation !== deliveryGeneration.current ||
      preferenceContext.current.accountId !== requestedAccountId
    ) return;
    setDeliveryMessage(result.ok ? result.message ?? 'Device alert setting updated.' : result.reason);
    setDeliveryBusy(false);
  };

  const followed = useMemo(
    () =>
      filterHomeKitchenPlaces(places).filter(
        (place) =>
          followedIds.includes(place.id) &&
          (filter === 'all' || (filter === 'restaurant' ? place.category !== 'food_truck' : place.category === filter))
      ),
    [filter, followedIds, places]
  );

  const followedWithUpdates = followed.filter((place) => place.update);
  const recommendations = publicPlaces
    .filter((place) => !followedIds.includes(place.id))
    .sort((a, b) => b.trendingScore - a.trendingScore)
    .slice(0, 3);

  return (
    <FocusAwareScreen>
      <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell>
        <View style={styles.topbar}>
          <BrandMark />
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{followedIds.length} following</Text>
          </View>
        </View>

        <View style={styles.hero}>
          <Text style={styles.kicker}>Your food radar</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Saved places, live signals.
          </Text>
          <Text style={styles.subtitle}>
            Follow the businesses you care about and choose exactly which updates deserve your attention.
          </Text>
        </View>

        {followedWithUpdates.length ? (
          <View style={styles.livePanel}>
            <View style={styles.liveHeader}>
              <View style={styles.liveDot} />
              <Text style={styles.liveTitle}>New from places you follow</Text>
            </View>
            <View style={styles.updateList}>
              {followedWithUpdates.map((place) =>
                place.update ? (
                  <View key={place.id} style={styles.updateItem}>
                    <View style={styles.updateBusinessRow}>
                      <Text style={styles.updateBusiness}>{place.name}</Text>
                      {place.distanceMiles !== null ? (
                        <Text style={styles.updateDistance}>{place.distanceMiles.toFixed(1)} mi</Text>
                      ) : null}
                    </View>
                    <OwnerUpdate dark update={place.update} />
                  </View>
                ) : null
              )}
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeading
            detail="Keep trucks and neighborhood spots close at hand."
            eyebrow="Following"
            title="Your saved places"
          />
          <View
            accessibilityLabel="Saved place category"
            accessibilityRole="radiogroup"
            style={styles.filterRow}>
            {(
              [
                ['all', 'All'],
                ['food_truck', 'Food trucks'],
                ['restaurant', 'Other places'],
              ] as [SavedFilter, string][]
            ).map(([id, label]) => (
              <Pressable
                accessibilityRole="radio"
                aria-checked={filter === id}
                accessibilityState={{ checked: filter === id }}
                key={id}
                onPress={() => setFilter(id)}
                style={[styles.filterChip, filter === id && styles.filterChipActive]}>
                <Text style={[styles.filterText, filter === id && styles.filterTextActive]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {followed.length ? (
            <View style={styles.placeList}>
              {followed.map((place) => (
                <PlaceCard
                  followed
                  key={place.id}
                  onToggleFollow={toggleFollow}
                  place={place}
                />
              ))}
            </View>
          ) : (
            <View style={styles.empty}>
              <FontAwesome6 color={palette.accent} name="heart" size={22} />
              <Text style={styles.emptyTitle}>Nothing saved in this category</Text>
              <Text style={styles.emptyBody}>Tap the heart on any listing to keep it here.</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/')}
                style={styles.emptyAction}>
                <Text style={styles.emptyActionText}>Browse nearby</Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={styles.preferencePanel}>
          <SectionHeading
            detail="Business choices and quiet hours are saved to your account. Delivery on this device is separate."
            eyebrow="Notifications"
            title="Alert settings"
          />
          <View style={styles.deliveryRow}>
            <View style={styles.preferenceIcon}>
              <FontAwesome6 color={palette.accent} name="bell" size={14} />
            </View>
            <View style={styles.preferenceCopy}>
              <Text style={styles.preferenceTitle}>This device</Text>
              <Text style={styles.preferenceDetail}>
                {nativePushDeliveryAvailable
                  ? 'Enable push for this signed device. Only product updates from places you follow are included.'
                  : Platform.OS === 'web' && featureFlags.pushNotifications
                    ? 'Web push is not available in this release. Account preferences below are still saved.'
                    : 'Push delivery is disabled for this release. Account preferences below are still saved.'}
              </Text>
            </View>
            {nativePushDeliveryAvailable ? (
              <Pressable
                accessibilityRole="button"
                disabled={deliveryBusy}
                onPress={() => void changeDeviceDelivery('enable')}
                style={({ pressed }) => [styles.deliveryAction, pressed && styles.deliveryActionPressed]}>
                <Text style={styles.deliveryActionText}>{deliveryBusy ? 'Working…' : 'Enable device'}</Text>
              </Pressable>
            ) : (
              <View style={styles.inAppBadge}>
                <Text style={styles.inAppBadgeText}>Push off</Text>
              </View>
            )}
          </View>
          {nativePushDeliveryAvailable ? (
            <View style={styles.deliveryDisableRow}>
              <Pressable
                accessibilityRole="button"
                disabled={deliveryBusy}
                onPress={() => void changeDeviceDelivery('disable_device')}
                style={styles.deliveryDisable}>
                <Text style={styles.deliveryDisableText}>Remove this device</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={deliveryBusy}
                onPress={() => void changeDeviceDelivery('unsubscribe')}
                style={styles.deliveryDisable}>
                <Text style={styles.deliveryDisableText}>Turn off account delivery</Text>
              </Pressable>
            </View>
          ) : null}
          {deliveryMessage ? (
            <Text accessibilityLiveRegion="polite" style={styles.preferenceStatus}>
              {deliveryMessage}
            </Text>
          ) : null}
          <View style={styles.preferenceRow}>
            <View style={styles.preferenceIcon}>
              <FontAwesome6 color={palette.accent} name="bullhorn" size={14} />
            </View>
            <View style={styles.preferenceCopy}>
              <Text style={styles.preferenceTitle}>Places you follow</Text>
              <Text style={styles.preferenceDetail}>
                {visibleOwnerUpdatesState === 'all'
                  ? 'All followed places can send location changes, menu returns, and owner updates. Turning this off applies to all.'
                  : visibleOwnerUpdatesState === 'some'
                    ? 'Some followed places or alert types are on. Changing this switch applies the new choice to all.'
                    : 'Location changes, menu returns, and owner updates are off for every followed place.'}
              </Text>
            </View>
            <Switch
              accessibilityHint="Changing this switch updates every followed business."
              accessibilityLabel={`Account alerts for every followed business: ${visibleOwnerUpdatesState}`}
              accessibilityValue={{ text: visibleOwnerUpdatesState }}
              disabled={preferenceBusy !== null || followedIds.length === 0}
              onValueChange={(next) => void savePreference('owner_bundle', next)}
              thumbColor="#FFFFFF"
              trackColor={{ false: palette.line, true: palette.success }}
              value={visibleOwnerUpdates}
            />
          </View>
          <View style={styles.quietHoursSection}>
            <View style={styles.quietHoursHeader}>
              <View style={styles.preferenceIcon}>
                <FontAwesome6 color={palette.accentDeep} name="moon" size={14} />
              </View>
              <View style={styles.preferenceCopy}>
                <Text style={styles.preferenceTitle}>Quiet hours</Text>
                <Text style={styles.preferenceDetail}>
                  {visibleQuietHours.state === 'mixed'
                    ? 'Schedules currently vary by place. A preset aligns quiet hours without changing any business alert types.'
                    : visibleQuietHours.presetId === 'custom'
                      ? `A custom ${visibleQuietHours.start}–${visibleQuietHours.end} schedule is saved. Choose a preset to replace only quiet hours.`
                      : 'Choose when future device alerts should pause. Business alert types stay unchanged.'}
                </Text>
              </View>
              <View style={styles.inAppBadge}>
                <Text style={styles.inAppBadgeText}>
                  {visibleQuietHours.state === 'mixed'
                    ? 'Varies'
                    : visibleQuietHours.presetId === 'custom'
                      ? 'Custom'
                      : visibleQuietHours.state === 'off'
                        ? 'Off'
                        : 'Set'}
                </Text>
              </View>
            </View>
            <View
              accessibilityLabel="Quiet hours presets"
              accessibilityRole="radiogroup"
              style={styles.quietHoursOptions}>
              {QUIET_HOURS_PRESETS.map((preset) => {
                const selected = visibleQuietHours.presetId === preset.id;
                const timezoneRequired = preset.start !== null;
                const disabled = preferenceBusy !== null || followedIds.length === 0 ||
                  (timezoneRequired && !deviceTimeZone);
                return (
                  <Pressable
                    accessibilityHint={timezoneRequired && deviceTimeZone
                      ? `Uses ${deviceTimeZone}.`
                      : undefined}
                    accessibilityLabel={`${preset.label}. ${preset.detail}`}
                    accessibilityRole="radio"
                    aria-checked={selected}
                    accessibilityState={{ checked: selected, disabled }}
                    disabled={disabled}
                    key={preset.id}
                    onPress={() => void saveQuietHours(preset.id)}
                    style={({ pressed }) => [
                      styles.quietHoursOption,
                      selected && styles.quietHoursOptionSelected,
                      disabled && styles.quietHoursOptionDisabled,
                      pressed && styles.quietHoursOptionPressed,
                    ]}>
                    <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                      {selected ? <View style={styles.radioInner} /> : null}
                    </View>
                    <View style={styles.quietHoursOptionCopy}>
                      <Text style={[styles.quietHoursOptionLabel, selected && styles.quietHoursOptionLabelSelected]}>
                        {preset.label}
                      </Text>
                      <Text style={styles.quietHoursOptionDetail}>{preset.detail}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.quietHoursTimezone}>
              {deviceTimeZone
                ? visibleQuietHours.timeZone && visibleQuietHours.timeZone !== deviceTimeZone
                  ? `Saved schedule: ${visibleQuietHours.timeZone}. New presets use this device: ${deviceTimeZone}.`
                  : visibleQuietHours.state === 'uniform' && !visibleQuietHours.timeZone
                    ? `The saved schedule uses each registered device timezone. New presets use ${deviceTimeZone}.`
                  : `Presets use ${deviceTimeZone}, including daylight-saving changes.`
                : 'This device could not provide a verified IANA timezone. You can still turn quiet hours off.'}
            </Text>
          </View>
          <View style={styles.preferenceNotice}>
            <FontAwesome6 color={palette.muted} name="shield-halved" size={12} />
            <Text style={styles.preferenceNoticeText}>
              No notification provider is enabled in this release. These controls do not request background location or opt you into marketing.
            </Text>
          </View>
          {preferenceBusy === 'loading' ? (
            <Text accessibilityLiveRegion="polite" style={styles.preferenceStatus}>
              Loading saved preferences…
            </Text>
          ) : preferenceMessage ? (
            <Text accessibilityLiveRegion="polite" style={styles.preferenceStatus}>
              {preferenceMessage}
            </Text>
          ) : followedIds.length === 0 ? (
            <Text style={styles.preferenceStatus}>Follow a place to configure its alerts.</Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <SectionHeading
            detail="Independent places gaining momentum this week."
            eyebrow="Worth a look"
            title="Trending around you"
          />
          <View style={styles.placeList}>
            {recommendations.map((place) => (
              <PlaceCard
                compact
                followed={false}
                key={place.id}
                onToggleFollow={toggleFollow}
                place={place}
              />
            ))}
          </View>
        </View>
      </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    paddingBottom: 132,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  countBadge: {
    backgroundColor: palette.accentSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  countText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  hero: {
    gap: spacing.sm,
    marginBottom: spacing.xxl,
    marginTop: spacing.xxxl,
    maxWidth: 700,
  },
  kicker: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 47,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 590,
  },
  livePanel: {
    backgroundColor: palette.dark,
    borderRadius: radii.xl,
    gap: spacing.lg,
    marginBottom: spacing.xxxl,
    padding: spacing.lg,
  },
  liveHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
  },
  liveDot: {
    backgroundColor: palette.mint,
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  liveTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  updateList: {
    gap: spacing.md,
  },
  updateItem: {
    gap: spacing.sm,
  },
  updateBusinessRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  updateBusiness: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
  },
  updateDistance: {
    color: palette.darkMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  section: {
    gap: spacing.lg,
    marginBottom: spacing.xxxl,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  filterChip: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  filterChipActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  filterText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  filterTextActive: {
    color: '#FFFFFF',
  },
  placeList: {
    gap: spacing.md,
  },
  empty: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.xxl,
  },
  emptyTitle: {
    color: palette.ink,
    fontSize: 17,
    fontWeight: '900',
  },
  emptyBody: {
    color: palette.muted,
    fontSize: 13,
  },
  emptyAction: {
    alignItems: 'center',
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    justifyContent: 'center',
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
  },
  emptyActionText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  preferencePanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.md,
    marginBottom: spacing.xxxl,
    padding: spacing.lg,
  },
  preferenceRow: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  deliveryRow: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  deliveryAction: {
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    minHeight: 44,
    paddingHorizontal: 15,
    justifyContent: 'center',
  },
  deliveryActionPressed: {
    opacity: 0.78,
  },
  deliveryActionText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  deliveryDisable: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  deliveryDisableRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  deliveryDisableText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  quietHoursSection: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  quietHoursHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  quietHoursOptions: {
    gap: spacing.sm,
  },
  quietHoursOption: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  quietHoursOptionSelected: {
    backgroundColor: palette.accentSoft,
    borderColor: palette.accent,
  },
  quietHoursOptionDisabled: {
    opacity: 0.48,
  },
  quietHoursOptionPressed: {
    opacity: 0.76,
  },
  quietHoursOptionCopy: {
    flex: 1,
    gap: 2,
  },
  quietHoursOptionLabel: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  quietHoursOptionLabelSelected: {
    color: palette.accentDeep,
    fontWeight: '900',
  },
  quietHoursOptionDetail: {
    color: palette.muted,
    fontSize: 10,
    lineHeight: 14,
  },
  quietHoursTimezone: {
    color: palette.muted,
    fontSize: 10,
    lineHeight: 15,
  },
  radioOuter: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 2,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  radioOuterSelected: {
    borderColor: palette.accent,
  },
  radioInner: {
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    height: 8,
    width: 8,
  },
  inAppBadge: {
    backgroundColor: palette.accentSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  inAppBadgeText: {
    color: palette.accentDeep,
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  preferenceIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    flexShrink: 0,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  preferenceCopy: {
    flex: 1,
    gap: 3,
  },
  preferenceTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  preferenceDetail: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  preferenceNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  preferenceNoticeText: {
    color: palette.muted,
    flex: 1,
    fontSize: 10,
    lineHeight: 15,
  },
  preferenceStatus: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
});
