import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, type Region } from 'react-native-maps';

import { palette, radii } from '@/constants/theme';
import {
  clusterInventoryFeatures,
  clusterPlacesWithSelection,
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
import { Place } from '@/types/marketplace';

type Props = {
  places: Place[];
  selectedId?: string;
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
  latitude: 20,
  longitude: 0,
  latitudeDelta: 100,
  longitudeDelta: 160,
};

function VenueMarker({
  category,
  logoUrl,
  onLogoError,
  onLogoSettled,
  selected,
}: {
  category: Place['category'];
  logoUrl?: string;
  onLogoError?: () => void;
  onLogoSettled?: () => void;
  selected: boolean;
}) {
  const presentation = mapCategoryPresentation[category];
  return (
    <View
      style={[
        styles.pin,
        styles[`pin_${presentation.shape}`],
        selected && styles.selectedPin,
      ]}>
      {logoUrl ? (
        <Image onError={onLogoError} onLoadEnd={onLogoSettled} source={{ uri: logoUrl }} style={styles.logo} />
      ) : (
        <FontAwesome6 color={palette.ink} name={presentation.icon} size={14} />
      )}
      <View style={[styles.categoryBadge, category === 'food_truck' && styles.truckBadge]}>
        <Text style={styles.categoryBadgeText}>{presentation.badge}</Text>
      </View>
    </View>
  );
}

function VenueMapMarker({
  category,
  coordinate,
  description,
  logoUrl,
  onPress,
  selected,
  title,
}: {
  category: Place['category'];
  coordinate: { latitude: number; longitude: number };
  description?: string;
  logoUrl?: string;
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
  const [inventoryViewportEligible, setInventoryViewportEligible] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [perspective, setPerspective] = useState(false);
  const userMovedMap = useRef(false);
  const mapWasInteracted = useRef(false);
  const hasCenteredOnUser = useRef(false);
  const fittedSearchAreaKey = useRef<string | null>(null);
  const inventoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authoritativeInventory = inventoryFeatures !== undefined;
  const clientFeatures = useMemo(
    () => clusterPlacesWithSelection(places, zoomFromLongitudeDelta(region.longitudeDelta), selectedId, 120),
    [places, region.longitudeDelta, selectedId]
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
  const placesById = useMemo(
    () => new Map(places.map((place) => [place.id, place])),
    [places]
  );
  const selectedPlace = selectedId ? placesById.get(selectedId) : undefined;
  const selectedLatitude = selectedPlace?.latitude;
  const selectedLongitude = selectedPlace?.longitude;

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
  }, []);

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

  return (
    <View style={styles.frame}>
    <MapView
      accessibilityHint="Pan or zoom to explore food places. Use Search this area to refresh results."
      accessibilityLabel="Interactive map of nearby food"
      initialRegion={initialMapRegion}
      ref={mapRef}
      onPanDrag={() => {
        if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
        mapWasInteracted.current = true;
        userMovedMap.current = true;
      }}
      onTouchStart={() => {
        if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
        mapWasInteracted.current = true;
        userMovedMap.current = true;
      }}
      onRegionChangeComplete={(nextRegion) => {
        setRegion(nextRegion);
        if (userMovedMap.current) {
          const viewport = viewportFromRegion(nextRegion);
          const eligible = viewportIsLiveInventoryEligible(viewport.bounds);
          setPendingViewport(eligible && onSearchArea ? viewport : null);
          setInventoryViewportEligible(eligible);
          onViewportInvalidated?.(viewport);
          if (!eligible) {
            if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
          } else if (onViewportChange) {
            if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
            inventoryTimer.current = setTimeout(() => {
              void onViewportChange(viewport);
            }, 280);
          }
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
        const place = feature.businessId ? placesById.get(feature.businessId) : undefined;
        return (
          <VenueMapMarker
            category={feature.dominantCategory}
            coordinate={{ latitude: feature.latitude, longitude: feature.longitude }}
            description={place?.todayHours ?? feature.sourceLabel}
            key={`${feature.id}:${feature.logoUrl ?? ''}:${feature.businessId === selectedId}`}
            logoUrl={feature.logoUrl}
            onPress={() => {
              if (place && (!feature.locationId || place.locationId === feature.locationId)) onSelect?.(place);
              else if (feature.businessId) onSelectBusinessId?.(feature.businessId, feature.locationId);
            }}
            selected={feature.businessId === selectedId}
            title={place?.name ?? feature.name ?? 'Food place'}
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
        const isSelected = selectedId === place.id;

        return (
          <VenueMapMarker
            category={place.category}
            coordinate={{ latitude: place.latitude, longitude: place.longitude }}
            description={`${place.categoryLabel} · ${place.todayHours}`}
            key={`${place.id}:${place.logoUrl}:${isSelected}`}
            logoUrl={place.logoUrl}
            onPress={() => onSelect?.(place)}
            selected={isSelected}
            title={place.name}
          />
        );
      })}
    </MapView>
    <Pressable
      accessibilityLabel={perspective ? 'Use flat map view' : 'Use 3D map perspective'}
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
      <Text style={[styles.perspectiveText, perspective && styles.perspectiveTextActive]}>3D</Text>
    </Pressable>
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
  perspectiveButtonActive: {
    backgroundColor: palette.ink,
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
