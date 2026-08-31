import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useFocusEffect, useIsFocused, usePathname } from 'expo-router';
import * as Location from 'expo-location';
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import { placeLocationRouteParams } from '@/lib/links';
import { mapPlaceIdentity, normalizeLongitude, viewportIsLiveInventoryEligible, zoomFromLongitudeDelta } from '@/lib/map-clustering';
import { filterMapInventoryCategories, filterPlacesForEnabledCategories } from '@/lib/map-inventory';
import { mapCategoryOrder, mapCategoryPresentation } from '@/lib/map-presentation';
import { createLatestRequestGate } from '@/lib/latest-request';
import { fetchMapFoodFeatures, recordSponsoredInteraction } from '@/lib/marketplace-api';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { DietaryTag, PaymentMethod, Place, SponsoredPlace } from '@/types/marketplace';
import type { MapInventoryFeature, MapViewport } from '@/types/map';

const categoryFilters: { id: DiscoveryCategory; label: string; icon: keyof typeof FontAwesome6.glyphMap }[] = [
  { id: 'food_truck', label: 'Food trucks', icon: 'truck' },
  { id: 'restaurant', label: 'Restaurants', icon: 'utensils' },
  { id: 'pop_up', label: 'Pop-ups', icon: 'store' },
  { id: 'cafe_bakery', label: 'Cafés & bakeries', icon: 'mug-hot' },
  { id: 'home_kitchen', label: 'Neighborhood kitchens', icon: 'house' },
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

const webSectionHeading = Platform.OS === 'web'
  ? ({ 'aria-level': 2 } as const)
  : {};
const subscribeHydration = () => () => undefined;
const defaultLocationLabel = 'Choose city, ZIP, or location';
function viewportAroundPoint(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  zoom = 11
): MapViewport {
  const latitudeDelta = (radiusMeters * 2) / 111_320;
  // The live RPC intentionally rejects very large dynamic viewports. Keep
  // point/radius searches inside that contract, including near the poles.
  const longitudeDelta = Math.min(
    11.9,
    latitudeDelta / Math.max(0.1, Math.cos((latitude * Math.PI) / 180))
  );
  return {
    latitude,
    longitude: normalizeLongitude(longitude),
    radiusMeters,
    zoom,
    bounds: {
      west: normalizeLongitude(longitude - longitudeDelta / 2),
      south: Math.max(-85.05112878, latitude - latitudeDelta / 2),
      east: normalizeLongitude(longitude + longitudeDelta / 2),
      north: Math.min(85.05112878, latitude + latitudeDelta / 2),
    },
  };
}

export default function DiscoverScreen() {
  const { scopeKey } = useMarketplaceStore();
  return <ScopedDiscoverScreen key={`discover:${scopeKey}`} />;
}

function ScopedDiscoverScreen() {
  const clientHydrated = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const pathname = usePathname();
  const {
    ensurePlace,
    followedIds,
    hasMoreResults,
    loadingMoreResults,
    loadMoreResults,
    mobileMapRevision,
    publicPlaces,
    refresh,
    searchArea,
    sponsoredPlace: sponsoredProjection,
    syncMessage,
    syncStatus,
    toggleFollow,
  } = useMarketplaceStore();
  const focused = useIsFocused();
  const { width } = useWindowDimensions();
  const wide = width >= 960;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<DiscoveryCategory>('all');
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
  const [acknowledgedSponsoredId, setAcknowledgedSponsoredId] = useState<string | null>(null);
  const [openSponsorReasonId, setOpenSponsorReasonId] = useState<string | null>(null);
  const sponsoredImpressionAttempt = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedLocationId, setSelectedLocationId] = useState<string | undefined>();
  const [locationLabel, setLocationLabel] = useState(defaultLocationLabel);
  const [userCoordinates, setUserCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(isSupabaseConfigured);
  const [locationPanelOpen, setLocationPanelOpen] = useState(false);
  const [manualArea, setManualArea] = useState('');
  const [activeArea, setActiveArea] = useState('');
  const [mapFocusKey, setMapFocusKey] = useState('');
  const [pagination, setPagination] = useState({ key: '', count: 24 });
  const [locationError, setLocationError] = useState<string | null>(null);
  const [mapInventoryFeatures, setMapInventoryFeatures] = useState<MapInventoryFeature[]>([]);
  const [mapMarkersSuppressed, setMapMarkersSuppressed] = useState(false);
  const [mapInventoryError, setMapInventoryError] = useState<string | null>(null);
  const [appForeground, setAppForeground] = useState(AppState.currentState === 'active');
  const [mobileMapExpiryRevision, setMobileMapExpiryRevision] = useState(0);
  const mounted = useRef(true);
  const appForegroundRef = useRef(AppState.currentState === 'active');
  const automaticNearbyAttempted = useRef(false);
  const focusedRef = useRef(focused);
  const locationRequestGeneration = useRef(0);
  const mapInventoryRequest = useRef(createLatestRequestGate());
  const latestMapViewport = useRef<MapViewport | null>(null);
  const deferredQuery = useDeferredValue(query);
  const visibleCategoryFilters = useMemo(
    () => categoryFilters.filter((item) => item.id !== 'home_kitchen' || featureFlags.homeKitchens),
    []
  );
  const enabledMapCategories = useMemo(
    () => mapCategoryOrder.filter(
      (item) => item !== 'home_kitchen' || featureFlags.homeKitchens,
    ),
    [],
  );
  const enabledCategorySet = useMemo(
    () => new Set(enabledMapCategories),
    [enabledMapCategories],
  );
  const enabledPlaces = useMemo(
    () => {
      const filtered = filterPlacesForEnabledCategories(publicPlaces, enabledCategorySet);
      if (userCoordinates) return filtered;
      return filtered.map((place) => place.distanceMiles === null
        ? place
        : { ...place, distanceMiles: null });
    },
    [enabledCategorySet, publicPlaces, userCoordinates],
  );
  const requestedMapCategories = useMemo(
    () => category === 'all'
      ? enabledMapCategories
      : enabledCategorySet.has(category as Place['category'])
        ? [category as Place['category']]
        : [],
    [category, enabledCategorySet, enabledMapCategories],
  );
  const cuisines = useMemo(() => cuisineFacets(enabledPlaces).slice(0, 14), [enabledPlaces]);

  const loadMapInventory = useCallback(async (
    viewport: MapViewport,
    options: { preserveCurrent?: boolean } = {},
  ) => {
    const requestToken = mapInventoryRequest.current.begin();
    if (!mounted.current || !focusedRef.current || !appForegroundRef.current) {
      return { ok: false, reason: 'Screen is no longer active.' } as const;
    }
    latestMapViewport.current = viewport;
    setMapInventoryError(null);
    if (!viewportIsLiveInventoryEligible(viewport.bounds)) {
      setMapInventoryFeatures([]);
      setMapMarkersSuppressed(true);
      return { ok: false, reason: 'Zoom in before loading live map places.' } as const;
    }
    if (!requestedMapCategories.length) {
      setMapInventoryFeatures([]);
      setMapMarkersSuppressed(false);
      return { ok: true, data: [] } as const;
    }
    if (!options.preserveCurrent) {
      setMapInventoryFeatures([]);
      setMapMarkersSuppressed(true);
    }
    if (!mounted.current || !focusedRef.current || !appForegroundRef.current) {
      return { ok: false, reason: 'Screen is no longer active.' } as const;
    }
    const result = await fetchMapFoodFeatures(viewport, requestedMapCategories);
    if (!mounted.current || !mapInventoryRequest.current.isCurrent(requestToken)) return result;
    if (!result.ok) {
      setMapInventoryFeatures([]);
      setMapMarkersSuppressed(true);
      setMapInventoryError('Map places could not refresh. The verified list is still available.');
      return result;
    }
    setMapInventoryFeatures(result.data ?? []);
    setMapMarkersSuppressed(false);
    return result;
  }, [requestedMapCategories]);

  const invalidateMapInventory = useCallback((viewport: MapViewport) => {
    locationRequestGeneration.current += 1;
    latestMapViewport.current = viewport;
    mapInventoryRequest.current.invalidate();
    setLocating(false);
    setMapInventoryFeatures([]);
    setMapMarkersSuppressed(true);
    setMapInventoryError(null);
  }, []);

  const retryMapInventory = useCallback(() => {
    const viewport = latestMapViewport.current;
    if (viewport) void loadMapInventory(viewport);
  }, [loadMapInventory]);

  useEffect(() => {
    const mapRequestGate = mapInventoryRequest.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      locationRequestGeneration.current += 1;
      mapRequestGate.invalidate();
    };
  }, []);

  const expireForegroundLocation = useCallback(() => {
    setUserCoordinates(null);
    setLocationLabel((current) => current === 'Near your current location'
      ? 'Last nearby search · refresh location'
      : current);
  }, []);

  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    return () => {
      focusedRef.current = false;
      locationRequestGeneration.current += 1;
      mapInventoryRequest.current.invalidate();
      expireForegroundLocation();
      setTimeout(() => {
        if (mounted.current && !focusedRef.current) setLocating(false);
      }, 0);
    };
  }, [expireForegroundLocation]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      appForegroundRef.current = active;
      setAppForeground(active);
      if (active) return;
      locationRequestGeneration.current += 1;
      mapInventoryRequest.current.invalidate();
      setLocating(false);
      expireForegroundLocation();
    });
    return () => subscription.remove();
  }, [expireForegroundLocation]);

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
    const generation = ++locationRequestGeneration.current;
    const isCurrent = () =>
      mounted.current &&
      focusedRef.current &&
      appForegroundRef.current &&
      locationRequestGeneration.current === generation;
    if (!isCurrent()) return;
    setLocating(true);
    setLocationError(null);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!isCurrent()) return;
      if (permission.status !== 'granted') {
        setLocationLabel('Choose a city or ZIP');
        setLocationError('Location permission is off. Search by city or ZIP instead.');
        return;
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (!isCurrent()) return;
      setUserCoordinates({
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
      });
      const latitude = current.coords.latitude;
      const longitude = current.coords.longitude;
      if (!isCurrent()) return;
      const searchResult = await refresh({
        latitude,
        longitude,
        radiusMeters: 16093,
      });
      if (!isCurrent()) return;
      if (!searchResult.ok) {
        setLocationError(searchResult.reason);
        return;
      }
      setLocationLabel('Near your current location');
      setActiveArea('');
      setMapFocusKey(`near:${generation}:${latitude.toFixed(5)}:${longitude.toFixed(5)}`);
      setSelectedId(undefined);
      setSelectedLocationId(undefined);
      setLocationPanelOpen(false);
      setSortMode('nearby');
      if (!isCurrent()) return;
      void loadMapInventory(viewportAroundPoint(latitude, longitude, 16_093));
    } catch {
      if (!isCurrent()) return;
      setLocationError('Your location could not be read. Search by city or ZIP instead.');
    } finally {
      if (isCurrent()) setLocating(false);
    }
  }, [loadMapInventory, refresh]);

  useEffect(() => {
    if (!isSupabaseConfigured || !focused || !appForeground) {
      const timer = setTimeout(() => setLocating(false), 0);
      return () => clearTimeout(timer);
    }
    if (automaticNearbyAttempted.current) return;
    automaticNearbyAttempted.current = true;
    const generation = ++locationRequestGeneration.current;
    let active = true;
    const isCurrent = () =>
      active &&
      mounted.current &&
      focusedRef.current &&
      appForegroundRef.current &&
      locationRequestGeneration.current === generation;
    void Location.getForegroundPermissionsAsync()
      .then((permission) => {
        if (!isCurrent()) return;
        if (permission.status === 'granted') {
          void requestNearby();
          return;
        }
        setLocating(false);
      })
      .catch(() => {
        if (!isCurrent()) return;
        setLocating(false);
        setLocationError('Choose a city or ZIP, or use location when you are ready.');
      });
    return () => {
      active = false;
      if (locationRequestGeneration.current === generation) {
        locationRequestGeneration.current += 1;
      }
    };
  }, [appForeground, focused, requestNearby]);

  const applyManualArea = async () => {
    const clean = manualArea.replace(/\s+/g, ' ').trim();
    if (!clean) {
      setLocationError('Enter a city or ZIP code.');
      return;
    }
    automaticNearbyAttempted.current = true;
    const generation = ++locationRequestGeneration.current;
    const isCurrent = () => mounted.current && locationRequestGeneration.current === generation;
    if (!isCurrent()) return;
    setLocating(true);
    setLocationError(null);
    let result: Awaited<ReturnType<typeof searchArea>>;
    try {
      result = await searchArea(clean);
    } catch {
      if (!isCurrent()) return;
      setLocating(false);
      setLocationError('This search area could not be loaded. Try again.');
      return;
    }
    if (!isCurrent()) return;
    setLocating(false);
    if (!result.ok) {
      setLocationError(result.reason);
      return;
    }
    if ((result.data?.areaMatchCount ?? 0) === 0) {
      setLocationError('No currently listed places matched that city or ZIP. The map stayed on your previous area.');
      return;
    }
    setActiveArea(clean.toLocaleLowerCase('en-US'));
    setMapFocusKey(`area:${generation}:${clean.toLocaleLowerCase('en-US')}`);
    setSelectedId(undefined);
    setSelectedLocationId(undefined);
    setLocationLabel(clean);
    setUserCoordinates(null);
    setLocationPanelOpen(false);
    setSortMode('nearby');
  };

  const searchVisibleMap = useCallback(async (viewport: MapViewport) => {
    if (!viewportIsLiveInventoryEligible(viewport.bounds)) {
      setLocationError('Zoom in before searching this map area.');
      return;
    }
    automaticNearbyAttempted.current = true;
    const generation = ++locationRequestGeneration.current;
    const isCurrent = () => mounted.current && locationRequestGeneration.current === generation;
    if (!isCurrent()) return;
    setLocating(true);
    setLocationError(null);
    const [result] = await Promise.all([
      refresh({
      latitude: viewport.latitude,
      longitude: viewport.longitude,
      radiusMeters: Math.min(80_467, viewport.radiusMeters),
      }),
      loadMapInventory(viewport),
    ]);
    if (!isCurrent()) return;
    setLocating(false);
    if (!result.ok) {
      setLocationError(result.reason);
      return;
    }
    setActiveArea('');
    setSelectedId(undefined);
    setSelectedLocationId(undefined);
    setLocationLabel('Visible map area');
    setSortMode('nearby');
  }, [loadMapInventory, refresh]);

  useEffect(() => {
    if (!activeArea) return;
    if (!enabledPlaces.length) {
      const timer = setTimeout(() => {
        mapInventoryRequest.current.invalidate();
        latestMapViewport.current = null;
        setMapInventoryFeatures([]);
        setMapMarkersSuppressed(false);
        setMapInventoryError(null);
      }, 0);
      return () => clearTimeout(timer);
    }
    const latitudes = enabledPlaces.map((place) => place.latitude);
    const centerLatitude = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
    const longitudes = enabledPlaces.map((place) => normalizeLongitude(place.longitude));
    const radians = longitudes.map((longitude) => (longitude * Math.PI) / 180);
    const centerLongitude = normalizeLongitude(
      (Math.atan2(
        radians.reduce((sum, value) => sum + Math.sin(value), 0),
        radians.reduce((sum, value) => sum + Math.cos(value), 0)
      ) * 180) / Math.PI
    );
    const longitudeOffsets = longitudes.map((longitude) =>
      Math.abs(normalizeLongitude(longitude - centerLongitude))
    );
    const latitudeSpan = Math.max(0.03, Math.max(...latitudes) - Math.min(...latitudes));
    const longitudeSpan = Math.max(0.03, Math.max(...longitudeOffsets) * 2);
    const radiusMeters = Math.min(
      80_467,
      Math.max(latitudeSpan * 111_320, longitudeSpan * 111_320 * Math.max(0.1, Math.cos((centerLatitude * Math.PI) / 180))) / 2
    );
    const viewport = viewportAroundPoint(
      centerLatitude,
      centerLongitude,
      Math.max(1_000, radiusMeters),
      zoomFromLongitudeDelta(longitudeSpan)
    );
    const timer = setTimeout(() => {
      void loadMapInventory(viewport);
    }, 0);
    return () => clearTimeout(timer);
  }, [activeArea, enabledPlaces, loadMapInventory]);

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
    () => rankDiscoveryPlaces(enabledPlaces, discoveryFilters, userCoordinates),
    [discoveryFilters, enabledPlaces, userCoordinates]
  );
  const sponsoredPlace = useMemo(() => {
    if (!featureFlags.sponsoredPlacements || !sponsoredProjection) return undefined;
    if (hiddenSponsoredIds.includes(sponsoredProjection.sponsoredPlacement.id)) return undefined;
    return rankDiscoveryPlaces([sponsoredProjection], discoveryFilters, userCoordinates).length
      ? sponsoredProjection
      : undefined;
  }, [discoveryFilters, hiddenSponsoredIds, sponsoredProjection, userCoordinates]);
  const recordVisibleSponsoredImpression = useCallback((place: SponsoredPlace) => {
    const placement = place.sponsoredPlacement;
    const attemptKey = `${placement.id}:${placement.token}`;
    if (sponsoredImpressionAttempt.current === attemptKey) return;
    sponsoredImpressionAttempt.current = attemptKey;
    void recordSponsoredInteraction(placement.token, 'impression').then((result) => {
      if (
        !mounted.current ||
        sponsoredImpressionAttempt.current !== attemptKey
      ) return;
      if (result.ok && result.data?.accepted) {
        setAcknowledgedSponsoredId(placement.id);
        return;
      }
      setHiddenSponsoredIds((hidden) => [...new Set([...hidden, placement.id])]);
    });
  }, []);

  const resultsKey = JSON.stringify(discoveryFilters);
  const visibleCount = pagination.key === resultsKey ? pagination.count : 24;
  const explicitSelection = ranked.find(
    (place) => place.id === selectedId && (!selectedLocationId || place.locationId === selectedLocationId),
  );
  const selected = explicitSelection;
  const visibleRanked = ranked.slice(0, visibleCount);
  const mappedPlaces = ranked;
  const permittedMapInventory = useMemo(
    () => filterMapInventoryCategories(
      mapInventoryFeatures,
      new Set(
        enabledMapCategories
      ),
    ),
    [enabledMapCategories, mapInventoryFeatures],
  );
  const detailedMapFiltersActive = Boolean(
    deferredQuery.trim()
      || openOnly
      || cuisine
      || dietary.length
      || payments.length
      || priceLevels.length
      || maxDistanceMiles !== null
      || minimumRating > 0
      || pickupOnly
  );
  const visibleMapInventory = useMemo(() => {
    // The high-volume viewport feed contains only map-safe location metadata.
    // When a filter needs full listing details, render the already filtered
    // discovery results so the map never contradicts the result list.
    if (detailedMapFiltersActive) return [];
    if (category === 'all') return permittedMapInventory;
    return filterMapInventoryCategories(permittedMapInventory, new Set([category]));
  }, [category, detailedMapFiltersActive, permittedMapInventory]);
  const authoritativeMapInventory = isSupabaseConfigured && !detailedMapFiltersActive;
  useEffect(() => {
    if (!focused || !appForeground || !authoritativeMapInventory) return;
    // Mobile stops become stale when their service window ends even if no
    // owner mutation emits another realtime event. Bound that stale window to
    // one minute while the Discover map is actually visible and foregrounded.
    const timer = setInterval(
      () => setMobileMapExpiryRevision((current) => current + 1),
      60_000,
    );
    return () => clearInterval(timer);
  }, [appForeground, authoritativeMapInventory, focused]);

  useEffect(() => {
    if (!focused || !appForeground || !authoritativeMapInventory || !latestMapViewport.current) {
      return;
    }
    // Realtime can burst while an owner edits a stop. Debounce those events,
    // keep the current markers visible, and let the latest-request gate reject
    // any response for an older viewport.
    const timer = setTimeout(() => {
      const latestViewport = latestMapViewport.current;
      if (latestViewport && viewportIsLiveInventoryEligible(latestViewport.bounds)) {
        void loadMapInventory(latestViewport, { preserveCurrent: true });
      }
    }, 750);
    return () => clearTimeout(timer);
  }, [
    appForeground,
    authoritativeMapInventory,
    focused,
    loadMapInventory,
    mobileMapExpiryRevision,
    mobileMapRevision,
  ]);
  const mapInventoryMayBeCapped = useMemo(
    () => visibleMapInventory.reduce((total, feature) => total + feature.count, 0) >= 1_200,
    [visibleMapInventory],
  );

  const selectPlace = useCallback((place: Place) => {
    setSelectedId(place.id);
    setSelectedLocationId(place.locationId);
  }, []);
  const selectBusinessId = useCallback(async (businessId: string, locationId?: string) => {
    const result = await ensurePlace(businessId, locationId, 'discovery');
    if (mounted.current && result.ok) {
      setSelectedId(businessId);
      setSelectedLocationId(locationId);
    }
  }, [ensurePlace]);

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
              <Text accessibilityRole="header" {...webSectionHeading} style={styles.locationPanelTitle}>Choose your search area</Text>
              <Text style={styles.locationPanelDetail}>
                Use foreground location while this map is open, or search without sharing it.
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
          <Text style={styles.eyebrow}>Live local food</Text>
          <Text accessibilityRole="header" style={[styles.title, wide && styles.titleWide]}>Find what’s serving.</Text>
          <Text style={styles.subtitle}>
            Food trucks first, plus restaurants, pop-ups, current menus, payments, and owner updates.
          </Text>
        </View>

        <View style={styles.searchBar}>
          <FontAwesome6 color={palette.muted} name="magnifying-glass" size={16} />
          <TextInput
            accessibilityLabel="Filter loaded places by business, cuisine, dish, or payment method"
            onChangeText={(text) => startTransition(() => setQuery(text))}
            placeholder="Search food or business"
            placeholderTextColor={palette.mutedLight}
            returnKeyType="search"
            style={styles.searchInput}
            value={query}
          />
          {query ? (
            <Pressable accessibilityLabel="Clear search" accessibilityRole="button" hitSlop={12} onPress={() => setQuery('')}>
              <FontAwesome6 color={palette.muted} name="circle-xmark" size={16} solid />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          accessibilityLabel="Business category"
          accessibilityRole="radiogroup"
          contentContainerStyle={styles.categoryRow}
          horizontal
          showsHorizontalScrollIndicator={false}>
          {visibleCategoryFilters.map((item, index) => {
            const active = category === item.id;
            return (
              <Pressable
                accessibilityLabel={item.label}
                accessibilityRole="radio"
                aria-checked={active}
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
          <View accessibilityLabel="Sort results" accessibilityRole="radiogroup" style={styles.sortSwitch}>
            {sortModes.map((mode) => (
              <Pressable
                accessibilityRole="radio"
                aria-checked={sortMode === mode.id}
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
              aria-checked={openOnly}
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
                <Text accessibilityRole="header" {...webSectionHeading} style={styles.filterPanelTitle}>Find exactly what works</Text>
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
                <View
                  accessibilityLabel="Cuisine filter"
                  accessibilityRole="radiogroup"
                  style={styles.filterChoices}>
                  {cuisines.map((facet) => {
                    const selectedCuisine = cuisine === facet.label;
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        aria-checked={selectedCuisine}
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
                        aria-checked={selectedOption}
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
                        aria-checked={selectedOption}
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
                <View
                  accessibilityLabel="Distance filter"
                  accessibilityRole="radiogroup"
                  style={styles.filterChoices}>
                  {distanceOptions.map((miles) => (
                    <Pressable
                      accessibilityRole="radio"
                      aria-checked={maxDistanceMiles === miles}
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
                <View
                  accessibilityLabel="Rating filter"
                  accessibilityRole="radiogroup"
                  style={styles.filterChoices}>
                  {ratingOptions.map((rating) => (
                    <Pressable
                      accessibilityRole="radio"
                      aria-checked={minimumRating === rating}
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
                        aria-checked={selectedLevel}
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
                aria-checked={pickupOnly}
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

        {clientHydrated && focused && pathname === '/' ? (
          <View style={[styles.workspace, wide && styles.workspaceWide]}>
            <View style={[styles.mapColumn, wide && styles.mapColumnWide]}>
              <LiveMap
                inventoryError={authoritativeMapInventory ? mapInventoryError : null}
                inventoryFeatures={authoritativeMapInventory ? visibleMapInventory : undefined}
                markersSuppressed={authoritativeMapInventory ? mapMarkersSuppressed : false}
                onSelect={selectPlace}
                onSelectBusinessId={(businessId, locationId) => void selectBusinessId(businessId, locationId)}
                onSearchArea={searchVisibleMap}
                onRetryInventory={authoritativeMapInventory ? retryMapInventory : undefined}
                onViewportChange={authoritativeMapInventory ? (viewport) => void loadMapInventory(viewport) : undefined}
                onViewportInvalidated={invalidateMapInventory}
                places={mappedPlaces}
                searchAreaKey={mapFocusKey || undefined}
                selectedId={explicitSelection?.id}
                selectedLocationId={explicitSelection?.locationId}
                userCoordinates={userCoordinates}
              />
              <View
                accessibilityLabel="Map marker key"
                style={[styles.mapLegend, !wide && styles.mapLegendCompact]}>
                {mapCategoryOrder
                  .filter((item) => item !== 'home_kitchen' || featureFlags.homeKitchens)
                  .map((item) => {
                    const presentation = mapCategoryPresentation[item];
                    return (
                      <View key={item} style={styles.legendItem}>
                        <View
                          style={[
                            styles.legendIcon,
                            presentation.shape === 'capsule' && styles.legendCapsule,
                            presentation.shape === 'market' && styles.legendMarket,
                            presentation.shape === 'cup' && styles.legendCup,
                            presentation.shape === 'home' && styles.legendHome,
                          ]}>
                          <Text style={styles.legendBadgeText}>{presentation.badge}</Text>
                        </View>
                        <Text style={styles.legendText}>{presentation.shortLabel}</Text>
                      </View>
                    );
                  })}
                <View style={styles.legendItem}>
                  <View style={styles.legendCluster}><Text style={styles.legendClusterText}>12</Text></View>
                  <Text style={styles.legendText}>Area</Text>
                </View>
              </View>
              {mapInventoryMayBeCapped ? (
                <View accessibilityLiveRegion="polite" style={styles.mapLimitNotice}>
                  <FontAwesome6 color={palette.accentDeep} name="layer-group" size={10} />
                  <Text style={styles.mapLimitText}>Dense area · zoom in or search this area to load local detail.</Text>
                </View>
              ) : null}
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
                    onPress={() => router.push({
                      pathname: '/place/[id]',
                      params: placeLocationRouteParams(selected.id, selected.locationId),
                    })}
                    style={styles.arrowButton}>
                    <FontAwesome6 color="#FFFFFF" name="arrow-right" size={14} />
                  </Pressable>
                </View>
              ) : null}
            </View>

            <View style={[styles.resultsColumn, wide && styles.resultsColumnWide]}>
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
              ) : null}
              <View style={styles.resultsHeader}>
                <View>
                  <Text accessibilityRole="header" {...webSectionHeading} style={styles.resultsTitle}>
                    {category === 'food_truck' ? 'Trucks near you' : category === 'all' ? 'Food near you' : 'Places near you'}
                  </Text>
                  <Text accessibilityLiveRegion="polite" style={styles.resultsDetail}>
                    {ranked.length}
                    {hasMoreResults ? '+' : ''} result{ranked.length === 1 ? '' : 's'} · ranked by {sortMode}
                  </Text>
                </View>
              </View>
              {sponsoredPlace ? (
                <SponsoredLane
                  interactionReady={acknowledgedSponsoredId === sponsoredPlace.sponsoredPlacement.id}
                  onImpression={() => recordVisibleSponsoredImpression(sponsoredPlace)}
                  onHide={() => {
                    const placementId = sponsoredPlace.sponsoredPlacement?.id;
                    const placementToken = sponsoredPlace.sponsoredPlacement?.token;
                    if (placementId) {
                      setHiddenSponsoredIds((current) => [...new Set([...current, placementId])]);
                    }
                    if (placementToken) void recordSponsoredInteraction(placementToken, 'hide');
                  }}
                  onOpen={() => {
                    if (acknowledgedSponsoredId !== sponsoredPlace.sponsoredPlacement.id) return;
                    const placementToken = sponsoredPlace.sponsoredPlacement?.token;
                    if (placementToken) void recordSponsoredInteraction(placementToken, 'open');
                    router.push({
                      pathname: '/place/[id]',
                      params: placeLocationRouteParams(
                        sponsoredPlace.id,
                        sponsoredPlace.locationId,
                      ),
                    });
                  }}
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

              <View style={styles.resultsList}>
                {!visibleRanked.length ? (
                  <View style={styles.mapOnlyResult}>
                    <FontAwesome6
                      color={palette.accentDeep}
                      name={syncStatus === 'syncing' ? 'spinner' : 'map-location-dot'}
                      size={17}
                    />
                    <Text style={styles.mapOnlyTitle}>
                      {syncStatus === 'syncing'
                        ? 'Loading verified places'
                        : visibleMapInventory.length
                          ? 'More places are visible on the map'
                          : syncStatus === 'error'
                            ? 'The map is ready when listings reconnect'
                            : enabledPlaces.length
                              ? 'No places match these filters'
                              : locationLabel !== defaultLocationLabel
                                ? 'No verified listings here yet'
                                : 'Choose an area to find what is serving'}
                    </Text>
                    <Text style={styles.mapOnlyBody}>
                      {syncStatus === 'syncing'
                        ? 'You can keep exploring the map while Spottr refreshes this area.'
                        : visibleMapInventory.length
                          ? 'Zoom into a cluster or search this area to load its detailed list.'
                          : syncStatus === 'error'
                            ? 'Base-map exploration remains available. Retry to restore live, verified listings.'
                            : enabledPlaces.length
                              ? 'Clear a filter or search another visible area.'
                              : locationLabel !== defaultLocationLabel
                                ? 'Try another city, ZIP code, or visible map area.'
                                : locating
                                ? 'Checking foreground location access…'
                                : 'Use foreground location or enter a city or ZIP. Spottr never invents nearby results.'}
                    </Text>
                    {!locating && !enabledPlaces.length && syncStatus !== 'error' ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setLocationPanelOpen(true)}
                        style={styles.mapOnlyAction}>
                        <Text style={styles.mapOnlyActionText}>Choose an area</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                {visibleRanked.map((place) => (
                  <PlaceCard
                    compact={wide}
                    followed={followedIds.includes(place.id)}
                    key={mapPlaceIdentity(place.id, place.locationId)}
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
          <View accessibilityLiveRegion="polite" style={styles.mapBootstrap}>
            <FontAwesome6 color={palette.accentDeep} name="map-location-dot" size={20} />
            <Text style={styles.mapBootstrapTitle}>Preparing the live map…</Text>
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
    gap: 3,
    marginTop: spacing.md,
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
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -1.1,
    lineHeight: 29,
  },
  titleWide: {
    fontSize: 27,
    letterSpacing: -1.2,
    lineHeight: 32,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 17,
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
    marginTop: spacing.md,
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
    paddingVertical: spacing.sm,
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
    marginBottom: spacing.md,
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
    gap: spacing.lg,
  },
  mapBootstrap: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.sm,
    height: 470,
    justifyContent: 'center',
  },
  mapBootstrapTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
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
  mapLegend: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.94)',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    left: 14,
    maxWidth: 324,
    paddingHorizontal: 9,
    paddingVertical: 7,
    position: 'absolute',
    top: 72,
  },
  mapLegendCompact: {
    maxWidth: 250,
    right: 70,
  },
  legendItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  legendIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  legendCapsule: {
    borderRadius: 7,
    width: 28,
  },
  legendMarket: {
    borderRadius: 6,
  },
  legendCup: {
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  legendHome: {
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
  },
  legendBadgeText: {
    color: palette.ink,
    fontSize: 7,
    fontWeight: '900',
  },
  legendCluster: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: 999,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  legendClusterText: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: '900',
  },
  legendText: {
    color: palette.muted,
    fontSize: 9,
    fontWeight: '800',
  },
  mapLimitNotice: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.94)',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    bottom: 104,
    flexDirection: 'row',
    gap: 6,
    left: 16,
    paddingHorizontal: 10,
    paddingVertical: 7,
    position: 'absolute',
  },
  mapLimitText: {
    color: palette.muted,
    fontSize: 8,
    fontWeight: '800',
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
  mapOnlyResult: {
    alignItems: 'flex-start',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 6,
    padding: spacing.lg,
  },
  mapOnlyTitle: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  mapOnlyBody: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  mapOnlyAction: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    justifyContent: 'center',
    marginTop: spacing.xs,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
  },
  mapOnlyActionText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
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
