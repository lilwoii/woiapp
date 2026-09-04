import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, type Region } from 'react-native-maps';

import { palette, radii } from '@/constants/theme';
import {
  clusterInventoryFeatures,
  clusterPlacesWithSelection,
  mapPlaceIdentity,
  normalizeLongitude,
  shouldRenderMapInventory,
  viewportIsLiveInventoryEligible,
  zoomFromLongitudeDelta,
} from '@/lib/map-clustering';
import { regionForMapCoordinates } from '@/lib/map-camera';
import { mapCategoryPresentation, mapClusterCategorySummary } from '@/lib/map-presentation';
import { motionDuration } from '@/lib/motion';
import type { MapInventoryFeature, MapViewport } from '@/types/map';
import type { NavigationCoordinate, TravelMode } from '@/types/navigation';
import { MOVING_TO_NEXT_LOCATION_LABEL, Place } from '@/types/marketplace';

type Props = {
  places: Place[];
  selectedId?: string;
  selectedLocationId?: string;
  onSelect?: (place: Place) => void;
  onSelectBusinessId?: (businessId: string, locationId?: string) => void;
  onSearchArea?: (viewport: MapViewport) => Promise<void> | void;
  onViewportChange?: (viewport: MapViewport) => Promise<void> | void;
  onViewportInvalidated?: (viewport: MapViewport) => void;
  onRetryInventory?: () => void;
  inventoryFeatures?: MapInventoryFeature[];
  inventoryError?: string | null;
  markersSuppressed?: boolean;
  searchAreaKey?: string;
  userCoordinates?: { latitude: number; longitude: number } | null;
  routeCoordinates?: NavigationCoordinate[];
  navigationMode?: TravelMode;
};

const fallbackRegion = {
  latitude: 34.0522,
  longitude: -118.2437,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

function VenueMarker({
  category,
  logoUrl,
  onLogoError,
  onLogoSettled,
  moving,
  selected,
}: {
  category: Place['category'];
  logoUrl?: string;
  onLogoError?: () => void;
  onLogoSettled?: () => void;
  moving: boolean;
  selected: boolean;
}) {
  const presentation = mapCategoryPresentation[category];
  return (
    <View
      style={[
        styles.pin,
        styles[`pin_${presentation.shape}`],
        moving && styles.movingPin,
        selected && styles.selectedPin,
      ]}>
      {logoUrl ? (
        <Image onError={onLogoError} onLoadEnd={onLogoSettled} source={{ uri: logoUrl }} style={styles.logo} />
      ) : (
        <FontAwesome6 color={palette.ink} name={presentation.icon} size={14} />
      )}
      <View style={[
        styles.categoryBadge,
        category === 'food_truck' && styles.truckBadge,
        moving && styles.movingBadge,
      ]}>
        <Text style={styles.categoryBadgeText}>{moving ? 'NEXT' : presentation.badge}</Text>
      </View>
    </View>
  );
}

function VenueMapMarker({
  category,
  coordinate,
  description,
  logoUrl,
  moving,
  onPress,
  selected,
  title,
}: {
  category: Place['category'];
  coordinate: { latitude: number; longitude: number };
  description?: string;
  logoUrl?: string;
  moving: boolean;
  onPress?: () => void;
  selected: boolean;
  title: string;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const [tracksLogo, setTracksLogo] = useState(Boolean(logoUrl));
  return (
    <Marker
      accessibilityHint="Opens place details"
      accessibilityLabel={`${title}${description ? `. ${description}` : ''}`}
      accessibilityRole="button"
      accessible
      coordinate={coordinate}
      description={description}
      onPress={onPress}
      title={title}
      tracksViewChanges={tracksLogo}>
      <VenueMarker
        category={category}
        logoUrl={logoFailed ? undefined : logoUrl}
        onLogoError={() => {
          setLogoFailed(true);
          setTracksLogo(false);
        }}
        onLogoSettled={() => setTracksLogo(false)}
        moving={moving}
        selected={selected}
      />
    </Marker>
  );
}

function ClusterPin({
  count,
  categories,
}: {
  count: number;
  categories: Partial<Record<Place['category'], number>>;
}) {
  const summary = mapClusterCategorySummary(categories);
  return <View
    accessibilityElementsHidden
    accessible={false}
    importantForAccessibility="no-hide-descendants"
    style={styles.clusterPin}>
    <Text style={styles.clusterCount}>{count > 999 ? '999+' : count}</Text>
    <Text numberOfLines={1} style={styles.clusterKinds}>{summary.badges.join(' · ')}</Text>
  </View>;
}

function viewportFromRegion(region: Region): MapViewport {
  const zoom = zoomFromLongitudeDelta(region.longitudeDelta);
  const latitudeMeters = region.latitudeDelta * 111_320;
  const longitudeMeters =
    region.longitudeDelta * 111_320 * Math.max(0.1, Math.cos((region.latitude * Math.PI) / 180));
  return {
    latitude: region.latitude,
    longitude: region.longitude,
    radiusMeters: Math.round(Math.min(200_000, Math.max(1_000, Math.hypot(latitudeMeters, longitudeMeters) / 2))),
    zoom,
    bounds: {
      west: normalizeLongitude(region.longitude - region.longitudeDelta / 2),
      south: Math.max(-85.05112878, region.latitude - region.latitudeDelta / 2),
      east: normalizeLongitude(region.longitude + region.longitudeDelta / 2),
      north: Math.min(85.05112878, region.latitude + region.latitudeDelta / 2),
    },
  };
}

export function LiveMap({
  places,
  selectedId,
  selectedLocationId,
  onSelect,
  onSelectBusinessId,
  onSearchArea,
  onViewportChange,
  onViewportInvalidated,
  onRetryInventory,
  inventoryFeatures,
  inventoryError = null,
  markersSuppressed = false,
  searchAreaKey,
  userCoordinates,
  routeCoordinates = [],
  navigationMode,
}: Props) {
  const mapRef = useRef<MapView | null>(null);
  const [initialMapRegion] = useState<Region>(() => regionForMapCoordinates(
    userCoordinates ? [userCoordinates] : places,
    fallbackRegion,
  ));
  const [region, setRegion] = useState<Region>(initialMapRegion);
  const [pendingViewport, setPendingViewport] = useState<MapViewport | null>(null);
  const [inventoryViewportEligible, setInventoryViewportEligible] = useState(() =>
    viewportIsLiveInventoryEligible(viewportFromRegion(initialMapRegion).bounds)
  );
  const [reduceMotion, setReduceMotion] = useState(false);
  const [perspective, setPerspective] = useState(false);
  const [mapRetryRevision, setMapRetryRevision] = useState(0);
  const [mapStartupTimedOut, setMapStartupTimedOut] = useState(false);
  const mapReady = useRef(false);
  const userMovedMap = useRef(false);
  const mapWasInteracted = useRef(false);
  const hasCenteredOnUser = useRef(false);
  const fittedSearchAreaKey = useRef<string | null>(null);
  const navigationPerspectiveInitialized = useRef(false);
  const inventoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authoritativeInventory = inventoryFeatures !== undefined;
  const clientFeatures = useMemo(
    () => clusterPlacesWithSelection(
      places,
      zoomFromLongitudeDelta(region.longitudeDelta),
      selectedId,
      selectedLocationId,
      120,
    ),
    [places, region.longitudeDelta, selectedId, selectedLocationId]
  );
  const renderedInventoryFeatures = useMemo(
    () => clusterInventoryFeatures(inventoryFeatures ?? [], zoomFromLongitudeDelta(region.longitudeDelta), 120),
    [inventoryFeatures, region.longitudeDelta]
  );
  const markersVisible = shouldRenderMapInventory({
    viewportEligible: inventoryViewportEligible,
    inventorySuppressed: markersSuppressed,
  });
  const visibleInventoryFeatures = markersVisible ? renderedInventoryFeatures : [];
  const visibleClientFeatures = markersVisible && !authoritativeInventory ? clientFeatures : [];
  const placesByIdentity = useMemo(
    () => new Map(places.map((place) => [mapPlaceIdentity(place.id, place.locationId), place])),
    [places]
  );
  const selectedPlace = selectedId
    ? places.find((place) =>
        place.id === selectedId && (!selectedLocationId || place.locationId === selectedLocationId)
      )
    : undefined;
  const selectedLatitude = selectedPlace?.latitude;
  const selectedLongitude = selectedPlace?.longitude;

  const adjustZoom = (delta: number) => {
    mapWasInteracted.current = true;
    userMovedMap.current = true;
    const currentZoom = zoomFromLongitudeDelta(region.longitudeDelta);
    mapRef.current?.animateCamera(
      { zoom: Math.min(20, Math.max(2, currentZoom + delta)) },
      { duration: motionDuration(reduceMotion, 180) },
    );
  };

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
  }, []);

  useEffect(() => {
    mapReady.current = false;
    const timer = setTimeout(() => {
      if (!mapReady.current) setMapStartupTimedOut(true);
    }, 12_000);
    return () => clearTimeout(timer);
  }, [mapRetryRevision]);

  useEffect(() => {
    if (selectedLatitude === undefined || selectedLongitude === undefined) return;
    mapRef.current?.animateCamera(
      { center: { latitude: selectedLatitude, longitude: selectedLongitude }, zoom: 14 },
      { duration: motionDuration(reduceMotion, 380) }
    );
  }, [reduceMotion, selectedLatitude, selectedLongitude]);

  useEffect(() => {
    if (!searchAreaKey || searchAreaKey === fittedSearchAreaKey.current || !places.length) return;
    fittedSearchAreaKey.current = searchAreaKey;
    userMovedMap.current = false;
    if (places.length === 1) {
      mapRef.current?.animateCamera(
        { center: { latitude: places[0].latitude, longitude: places[0].longitude }, zoom: 13 },
        { duration: motionDuration(reduceMotion, 420) },
      );
      return;
    }
    mapRef.current?.animateToRegion(
      regionForMapCoordinates(places, fallbackRegion),
      motionDuration(reduceMotion, 420),
    );
  }, [places, reduceMotion, searchAreaKey]);

  useEffect(() => {
    if (!userCoordinates || hasCenteredOnUser.current || mapWasInteracted.current) return;
    hasCenteredOnUser.current = true;
    mapRef.current?.animateCamera(
      { center: userCoordinates, zoom: 13 },
      { duration: motionDuration(reduceMotion, 380) },
    );
  }, [reduceMotion, userCoordinates]);

  useEffect(() => {
    if (routeCoordinates.length < 2) return;
    mapRef.current?.animateToRegion(
      regionForMapCoordinates(routeCoordinates, fallbackRegion),
      motionDuration(reduceMotion, 450),
    );
  }, [reduceMotion, routeCoordinates]);

  useEffect(() => {
    if (!navigationMode) {
      navigationPerspectiveInitialized.current = false;
      return;
    }
    if (navigationPerspectiveInitialized.current) return;
    navigationPerspectiveInitialized.current = true;
    setPerspective(true);
    mapRef.current?.animateCamera(
      { pitch: 48 },
      { duration: motionDuration(reduceMotion, 320) },
    );
  }, [navigationMode, reduceMotion]);

  return (
    <View style={styles.frame}>
    <MapView
      accessibilityHint="Pan or zoom to explore food places. Use Search this area to refresh results."
      accessibilityLabel="Interactive map of nearby food"
      initialRegion={mapRetryRevision ? region : initialMapRegion}
      key={`native-map:${mapRetryRevision}`}
      ref={mapRef}
      onMapReady={() => {
        mapReady.current = true;
        setMapStartupTimedOut(false);
        setPerspective(true);
        mapRef.current?.animateCamera(
          { pitch: 42 },
          { duration: motionDuration(reduceMotion, 260) },
        );
      }}
      onPanDrag={() => {
        if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
        mapWasInteracted.current = true;
        userMovedMap.current = true;
      }}
      onTouchStart={() => {
        if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
        mapWasInteracted.current = true;
      }}
      onTouchMove={() => {
        mapWasInteracted.current = true;
        userMovedMap.current = true;
      }}
      onRegionChangeComplete={(nextRegion, details) => {
        setRegion(nextRegion);
        const viewport = viewportFromRegion(nextRegion);
        const eligible = viewportIsLiveInventoryEligible(viewport.bounds);
        const changedByGesture = userMovedMap.current || details?.isGesture === true;
        setInventoryViewportEligible(eligible);
        if (!eligible) {
          setPendingViewport(null);
          if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
        }
        if (changedByGesture) {
          setPendingViewport(eligible && onSearchArea ? viewport : null);
          onViewportInvalidated?.(viewport);
          if (eligible && onViewportChange) {
            if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
            inventoryTimer.current = setTimeout(() => {
              void onViewportChange(viewport);
            }, 280);
          }
        } else {
          // A result fit, selection, or recenter can move the camera after a
          // prior gesture exposed Search this area. Never let that control
          // submit bounds that are no longer visible, and do not treat the
          // programmatic camera move as a new inventory request.
          setPendingViewport(null);
        }
        userMovedMap.current = false;
      }}
      pitchEnabled
      rotateEnabled
      showsBuildings
      showsTraffic={navigationMode === 'drive'}
      showsUserLocation={Boolean(userCoordinates) && !navigationMode}
      style={styles.map}>
      {routeCoordinates.length >= 2 ? (
        <>
          <Polyline coordinates={routeCoordinates} strokeColor="rgba(255,255,255,0.92)" strokeWidth={9} />
          <Polyline coordinates={routeCoordinates} strokeColor={palette.accent} strokeWidth={5} />
        </>
      ) : null}
      {navigationMode && userCoordinates ? (
        <Marker
          accessibilityLabel={`Your live ${navigationMode} position`}
          accessibilityRole="image"
          accessible
          coordinate={userCoordinates}
          description={`Current ${navigationMode} navigation position.`}
          title={`Your live ${navigationMode} position`}
          tracksViewChanges={false}>
          <View
            accessibilityElementsHidden
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            style={styles.navigationMarker}>
            <FontAwesome6
              color="#FFFFFF"
              name={navigationMode === 'drive' ? 'car-side' : navigationMode === 'walk' ? 'person-walking' : 'bicycle'}
              size={15}
            />
          </View>
        </Marker>
      ) : null}
      {visibleInventoryFeatures.map((feature) => {
        if (feature.type === 'cluster') {
          const summary = mapClusterCategorySummary(feature.categoryCounts);
          const accessibilityLabel = `${feature.count} food places in this area. ${summary.accessibilityLabel}.`;
          return (
            <Marker
              accessibilityHint="Zooms in to show individual places"
              accessibilityLabel={accessibilityLabel}
              accessibilityRole="button"
              accessible
              coordinate={{ latitude: feature.latitude, longitude: feature.longitude }}
              description={`${summary.accessibilityLabel}. Select to zoom in.`}
              key={`${feature.id}:${feature.count}:${feature.dominantCategory}`}
              onPress={() => {
                userMovedMap.current = true;
                mapRef.current?.animateCamera(
                  { center: { latitude: feature.latitude, longitude: feature.longitude }, zoom: Math.min(18, zoomFromLongitudeDelta(region.longitudeDelta) + 2) },
                  { duration: motionDuration(reduceMotion, 380) }
                );
              }}
              title={`${feature.count} food places`}
              tracksViewChanges={false}>
              <ClusterPin
                categories={feature.categoryCounts}
                count={feature.count}
              />
            </Marker>
          );
        }
        const place = feature.businessId
          ? placesByIdentity.get(mapPlaceIdentity(feature.businessId, feature.locationId)) ??
            (!feature.locationId
              ? places.find((candidate) => candidate.id === feature.businessId)
              : undefined)
          : undefined;
        const moving = feature.mobilityState === 'moving_to_next_location';
        return (
          <VenueMapMarker
            category={feature.dominantCategory}
            coordinate={{ latitude: feature.latitude, longitude: feature.longitude }}
            description={moving
              ? `${MOVING_TO_NEXT_LOCATION_LABEL}. Scheduled next-stop destination; no live vehicle location.`
              : place?.todayHours ?? feature.sourceLabel}
            key={`${feature.id}:${feature.logoUrl ?? ''}:${moving}:${feature.businessId === selectedId && (!selectedLocationId || feature.locationId === selectedLocationId)}`}
            logoUrl={feature.logoUrl}
            moving={moving}
            onPress={() => {
              if (place && (!feature.locationId || place.locationId === feature.locationId)) onSelect?.(place);
              else if (feature.businessId) onSelectBusinessId?.(feature.businessId, feature.locationId);
            }}
            selected={feature.businessId === selectedId && (!selectedLocationId || feature.locationId === selectedLocationId)}
            title={`${place?.name ?? feature.name ?? 'Food place'}${moving ? ` — ${MOVING_TO_NEXT_LOCATION_LABEL}` : ''}`}
          />
        );
      })}
      {visibleClientFeatures.map((feature) => {
        if (feature.kind === 'cluster') {
          const summary = mapClusterCategorySummary(feature.categories);
          const accessibilityLabel = `${feature.count} food places in this area. ${summary.accessibilityLabel}.`;
          return (
            <Marker
              accessibilityHint="Zooms in to show individual places"
              accessibilityLabel={accessibilityLabel}
              accessibilityRole="button"
              accessible
              coordinate={{ latitude: feature.latitude, longitude: feature.longitude }}
              description={`${summary.accessibilityLabel}. Select to zoom in.`}
              key={feature.id}
              onPress={() => {
                userMovedMap.current = true;
                mapRef.current?.animateCamera(
                  { center: { latitude: feature.latitude, longitude: feature.longitude }, zoom: Math.min(18, zoomFromLongitudeDelta(region.longitudeDelta) + 2) },
                  { duration: motionDuration(reduceMotion, 380) }
                );
              }}
              title={`${feature.count} food places`}
              tracksViewChanges={false}>
              <ClusterPin
                categories={feature.categories}
                count={feature.count}
              />
            </Marker>
          );
        }

        const place = feature.place;
        const isSelected = selectedId === place.id &&
          (!selectedLocationId || place.locationId === selectedLocationId);

        return (
          <VenueMapMarker
            category={place.category}
            coordinate={{ latitude: place.latitude, longitude: place.longitude }}
            description={place.mobility
              ? `${MOVING_TO_NEXT_LOCATION_LABEL} · ${place.mobility.nextStop.timeWindow}. Scheduled next-stop destination; no live vehicle location.`
              : `${place.categoryLabel} · ${place.todayHours}`}
            key={`${mapPlaceIdentity(place.id, place.locationId)}:${place.logoUrl}:${isSelected}`}
            logoUrl={place.logoUrl}
            moving={Boolean(place.mobility)}
            onPress={() => onSelect?.(place)}
            selected={isSelected}
            title={place.name}
          />
        );
      })}
    </MapView>
    <View accessibilityLabel="Map zoom controls" style={styles.zoomControls}>
      <Pressable
        accessibilityHint="Shows a smaller area with more map detail"
        accessibilityLabel="Zoom in"
        accessibilityRole="button"
        onPress={() => adjustZoom(1)}
        style={styles.zoomButton}>
        <FontAwesome6 color={palette.ink} name="plus" size={13} />
      </Pressable>
      <View accessibilityElementsHidden importantForAccessibility="no" style={styles.zoomDivider} />
      <Pressable
        accessibilityHint="Shows a larger surrounding area"
        accessibilityLabel="Zoom out"
        accessibilityRole="button"
        onPress={() => adjustZoom(-1)}
        style={styles.zoomButton}>
        <FontAwesome6 color={palette.ink} name="minus" size={13} />
      </Pressable>
    </View>
    <Pressable
      accessibilityLabel={perspective ? 'Use flat map view' : 'Use angled map perspective'}
      accessibilityRole="button"
      accessibilityState={{ selected: perspective }}
      onPress={() => {
        const next = !perspective;
        setPerspective(next);
        mapRef.current?.animateCamera(
          { pitch: next ? 48 : 0, heading: next ? -12 : 0 },
          { duration: motionDuration(reduceMotion, 320) }
        );
      }}
      style={[styles.perspectiveButton, perspective && styles.perspectiveButtonActive]}>
      <FontAwesome6 color={perspective ? '#FFFFFF' : palette.ink} name="cube" size={12} />
      <Text style={[styles.perspectiveText, perspective && styles.perspectiveTextActive]}>Perspective</Text>
    </Pressable>
    {navigationMode && userCoordinates ? (
      <Pressable
        accessibilityLabel="Recenter map on your live position"
        accessibilityRole="button"
        onPress={() => {
          mapWasInteracted.current = true;
          mapRef.current?.animateCamera(
            { center: userCoordinates, pitch: perspective ? 48 : 0, zoom: 16 },
            { duration: motionDuration(reduceMotion, 280) },
          );
        }}
        style={styles.recenterButton}>
        <FontAwesome6 color={palette.ink} name="location-crosshairs" size={14} />
      </Pressable>
    ) : null}
    {pendingViewport && onSearchArea ? (
      <Pressable
        accessibilityLabel="Search the visible map area"
        accessibilityRole="button"
        onPress={() => {
          const viewport = pendingViewport;
          setPendingViewport(null);
          void onSearchArea(viewport);
        }}
        style={styles.searchAreaButton}>
        <FontAwesome6 color="#FFFFFF" name="magnifying-glass-location" size={12} />
        <Text style={styles.searchAreaText}>Search this area</Text>
      </Pressable>
    ) : null}
    {mapStartupTimedOut ? (
      <View accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.mapUnavailable}>
        <FontAwesome6 color={palette.accentDeep} name="map" size={17} />
        <View style={styles.mapUnavailableCopy}>
          <Text style={styles.mapUnavailableTitle}>Map did not finish loading</Text>
          <Text style={styles.mapUnavailableDetail}>Check your connection, then try the map again.</Text>
        </View>
        <Pressable
          accessibilityLabel="Retry loading the map"
          accessibilityRole="button"
          onPress={() => {
            setMapStartupTimedOut(false);
            setMapRetryRevision((current) => current + 1);
          }}
          style={styles.mapUnavailableRetry}>
          <Text style={styles.mapUnavailableRetryText}>Retry map</Text>
        </Pressable>
      </View>
    ) : null}
    {!inventoryViewportEligible || markersSuppressed ? (
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole={inventoryError ? 'alert' : undefined}
        style={styles.inventoryStatus}>
        <Text style={styles.inventoryStatusText}>
          {!inventoryViewportEligible
            ? 'Zoom in to show place markers'
            : inventoryError
              ? 'Map places need a refresh'
              : 'Refreshing this map area…'}
        </Text>
        {inventoryViewportEligible && inventoryError && onRetryInventory ? (
          <Pressable
            accessibilityRole="button"
            onPress={onRetryInventory}
            style={styles.inventoryRetry}>
            <Text style={styles.inventoryRetryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: 470,
    position: 'relative',
    width: '100%',
  },
  map: {
    height: 470,
    width: '100%',
  },
  clusterPin: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 4,
    elevation: 5,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  clusterCount: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  clusterKinds: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: -0.2,
    marginTop: 1,
    maxWidth: 46,
  },
  searchAreaButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: palette.ink,
    borderColor: '#FFFFFF',
    borderRadius: radii.pill,
    borderWidth: 2,
    flexDirection: 'row',
    gap: 8,
    minHeight: 46,
    paddingHorizontal: 17,
    position: 'absolute',
    top: 14,
  },
  searchAreaText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  inventoryStatus: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.94)',
    borderColor: 'rgba(23, 44, 42, 0.12)',
    borderRadius: radii.pill,
    borderWidth: 1,
    bottom: 14,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 13,
    position: 'absolute',
  },
  inventoryStatusText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '900',
  },
  inventoryRetry: {
    borderLeftColor: palette.line,
    borderLeftWidth: 1,
    justifyContent: 'center',
    minHeight: 26,
    paddingLeft: 10,
  },
  inventoryRetryText: {
    color: palette.accentDeep,
    fontSize: 10,
    fontWeight: '900',
  },
  mapUnavailable: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.98)',
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    elevation: 6,
    flexDirection: 'row',
    gap: 11,
    left: 18,
    padding: 14,
    position: 'absolute',
    right: 18,
    shadowColor: palette.ink,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 12,
    top: 92,
  },
  mapUnavailableCopy: {
    flex: 1,
    gap: 2,
  },
  mapUnavailableTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  mapUnavailableDetail: {
    color: palette.muted,
    fontSize: 9,
    lineHeight: 14,
  },
  mapUnavailableRetry: {
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 13,
  },
  mapUnavailableRetryText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '900',
  },
  pin: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 3,
    elevation: 4,
    height: 42,
    justifyContent: 'center',
    shadowColor: '#18211D',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
    width: 42,
  },
  pin_capsule: {
    borderRadius: 15,
    width: 54,
  },
  movingPin: {
    backgroundColor: palette.warningSoft,
    borderColor: palette.warning,
  },
  pin_circle: {
    borderRadius: 999,
  },
  pin_market: {
    borderRadius: 11,
  },
  pin_cup: {
    borderBottomLeftRadius: 9,
    borderBottomRightRadius: 9,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  pin_home: {
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
  },
  categoryBadge: {
    alignItems: 'center',
    backgroundColor: palette.ink,
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 2,
    bottom: -7,
    height: 21,
    justifyContent: 'center',
    minWidth: 21,
    paddingHorizontal: 3,
    position: 'absolute',
    right: -7,
  },
  truckBadge: {
    backgroundColor: palette.dark,
  },
  movingBadge: {
    backgroundColor: palette.warning,
    minWidth: 34,
  },
  categoryBadgeText: {
    color: '#FFFFFF',
    fontSize: 7,
    fontWeight: '900',
  },
  perspectiveButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.95)',
    borderColor: '#FFFFFF',
    borderRadius: radii.pill,
    borderWidth: 2,
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 13,
    position: 'absolute',
    right: 14,
    top: 14,
  },
  zoomControls: {
    backgroundColor: 'rgba(255, 253, 248, 0.95)',
    borderColor: '#FFFFFF',
    borderRadius: radii.md,
    borderWidth: 2,
    bottom: 58,
    elevation: 4,
    left: 14,
    overflow: 'hidden',
    position: 'absolute',
    shadowColor: palette.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 7,
  },
  zoomButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  zoomDivider: {
    backgroundColor: palette.line,
    height: 1,
    marginHorizontal: 8,
  },
  perspectiveButtonActive: {
    backgroundColor: palette.ink,
  },
  recenterButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 253, 248, 0.95)',
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 2,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 14,
    top: 66,
    width: 44,
  },
  perspectiveText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  perspectiveTextActive: {
    color: '#FFFFFF',
  },
  selectedPin: {
    borderColor: palette.accent,
    transform: [{ scale: 1.12 }],
  },
  logo: {
    borderRadius: 999,
    height: 32,
    width: 32,
  },
  logoFallback: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  navigationMarker: {
    alignItems: 'center',
    backgroundColor: '#2166D3',
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 4,
    elevation: 6,
    height: 42,
    justifyContent: 'center',
    shadowColor: '#172C2A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
    width: 42,
  },
});
