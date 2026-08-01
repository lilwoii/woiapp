import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { LiveMap } from '@/components/live-map';
import { PageShell } from '@/components/page-shell';
import { PlaceCard } from '@/components/place-card';
import { Rating } from '@/components/rating';
import { StatusPill } from '@/components/status-pill';
import { SponsoredLane } from '@/components/sponsored-lane';
import { palette, radii, spacing } from '@/constants/theme';
import { useMarketplaceStore } from '@/context/marketplace-store';
import {
  cuisineFacets,
  discoveryFilterCount,
  rankDiscoveryPlaces,
  type DiscoveryCategory,
  type DiscoveryFilters,
  type DiscoverySort,
} from '@/lib/discovery-filters';
import { featureFlags } from '@/lib/features';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { DietaryTag, PaymentMethod, Place } from '@/types/marketplace';

const categoryFilters: { id: DiscoveryCategory; label: string; icon: keyof typeof FontAwesome6.glyphMap }[] = [
  { id: 'food_truck', label: 'Food trucks', icon: 'truck' },
  { id: 'restaurant', label: 'Restaurants', icon: 'utensils' },
  { id: 'pop_up', label: 'Pop-ups', icon: 'store' },
  { id: 'cafe_bakery', label: 'Cafés & bakeries', icon: 'mug-hot' },
  { id: 'home_kitchen', label: 'Verified home kitchens', icon: 'house' },
  { id: 'all', label: 'Everything', icon: 'layer-group' },
];

const sortModes: { id: DiscoverySort; label: string }[] = [
  { id: 'nearby', label: 'Nearby' },
  { id: 'trending', label: 'Trending' },
  { id: 'popular', label: 'Popular' },
  { id: 'rating', label: 'Top rated' },
];

const dietaryOptions: DietaryTag[] = [
  'Vegetarian',
  'Vegan',
  'Gluten-aware',
  'Halal',
  'Spicy',
];
const paymentOptions: PaymentMethod[] = [
  'Cash',
  'Apple Pay',
  'Google Pay',
  'Visa',
  'Venmo',
];
const distanceOptions = [1, 3, 5, 10, 25] as const;
const ratingOptions = [4, 4.5, 4.8] as const;
const priceOptions = [1, 2, 3, 4] as const;

export default function DiscoverScreen() {
  const {
    followedIds,
    hasMoreResults,
    loadingMoreResults,
    loadMoreResults,
    places,
    refresh,
    searchArea,
    syncMessage,
    syncStatus,
    toggleFollow,
  } = useMarketplaceStore();
  const { width } = useWindowDimensions();
  const wide = width >= 960;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<DiscoveryCategory>('food_truck');
  const [sortMode, setSortMode] = useState<DiscoverySort>('nearby');
  const [openOnly, setOpenOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [cuisine, setCuisine] = useState<string | null>(null);
  const [dietary, setDietary] = useState<DietaryTag[]>([]);
  const [payments, setPayments] = useState<PaymentMethod[]>([]);
  const [priceLevels, setPriceLevels] = useState<(1 | 2 | 3 | 4)[]>([]);
  const [maxDistanceMiles, setMaxDistanceMiles] = useState<number | null>(null);
  const [minimumRating, setMinimumRating] = useState(0);
  const [pickupOnly, setPickupOnly] = useState(false);
  const [hiddenSponsoredIds, setHiddenSponsoredIds] = useState<string[]>([]);
  const [openSponsorReasonId, setOpenSponsorReasonId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(places[0]?.id);
  const [locationLabel, setLocationLabel] = useState(
    isSupabaseConfigured ? 'Choose city, ZIP, or location' : 'Los Angeles preview'
  );
  const [userCoordinates, setUserCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(isSupabaseConfigured);
  const [locationPanelOpen, setLocationPanelOpen] = useState(isSupabaseConfigured);
  const [manualArea, setManualArea] = useState('');
  const [activeArea, setActiveArea] = useState('');
  const [pagination, setPagination] = useState({ key: '', count: 24 });
  const [locationError, setLocationError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const visibleCategoryFilters = useMemo(
    () => categoryFilters.filter((item) => item.id !== 'home_kitchen' || featureFlags.homeKitchens),
    []
  );
  const cuisines = useMemo(() => cuisineFacets(places).slice(0, 14), [places]);

  const toggleSelection = <T extends string | number>(
    value: T,
    selected: T[],
    setSelected: (next: T[]) => void
  ) => {
    setSelected(
      selected.includes(value)
        ? selected.filter((entry) => entry !== value)
        : [...selected, value]
    );
  };

  const requestNearby = useCallback(async () => {
    setLocating(true);
    setLocationError(null);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationLabel('Choose a city or ZIP');
        setLocationError('Location permission is off. Search by city or ZIP instead.');
        return;
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setUserCoordinates({
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
      });
      const searchResult = await refresh({
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
        radiusMeters: 16093,
      });
      if (!searchResult.ok) {
        setLocationError(searchResult.reason);
        return;
      }
      setLocationLabel('Near your current location');
      setActiveArea('');
      setLocationPanelOpen(false);
      setSortMode('nearby');
    } catch {
      setLocationError('Your location could not be read. Search by city or ZIP instead.');
    } finally {
      setLocating(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let active = true;
    void Location.getForegroundPermissionsAsync()
      .then((permission) => {
        if (!active) return;
        if (permission.status === 'granted') {
          void requestNearby();
          return;
        }
        setLocating(false);
      })
      .catch(() => {
        if (!active) return;
        setLocating(false);
        setLocationError('Choose a city or ZIP, or use location when you are ready.');
      });
    return () => {
      active = false;
    };
  }, [requestNearby]);

  const applyManualArea = async () => {
    const clean = manualArea.replace(/\s+/g, ' ').trim();
    if (!clean) {
      setLocationError('Enter a city or ZIP code.');
      return;
    }
    setLocating(true);
    setLocationError(null);
    const result = await searchArea(clean);
    setLocating(false);
    if (!result.ok) {
      setLocationError(result.reason);
      return;
    }
    setActiveArea(clean.toLocaleLowerCase('en-US'));
    setLocationLabel(clean);
    setUserCoordinates(null);
    setLocationPanelOpen(false);
    setSortMode('nearby');
  };

  const discoveryFilters: DiscoveryFilters = useMemo(
    () => ({
      query: deferredQuery,
      area: activeArea,
      category,
      openOnly,
      cuisine,
      dietary,
      payments,
      priceLevels,
      maxDistanceMiles,
      minimumRating,
      pickupOnly,
      sort: sortMode,
    }),
    [
      activeArea,
      category,
      cuisine,
      deferredQuery,
      dietary,
      maxDistanceMiles,
      minimumRating,
      openOnly,
      payments,
      pickupOnly,
      priceLevels,
      sortMode,
    ]
  );
  const activeFilterCount = discoveryFilterCount(discoveryFilters);
  const ranked = useMemo(
    () => rankDiscoveryPlaces(places, discoveryFilters, userCoordinates),
    [discoveryFilters, places, userCoordinates]
  );
  const sponsoredPlace = ranked.find(
    (place) =>
      place.sponsoredPlacement &&
      !hiddenSponsoredIds.includes(place.sponsoredPlacement.id)
  );

  const resultsKey = JSON.stringify(discoveryFilters);
  const visibleCount = pagination.key === resultsKey ? pagination.count : 24;
  const selected = ranked.find((place) => place.id === selectedId) ?? ranked[0];
  const visibleRanked = ranked.slice(0, visibleCount);
  const mappedPlaces = ranked.slice(0, 60);

  const selectPlace = useCallback((place: Place) => setSelectedId(place.id), []);

  return (
    <FocusAwareScreen>
      <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell>
        <View style={styles.topbar}>
          <BrandMark />
          <Pressable
            accessibilityLabel={`Search area: ${locating ? 'finding your location' : locationLabel}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: locationPanelOpen }}
            onPress={() => setLocationPanelOpen((current) => !current)}
            style={styles.locationButton}>
            <FontAwesome6 color={palette.accent} name="location-arrow" size={13} />
            <Text numberOfLines={1} style={styles.locationText}>
              {locating ? 'Finding you…' : locationLabel}
            </Text>
            <FontAwesome6 color={palette.muted} name="chevron-down" size={10} />
          </Pressable>
        </View>

        {locationPanelOpen ? (
          <View style={styles.locationPanel}>
            <View style={styles.locationPanelCopy}>
              <Text accessibilityRole="header" style={styles.locationPanelTitle}>Choose your search area</Text>
              <Text style={styles.locationPanelDetail}>
                Use your location once, or search without sharing it.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={locating}
              onPress={requestNearby}
              style={styles.nearbyButton}>
              {locating ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <FontAwesome6 color="#FFFFFF" name="location-crosshairs" size={13} />
              )}
              <Text style={styles.nearbyButtonText}>{locating ? 'Finding you…' : 'Use my location'}</Text>
            </Pressable>
            <View style={styles.areaSearch}>
              <TextInput
                accessibilityLabel="City or ZIP code"
                autoCapitalize="words"
                onChangeText={setManualArea}
                onSubmitEditing={() => void applyManualArea()}
                placeholder="City or ZIP code"
                placeholderTextColor={palette.mutedLight}
                returnKeyType="search"
                style={styles.areaInput}
                value={manualArea}
              />
              <Pressable
                accessibilityRole="button"
                disabled={locating}
                onPress={() => void applyManualArea()}
                style={styles.areaButton}>
                <Text style={styles.areaButtonText}>Set area</Text>
              </Pressable>
            </View>
            {locationError ? (
              <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.locationError}>
                {locationError}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.intro}>
          <Text style={styles.eyebrow}>Live local food, mapped.</Text>
          <Text accessibilityRole="header" style={[styles.title, wide && styles.titleWide]}>Know what’s serving before you go.</Text>
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
          {visibleCategoryFilters.map((item, index) => {
            const active = category === item.id;
            return (
              <Pressable
                accessibilityLabel={item.label}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
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
                accessibilityRole="radio"
                accessibilityState={{ checked: sortMode === mode.id }}
                key={mode.id}
                onPress={() => setSortMode(mode.id)}
                style={[styles.sortOption, sortMode === mode.id && styles.sortOptionActive]}>
                <Text style={[styles.sortText, sortMode === mode.id && styles.sortTextActive]}>{mode.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.filterActions}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: openOnly }}
              onPress={() => setOpenOnly((current) => !current)}
              style={[styles.openFilter, openOnly && styles.openFilterActive]}>
              <View style={[styles.filterDot, openOnly && styles.filterDotActive]} />
              <Text style={[styles.openFilterText, openOnly && styles.openFilterTextActive]}>Open now</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`Filters${activeFilterCount ? `, ${activeFilterCount} active` : ''}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: filtersOpen }}
              onPress={() => setFiltersOpen((current) => !current)}
              style={[styles.moreFiltersButton, filtersOpen && styles.moreFiltersButtonActive]}>
              <FontAwesome6
                color={filtersOpen ? '#FFFFFF' : palette.ink}
                name="sliders"
                size={12}
              />
              <Text style={[styles.moreFiltersText, filtersOpen && styles.moreFiltersTextActive]}>
                Filters{activeFilterCount ? ` · ${activeFilterCount}` : ''}
              </Text>
            </Pressable>
          </View>
        </View>

        {filtersOpen ? (
          <View accessibilityLabel="Discovery filters" style={styles.filterPanel}>
            <View style={styles.filterPanelHeader}>
              <View style={styles.filterPanelHeading}>
                <Text accessibilityRole="header" style={styles.filterPanelTitle}>Find exactly what works</Text>
                <Text style={styles.filterPanelDetail}>Every choice narrows the same organic results shown on the map.</Text>
              </View>
              {activeFilterCount ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setOpenOnly(false);
                    setCuisine(null);
                    setDietary([]);
                    setPayments([]);
                    setPriceLevels([]);
                    setMaxDistanceMiles(null);
                    setMinimumRating(0);
                    setPickupOnly(false);
                  }}
                  style={styles.clearFiltersButton}>
                  <Text style={styles.clearFiltersText}>Clear all</Text>
                </Pressable>
              ) : null}
            </View>

            <View style={styles.filterSection}>
              <Text style={styles.filterSectionLabel}>Cuisine</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.filterChoices}>
                  {cuisines.map((facet) => {
                    const selectedCuisine = cuisine === facet.label;
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selectedCuisine }}
                        key={facet.label}
                        onPress={() => setCuisine(selectedCuisine ? null : facet.label)}
                        style={[styles.filterChoice, selectedCuisine && styles.filterChoiceActive]}>
                        <Text style={[styles.filterChoiceText, selectedCuisine && styles.filterChoiceTextActive]}>
                          {facet.label} · {facet.count}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
            </View>

            <View style={styles.filterColumns}>
              <View style={styles.filterSectionColumn}>
                <Text style={styles.filterSectionLabel}>Dietary</Text>
                <View style={styles.filterChoices}>
                  {dietaryOptions.map((option) => {
                    const selectedOption = dietary.includes(option);
                    return (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selectedOption }}
                        key={option}
                        onPress={() => toggleSelection(option, dietary, setDietary)}
                        style={[styles.filterChoice, selectedOption && styles.filterChoiceActive]}>
                        <Text style={[styles.filterChoiceText, selectedOption && styles.filterChoiceTextActive]}>{option}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={styles.filterSectionColumn}>
                <Text style={styles.filterSectionLabel}>Payment accepted</Text>
                <View style={styles.filterChoices}>
                  {paymentOptions.map((option) => {
                    const selectedOption = payments.includes(option);
                    return (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selectedOption }}
                        key={option}
                        onPress={() => toggleSelection(option, payments, setPayments)}
                        style={[styles.filterChoice, selectedOption && styles.filterChoiceActive]}>
                        <Text style={[styles.filterChoiceText, selectedOption && styles.filterChoiceTextActive]}>{option}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </View>

            <View style={styles.filterColumns}>
              <View style={styles.filterSectionColumn}>
                <Text style={styles.filterSectionLabel}>Distance</Text>
                <View style={styles.filterChoices}>
                  {distanceOptions.map((miles) => (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: maxDistanceMiles === miles }}
                      key={miles}
                      onPress={() => setMaxDistanceMiles(maxDistanceMiles === miles ? null : miles)}
                      style={[styles.filterChoice, maxDistanceMiles === miles && styles.filterChoiceActive]}>
                      <Text style={[styles.filterChoiceText, maxDistanceMiles === miles && styles.filterChoiceTextActive]}>≤ {miles} mi</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <View style={styles.filterSectionColumn}>
                <Text style={styles.filterSectionLabel}>Rating</Text>
                <View style={styles.filterChoices}>
                  {ratingOptions.map((rating) => (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: minimumRating === rating }}
                      key={rating}
                      onPress={() => setMinimumRating(minimumRating === rating ? 0 : rating)}
                      style={[styles.filterChoice, minimumRating === rating && styles.filterChoiceActive]}>
                      <Text style={[styles.filterChoiceText, minimumRating === rating && styles.filterChoiceTextActive]}>{rating}+ stars</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>

            <View style={styles.filterFooter}>
              <View style={styles.priceFilter}>
                <Text style={styles.filterSectionLabel}>Price</Text>
                <View style={styles.filterChoices}>
                  {priceOptions.map((level) => {
                    const selectedLevel = priceLevels.includes(level);
                    return (
                      <Pressable
                        accessibilityLabel={`${level} dollar price level`}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selectedLevel }}
                        key={level}
                        onPress={() => toggleSelection(level, priceLevels, setPriceLevels)}
                        style={[styles.priceChoice, selectedLevel && styles.filterChoiceActive]}>
                        <Text style={[styles.filterChoiceText, selectedLevel && styles.filterChoiceTextActive]}>{'$'.repeat(level)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <Pressable
                accessibilityLabel="Pickup available"
                accessibilityRole="checkbox"
                accessibilityState={{ checked: pickupOnly }}
                onPress={() => setPickupOnly((current) => !current)}
                style={[styles.pickupFilter, pickupOnly && styles.pickupFilterActive]}>
                <FontAwesome6 color={pickupOnly ? '#FFFFFF' : palette.accentDeep} name="bag-shopping" size={13} />
                <View style={styles.pickupFilterCopy}>
                  <Text style={[styles.pickupFilterTitle, pickupOnly && styles.pickupFilterTitleActive]}>Pickup available</Text>
                  <Text style={[styles.pickupFilterDetail, pickupOnly && styles.pickupFilterDetailActive]}>Order ahead or call for pickup</Text>
                </View>
              </Pressable>
            </View>
          </View>
        ) : null}

        {sponsoredPlace ? (
          <SponsoredLane
            onHide={() => {
              const placementId = sponsoredPlace.sponsoredPlacement?.id;
              if (placementId) {
                setHiddenSponsoredIds((current) => [...new Set([...current, placementId])]);
              }
            }}
            onOpen={() => router.push(`/place/${sponsoredPlace.id}`)}
            onToggleReason={() =>
              setOpenSponsorReasonId((current) =>
                current === sponsoredPlace.sponsoredPlacement?.id
                  ? null
                  : sponsoredPlace.sponsoredPlacement?.id ?? null
              )
            }
            place={sponsoredPlace}
            reasonOpen={openSponsorReasonId === sponsoredPlace.sponsoredPlacement?.id}
          />
        ) : null}

        {syncStatus === 'error' ? (
          <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.syncBannerError}>
            <View style={styles.syncBannerCopy}>
              <Text style={styles.syncBannerTitle}>Live listings could not refresh</Text>
              <Text style={styles.syncBannerDetail}>{syncMessage}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => void refresh()} style={styles.syncRetry}>
              <Text style={styles.syncRetryText}>Retry</Text>
            </Pressable>
          </View>
        ) : syncStatus === 'demo' ? (
          <View style={styles.syncBanner}>
            <FontAwesome6 color={palette.warning} name="flask" size={12} />
            <Text style={styles.syncBannerDetail}>{syncMessage}</Text>
          </View>
        ) : null}

        {syncStatus === 'idle' && !places.length ? (
          <View accessibilityLiveRegion="polite" style={styles.empty}>
            <View style={styles.emptyIcon}>
              <FontAwesome6 color={palette.accent} name="location-crosshairs" size={22} />
            </View>
            <Text accessibilityRole="header" style={styles.emptyTitle}>
              Start with your real search area
            </Text>
            <Text style={styles.emptyBody}>
              {locating
                ? 'Checking whether location access is already enabled…'
                : 'Use foreground location or enter a city or ZIP. Spottr will not pretend global results are nearby.'}
            </Text>
            {!locating ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setLocationPanelOpen(true)}
                style={styles.emptyButton}>
                <Text style={styles.emptyButtonText}>Choose an area</Text>
              </Pressable>
            ) : null}
          </View>
        ) : syncStatus === 'syncing' && !places.length ? (
          <View accessibilityLiveRegion="polite" style={styles.loadingState}>
            <ActivityIndicator color={palette.accentDeep} />
            <Text style={styles.loadingText}>Loading nearby food…</Text>
          </View>
        ) : ranked.length ? (
          <View style={[styles.workspace, wide && styles.workspaceWide]}>
            <View style={[styles.mapColumn, wide && styles.mapColumnWide]}>
              <LiveMap
                onSelect={selectPlace}
                places={mappedPlaces}
                selectedId={selected?.id}
                userCoordinates={userCoordinates}
              />
              {selected ? (
                <View style={styles.mapPreview}>
                  <View style={styles.mapPreviewCopy}>
                    <View style={styles.previewMetaRow}>
                      <StatusPill compact status={selected.status} />
                      <Rating compact rating={selected.rating} />
                      {selected.distanceMiles !== null ? (
                        <Text style={styles.previewDistance}>{selected.distanceMiles.toFixed(1)} mi</Text>
                      ) : null}
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
                  <Text accessibilityRole="header" style={styles.resultsTitle}>
                    {category === 'food_truck' ? 'Trucks near you' : 'Places near you'}
                  </Text>
                  <Text accessibilityLiveRegion="polite" style={styles.resultsDetail}>
                    {ranked.length}
                    {hasMoreResults ? '+' : ''} result{ranked.length === 1 ? '' : 's'} · ranked by {sortMode}
                  </Text>
                </View>
              </View>

              <View style={styles.resultsList}>
                {visibleRanked.map((place) => (
                  <PlaceCard
                    compact={wide}
                    followed={followedIds.includes(place.id)}
                    key={place.id}
                    onToggleFollow={toggleFollow}
                    place={place}
                  />
                ))}
                {visibleCount < ranked.length || hasMoreResults ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ busy: loadingMoreResults }}
                    disabled={loadingMoreResults}
                    onPress={() => {
                      if (visibleCount < ranked.length) {
                        setPagination({ key: resultsKey, count: visibleCount + 24 });
                        return;
                      }
                      void loadMoreResults();
                    }}
                    style={styles.loadMoreButton}>
                    <Text style={styles.loadMoreText}>
                      {loadingMoreResults
                        ? 'Loading more verified places…'
                        : visibleCount < ranked.length
                          ? `Show more · ${ranked.length - visibleCount} loaded`
                          : 'Load more verified places'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <FontAwesome6 color={palette.accent} name="location-dot" size={22} />
            </View>
            <Text accessibilityRole="header" style={styles.emptyTitle}>
              {places.length ? 'No matches in this area' : 'No verified listings here yet'}
            </Text>
            <Text style={styles.emptyBody}>
              {places.length
                ? 'Try Everything, clear Open now, or choose another city or ZIP code.'
                : 'Try another area or check back as local businesses join Spottr.'}
            </Text>
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
            Owner updates expire automatically. Business privileges and public changes require verified account roles.
          </Text>
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
  locationButton: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    minHeight: 48,
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
  locationPanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  locationPanelCopy: {
    gap: 4,
  },
  locationPanelTitle: {
    color: palette.ink,
    fontSize: 17,
    fontWeight: '900',
  },
  locationPanelDetail: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  nearbyButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 164,
    paddingHorizontal: spacing.lg,
  },
  nearbyButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  areaSearch: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  areaInput: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    flex: 1,
    fontSize: 14,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  areaButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  areaButtonText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  locationError: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  intro: {
    gap: spacing.sm,
    marginTop: spacing.lg,
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
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 40,
  },
  titleWide: {
    fontSize: 44,
    letterSpacing: -2.2,
    lineHeight: 47,
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
    minHeight: 44,
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
  filterActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  sortSwitch: {
    backgroundColor: '#EAE7E0',
    borderRadius: radii.pill,
    flexDirection: 'row',
    padding: 3,
  },
  sortOption: {
    borderRadius: radii.pill,
    minHeight: 40,
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
    minHeight: 44,
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
  moreFiltersButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  moreFiltersButtonActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  moreFiltersText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  moreFiltersTextActive: {
    color: '#FFFFFF',
  },
  filterPanel: {
    backgroundColor: palette.surface,
    borderBottomColor: palette.line,
    borderTopColor: palette.line,
    borderBottomWidth: 1,
    borderTopWidth: 1,
    gap: spacing.lg,
    marginBottom: spacing.xl,
    paddingVertical: spacing.lg,
  },
  filterPanelHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  filterPanelHeading: {
    flex: 1,
    gap: 4,
  },
  filterPanelTitle: {
    color: palette.ink,
    fontSize: 17,
    fontWeight: '900',
  },
  filterPanelDetail: {
    color: palette.muted,
    fontSize: 10,
    lineHeight: 15,
  },
  clearFiltersButton: {
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  clearFiltersText: {
    color: palette.accentDeep,
    fontSize: 10,
    fontWeight: '900',
  },
  filterSection: {
    gap: spacing.sm,
  },
  filterSectionColumn: {
    flex: 1,
    gap: spacing.sm,
    minWidth: 260,
  },
  filterSectionLabel: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  filterColumns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xl,
  },
  filterChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  filterChoice: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 12,
  },
  filterChoiceActive: {
    backgroundColor: palette.accentDeep,
    borderColor: palette.accentDeep,
  },
  filterChoiceText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '800',
  },
  filterChoiceTextActive: {
    color: '#FFFFFF',
  },
  filterFooter: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xl,
    justifyContent: 'space-between',
  },
  priceFilter: {
    gap: spacing.sm,
  },
  priceChoice: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 48,
    paddingHorizontal: 9,
  },
  pickupFilter: {
    alignItems: 'center',
    borderColor: palette.accentSoft,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 58,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pickupFilterActive: {
    backgroundColor: palette.accentDeep,
    borderColor: palette.accentDeep,
  },
  pickupFilterCopy: {
    gap: 2,
  },
  pickupFilterTitle: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  pickupFilterTitleActive: {
    color: '#FFFFFF',
  },
  pickupFilterDetail: {
    color: palette.muted,
    fontSize: 9,
  },
  pickupFilterDetailActive: {
    color: '#F2DDD6',
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
    ...Platform.select({
      web: { boxShadow: '0 9px 30px rgba(24, 33, 29, 0.13)' },
      default: {
        shadowColor: '#18211D',
        shadowOffset: { width: 0, height: 9 },
        shadowOpacity: 0.13,
        shadowRadius: 15,
      },
    }),
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
    backgroundColor: palette.accentDeep,
    borderRadius: 999,
    height: 48,
    justifyContent: 'center',
    width: 48,
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
  loadMoreButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  loadMoreText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  syncBanner: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.lg,
    padding: spacing.md,
  },
  syncBannerError: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.lg,
    padding: spacing.md,
  },
  syncBannerCopy: {
    flex: 1,
    gap: 3,
  },
  syncBannerTitle: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '900',
  },
  syncBannerDetail: {
    color: palette.muted,
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  syncRetry: {
    alignItems: 'center',
    borderColor: palette.accentDeep,
    borderRadius: radii.pill,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  syncRetryText: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '900',
  },
  loadingState: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 72,
  },
  loadingText: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '700',
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
    minHeight: 48,
    justifyContent: 'center',
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
