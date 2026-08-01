import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { OwnerUpdate } from '@/components/owner-update';
import { PageShell } from '@/components/page-shell';
import { PlaceCard } from '@/components/place-card';
import { SectionHeading } from '@/components/section-heading';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { featureFlags } from '@/lib/features';
import {
  fetchFollowAlertPreferences,
  updateFollowAlertPreference,
} from '@/lib/marketplace-api';

type SavedFilter = 'all' | 'food_truck' | 'restaurant';
type AlertPreference = 'live_nearby' | 'owner_update';

export default function SavedScreen() {
  const { followedIds, places, toggleFollow } = useMarketplaceStore();
  const auth = useAuth();
  const [filter, setFilter] = useState<SavedFilter>('all');
  const [nearbyAlerts, setNearbyAlerts] = useState(true);
  const [ownerUpdates, setOwnerUpdates] = useState(true);
  const [preferenceBusy, setPreferenceBusy] = useState<AlertPreference | 'loading' | null>(null);
  const [preferenceMessage, setPreferenceMessage] = useState('');

  const followedKey = followedIds.join(',');

  useEffect(() => {
    if (!auth.isConfigured || auth.status !== 'authenticated' || !followedIds.length) return;
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      setPreferenceBusy('loading');
      void fetchFollowAlertPreferences(followedIds).then((result) => {
        if (!active) return;
        if (result.ok && result.data) {
          setNearbyAlerts(result.data.liveNearby);
          setOwnerUpdates(result.data.ownerUpdates);
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
  }, [auth.isConfigured, auth.status, followedKey]);

  const savePreference = async (field: AlertPreference, next: boolean) => {
    if (auth.isConfigured && auth.status !== 'authenticated') {
      router.push('/auth');
      return;
    }

    const previous = field === 'live_nearby' ? nearbyAlerts : ownerUpdates;
    if (field === 'live_nearby') setNearbyAlerts(next);
    else setOwnerUpdates(next);
    setPreferenceBusy(field);
    setPreferenceMessage('');

    const result = await updateFollowAlertPreference(followedIds, field, next);
    if (!result.ok) {
      if (field === 'live_nearby') setNearbyAlerts(previous);
      else setOwnerUpdates(previous);
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

  const followed = useMemo(
    () =>
      places.filter(
        (place) =>
          followedIds.includes(place.id) &&
          (filter === 'all' || (filter === 'restaurant' ? place.category !== 'food_truck' : place.category === filter))
      ),
    [filter, followedIds, places]
  );

  const followedWithUpdates = followed.filter((place) => place.update);
  const recommendations = places
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
          <View style={styles.filterRow}>
            {(
              [
                ['all', 'All'],
                ['food_truck', 'Food trucks'],
                ['restaurant', 'Other places'],
              ] as [SavedFilter, string][]
            ).map(([id, label]) => (
              <Pressable
                accessibilityRole="radio"
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
            detail="Fine-grained controls prevent noisy alerts."
            eyebrow="Notifications"
            title="Following alerts"
          />
          <View style={styles.preferenceRow}>
            <View style={styles.preferenceIcon}>
              <FontAwesome6 color={palette.success} name="location-crosshairs" size={15} />
            </View>
            <View style={styles.preferenceCopy}>
              <Text style={styles.preferenceTitle}>Goes live nearby</Text>
              <Text style={styles.preferenceDetail}>Only when a followed business is within 5 miles.</Text>
            </View>
            <Switch
              accessibilityLabel="Alert when followed businesses go live nearby"
              disabled={preferenceBusy !== null || followedIds.length === 0}
              onValueChange={(next) => void savePreference('live_nearby', next)}
              thumbColor="#FFFFFF"
              trackColor={{ false: palette.line, true: palette.success }}
              value={nearbyAlerts}
            />
          </View>
          <View style={styles.preferenceRow}>
            <View style={styles.preferenceIcon}>
              <FontAwesome6 color={palette.accent} name="bullhorn" size={14} />
            </View>
            <View style={styles.preferenceCopy}>
              <Text style={styles.preferenceTitle}>Owner updates</Text>
              <Text style={styles.preferenceDetail}>Location changes, sold-out items, and extended hours.</Text>
            </View>
            <Switch
              accessibilityLabel="Alert for updates from followed business owners"
              disabled={preferenceBusy !== null || followedIds.length === 0}
              onValueChange={(next) => void savePreference('owner_update', next)}
              thumbColor="#FFFFFF"
              trackColor={{ false: palette.line, true: palette.success }}
              value={ownerUpdates}
            />
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
  preferenceIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.md,
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
  preferenceStatus: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
});
