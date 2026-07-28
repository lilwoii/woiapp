import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { LiveMap } from '@/components/live-map';
import { PageShell } from '@/components/page-shell';
import { PlaceCard } from '@/components/place-card';
import { Rating } from '@/components/rating';
import { StatusPill } from '@/components/status-pill';
import { palette, radii, spacing } from '@/constants/theme';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { BusinessCategory, Place } from '@/types/marketplace';

type CategoryFilter = BusinessCategory | 'all';
type SortMode = 'nearby' | 'trending' | 'popular';

const categoryFilters: { id: CategoryFilter; label: string; icon: keyof typeof FontAwesome6.glyphMap }[] = [
  { id: 'food_truck', label: 'Food trucks', icon: 'truck' },
  { id: 'restaurant', label: 'Restaurants', icon: 'utensils' },
  { id: 'pop_up', label: 'Pop-ups', icon: 'store' },
  { id: 'cafe_bakery', label: 'Cafés & bakeries', icon: 'mug-hot' },
  { id: 'home_kitchen', label: 'Verified home kitchens', icon: 'house' },
  { id: 'all', label: 'Everything', icon: 'layer-group' },
];

const sortModes: { id: SortMode; label: string }[] = [
  { id: 'nearby', label: 'Nearby' },
  { id: 'trending', label: 'Trending' },
  { id: 'popular', label: 'Popular' },
];

function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radius = 3958.8;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function DiscoverScreen() {
  const { followedIds, places, toggleFollow } = useMarketplaceStore();
  const { width } = useWindowDimensions();
  const wide = width >= 960;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('food_truck');
  const [sortMode, setSortMode] = useState<SortMode>('nearby');
  const [openOnly, setOpenOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(places[0]?.id);
  const [locationLabel, setLocationLabel] = useState('Los Angeles, CA');
  const [userCoordinates, setUserCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const deferredQuery = useDeferredValue(query);

  const requestNearby = async () => {
    setLocating(true);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationLabel('Choose a city or ZIP');
        return;
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setUserCoordinates({
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
      });
      setLocationLabel('Near your current location');
      setSortMode('nearby');
    } catch {
      setLocationLabel('Los Angeles, CA');
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    requestNearby();
  }, []);

  const ranked = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase('en-US');

    return places
      .map((place) =>
        userCoordinates
          ? {
              ...place,
              distanceMiles: distanceMiles(
                userCoordinates.latitude,
                userCoordinates.longitude,
                place.latitude,
                place.longitude
              ),
            }
          : place
      )
      .filter((place) => {
        const searchable = [
          place.name,
          place.categoryLabel,
          place.cuisines.join(' '),
          place.address,
          place.city,
          place.postalCode,
        ]
          .join(' ')
          .toLocaleLowerCase('en-US');
        const matchesQuery = !normalized || searchable.includes(normalized);
        const matchesCategory = category === 'all' || place.category === category;
        const matchesOpen = !openOnly || place.status === 'open';
        return matchesQuery && matchesCategory && matchesOpen;
      })
      .sort((a, b) => {
        if (sortMode === 'trending') return b.trendingScore - a.trendingScore;
        if (sortMode === 'popular') return b.popularityScore - a.popularityScore;
        return a.distanceMiles - b.distanceMiles;
      });
  }, [category, deferredQuery, openOnly, places, sortMode, userCoordinates]);

  useEffect(() => {
    if (ranked.length && !ranked.some((place) => place.id === selectedId)) {
      setSelectedId(ranked[0].id);
    }
  }, [ranked, selectedId]);

  const selected = ranked.find((place) => place.id === selectedId) ?? ranked[0];

  const selectPlace = (place: Place) => setSelectedId(place.id);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell>
        <View style={styles.topbar}>
          <BrandMark />
          <Pressable onPress={requestNearby} style={styles.locationButton}>
            <FontAwesome6 color={palette.accent} name="location-arrow" size={13} />
            <Text numberOfLines={1} style={styles.locationText}>
              {locating ? 'Finding you…' : locationLabel}
            </Text>
            <FontAwesome6 color={palette.muted} name="chevron-down" size={10} />
          </Pressable>
        </View>

        <View style={styles.intro}>
          <Text style={styles.eyebrow}>Live local food, mapped.</Text>
          <Text style={[styles.title, wide && styles.titleWide]}>Know what’s serving before you go.</Text>
          <Text style={styles.subtitle}>
            Live locations, current menus, clear payment details, and owner updates from the independent spots around you.
          </Text>
        </View>

        <View style={styles.searchBar}>
          <FontAwesome6 color={palette.muted} name="magnifying-glass" size={16} />
          <TextInput
            accessibilityLabel="Search by business, cuisine, city, or ZIP code"
            onChangeText={(text) => startTransition(() => setQuery(text))}
            placeholder="Search food, business, city, or ZIP"
            placeholderTextColor={palette.mutedLight}
            returnKeyType="search"
            style={styles.searchInput}
            value={query}
          />
          {query ? (
            <Pressable accessibilityLabel="Clear search" hitSlop={12} onPress={() => setQuery('')}>
              <FontAwesome6 color={palette.muted} name="circle-xmark" size={16} solid />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={styles.categoryRow}
          horizontal
          showsHorizontalScrollIndicator={false}>
          {categoryFilters.map((item, index) => {
            const active = category === item.id;
            return (
              <Pressable
                key={item.id}
                onPress={() => setCategory(item.id)}
                style={[
                  styles.categoryChip,
                  active && styles.categoryChipActive,
                  index === 0 && styles.categoryChipFirst,
                ]}>
                <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={item.icon} size={13} />
                <Text style={[styles.categoryText, active && styles.categoryTextActive]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.filterLine}>
          <View style={styles.sortSwitch}>
            {sortModes.map((mode) => (
              <Pressable
                key={mode.id}
                onPress={() => setSortMode(mode.id)}
                style={[styles.sortOption, sortMode === mode.id && styles.sortOptionActive]}>
                <Text style={[styles.sortText, sortMode === mode.id && styles.sortTextActive]}>{mode.label}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            accessibilityState={{ checked: openOnly }}
            onPress={() => setOpenOnly((current) => !current)}
            role="checkbox"
            style={[styles.openFilter, openOnly && styles.openFilterActive]}>
            <View style={[styles.filterDot, openOnly && styles.filterDotActive]} />
            <Text style={[styles.openFilterText, openOnly && styles.openFilterTextActive]}>Open now</Text>
          </Pressable>
        </View>

        {ranked.length ? (
          <View style={[styles.workspace, wide && styles.workspaceWide]}>
            <View style={[styles.mapColumn, wide && styles.mapColumnWide]}>
              <LiveMap onSelect={selectPlace} places={ranked} selectedId={selected?.id} />
              {selected ? (
                <View style={styles.mapPreview}>
                  <View style={styles.mapPreviewCopy}>
                    <View style={styles.previewMetaRow}>
                      <StatusPill compact status={selected.status} />
                      <Rating compact rating={selected.rating} />
                      <Text style={styles.previewDistance}>{selected.distanceMiles.toFixed(1)} mi</Text>
                    </View>
                    <Text numberOfLines={1} style={styles.previewName}>
                      {selected.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.previewAddress}>
                      {selected.address}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`View ${selected.name}`}
                    onPress={() => router.push(`/place/${selected.id}`)}
                    style={styles.arrowButton}>
                    <FontAwesome6 color="#FFFFFF" name="arrow-right" size={14} />
                  </Pressable>
                </View>
              ) : null}
            </View>

            <View style={[styles.resultsColumn, wide && styles.resultsColumnWide]}>
              <View style={styles.resultsHeader}>
                <View>
                  <Text style={styles.resultsTitle}>
                    {category === 'food_truck' ? 'Trucks near you' : 'Places near you'}
                  </Text>
                  <Text style={styles.resultsDetail}>
                    {ranked.length} result{ranked.length === 1 ? '' : 's'} · ranked by {sortMode}
                  </Text>
                </View>
                <Pressable style={styles.tuneButton}>
                  <FontAwesome6 color={palette.ink} name="sliders" size={14} />
                  <Text style={styles.tuneText}>Filters</Text>
                </Pressable>
              </View>

              <View style={styles.resultsList}>
                {ranked.map((place) => (
                  <PlaceCard
                    compact={wide}
                    followed={followedIds.includes(place.id)}
                    key={place.id}
                    onToggleFollow={toggleFollow}
                    place={place}
                  />
                ))}
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <FontAwesome6 color={palette.accent} name="location-dot" size={22} />
            </View>
            <Text style={styles.emptyTitle}>No matches in this preview area</Text>
            <Text style={styles.emptyBody}>Try Everything, clear Open now, or search another city or ZIP code.</Text>
            <Pressable
              onPress={() => {
                setQuery('');
                setCategory('all');
                setOpenOnly(false);
              }}
              style={styles.emptyButton}>
              <Text style={styles.emptyButtonText}>Reset search</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.trustLine}>
          <FontAwesome6 color={palette.success} name="shield-halved" size={15} />
          <Text style={styles.trustText}>
            Owner updates expire automatically. Home kitchens appear only after jurisdiction and permit verification.
          </Text>
        </View>
      </PageShell>
    </ScrollView>
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
  locationButton: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    maxWidth: 230,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  locationText: {
    color: palette.ink,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '800',
  },
  intro: {
    gap: spacing.sm,
    marginTop: spacing.xxxl,
    maxWidth: 760,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 42,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 45,
  },
  titleWide: {
    fontSize: 57,
    letterSpacing: -2.8,
    lineHeight: 59,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 620,
  },
  searchBar: {
    alignItems: 'center',
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  searchInput: {
    color: palette.ink,
    flex: 1,
    fontSize: 15,
    paddingVertical: 16,
  },
  categoryRow: {
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  categoryChip: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  categoryChipFirst: {
    borderColor: palette.accent,
  },
  categoryChipActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  categoryText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  categoryTextActive: {
    color: '#FFFFFF',
  },
  filterLine: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  sortSwitch: {
    backgroundColor: '#EAE7E0',
    borderRadius: radii.pill,
    flexDirection: 'row',
    padding: 3,
  },
  sortOption: {
    borderRadius: radii.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  sortOptionActive: {
    backgroundColor: palette.card,
  },
  sortText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  sortTextActive: {
    color: palette.ink,
  },
  openFilter: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  openFilterActive: {
    backgroundColor: palette.successSoft,
    borderColor: palette.successSoft,
  },
  filterDot: {
    backgroundColor: palette.mutedLight,
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  filterDotActive: {
    backgroundColor: palette.success,
  },
  openFilterText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  openFilterTextActive: {
    color: palette.success,
  },
  workspace: {
    gap: spacing.xl,
  },
  workspaceWide: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  mapColumn: {
    position: 'relative',
  },
  mapColumnWide: {
    flex: 1.12,
    minWidth: 0,
  },
  mapPreview: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    bottom: 16,
    elevation: 5,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    left: 16,
    padding: spacing.md,
    position: 'absolute',
    right: 16,
    shadowColor: '#18211D',
    shadowOffset: { width: 0, height: 9 },
    shadowOpacity: 0.13,
    shadowRadius: 15,
  },
  mapPreviewCopy: {
    flex: 1,
    gap: 5,
  },
  previewMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
  },
  previewDistance: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  previewName: {
    color: palette.ink,
    fontSize: 17,
    fontWeight: '900',
  },
  previewAddress: {
    color: palette.muted,
    fontSize: 11,
  },
  arrowButton: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: 999,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  resultsColumn: {
    gap: spacing.md,
  },
  resultsColumnWide: {
    flex: 0.88,
    minWidth: 0,
  },
  resultsHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  resultsTitle: {
    color: palette.ink,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  resultsDetail: {
    color: palette.muted,
    fontSize: 11,
    marginTop: 4,
    textTransform: 'capitalize',
  },
  tuneButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
    padding: 8,
  },
  tuneText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  resultsList: {
    gap: spacing.md,
  },
  empty: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: 64,
  },
  emptyIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 54,
    justifyContent: 'center',
    marginBottom: spacing.sm,
    width: 54,
  },
  emptyTitle: {
    color: palette.ink,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  emptyBody: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 420,
    textAlign: 'center',
  },
  emptyButton: {
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    marginTop: spacing.sm,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  emptyButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  trustLine: {
    alignItems: 'flex-start',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xxl,
    paddingTop: spacing.lg,
  },
  trustText: {
    color: palette.muted,
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
  },
});
