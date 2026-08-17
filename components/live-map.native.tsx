import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, type Region } from 'react-native-maps';

import { palette, radii } from '@/constants/theme';
import {
  clusterInventoryFeatures,
  clusterPlaces,
  normalizeLongitude,
  viewportIsLiveInventoryEligible,
  zoomFromLongitudeDelta,
} from '@/lib/map-clustering';
import { mapCategoryPresentation } from '@/lib/map-presentation';
import { motionDuration } from '@/lib/motion';
import type { MapInventoryFeature, MapViewport } from '@/types/map';
import type { NavigationCoordinate, TravelMode } from '@/types/navigation';
import { Place } from '@/types/marketplace';

type Props = {
  places: Place[];
  selectedId?: string;
  onSelect?: (place: Place) => void;
  onSelectBusinessId?: (businessId: string) => void;
  onSearchArea?: (viewport: MapViewport) => Promise<void> | void;
  onViewportChange?: (viewport: MapViewport) => Promise<void> | void;
  inventoryFeatures?: MapInventoryFeature[];
  userCoordinates?: { latitude: number; longitude: number } | null;
  routeCoordinates?: NavigationCoordinate[];
  navigationMode?: TravelMode;
};

const initialRegion = {
  latitude: 34.0722,
  longitude: -118.2737,
  latitudeDelta: 0.18,
  longitudeDelta: 0.17,
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
      coordinate={coordinate}
      description={description}
      onPress={onPress}
      title={title}
      tracksViewChanges={tracksLogo}>
      <VenueMarker
        category={category}
        logoUrl={logoFailed ? undefined : logoUrl}
        onLogoError={() => setLogoFailed(true)}
        onLogoSettled={() => setTracksLogo(false)}
        selected={selected}
      />
    </Marker>
  );
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
  inventoryFeatures = [],
  userCoordinates,
  routeCoordinates = [],
  navigationMode,
}: Props) {
  const mapRef = useRef<MapView | null>(null);
  const [region, setRegion] = useState<Region>(
    userCoordinates
      ? { ...userCoordinates, latitudeDelta: 0.12, longitudeDelta: 0.12 }
      : initialRegion
  );
  const [pendingViewport, setPendingViewport] = useState<MapViewport | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [perspective, setPerspective] = useState(false);
  const userMovedMap = useRef(false);
  const inventoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientFeatures = useMemo(
    () => clusterPlaces(places, zoomFromLongitudeDelta(region.longitudeDelta)),
    [places, region.longitudeDelta]
  );
  const renderedInventoryFeatures = useMemo(
    () => clusterInventoryFeatures(inventoryFeatures, zoomFromLongitudeDelta(region.longitudeDelta), 120),
    [inventoryFeatures, region.longitudeDelta]
  );
  const placesById = useMemo(
    () => new Map(places.map((place) => [place.id, place])),
    [places]
  );

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
  }, []);

  useEffect(() => {
    const selected = places.find((place) => place.id === selectedId);
    if (!selected) return;
    mapRef.current?.animateCamera(
      { center: { latitude: selected.latitude, longitude: selected.longitude }, zoom: 14 },
      { duration: motionDuration(reduceMotion, 380) }
    );
  }, [places, reduceMotion, selectedId]);

  useEffect(() => {
    if (routeCoordinates.length < 2) return;
    mapRef.current?.fitToCoordinates(routeCoordinates, {
      animated: !reduceMotion,
      edgePadding: { top: 96, right: 48, bottom: 124, left: 48 },
    });
  }, [reduceMotion, routeCoordinates]);

  return (
    <View style={styles.frame}>
    <MapView
      initialRegion={
        userCoordinates
          ? { ...userCoordinates, latitudeDelta: 0.12, longitudeDelta: 0.12 }
          : initialRegion
      }
      ref={mapRef}
      onPanDrag={() => {
        if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
        userMovedMap.current = true;
      }}
      onTouchStart={() => {
        if (inventoryTimer.current) clearTimeout(inventoryTimer.current);
        userMovedMap.current = true;
      }}
      onRegionChangeComplete={(nextRegion) => {
        setRegion(nextRegion);
        if (userMovedMap.current) {
          const viewport = viewportFromRegion(nextRegion);
          if (onSearchArea) setPendingViewport(viewport);
          if (onViewportChange && viewportIsLiveInventoryEligible(viewport.bounds)) {
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
      showsUserLocation={Boolean(userCoordinates) && !navigationMode}
      style={styles.map}>
      {routeCoordinates.length >= 2 ? (
        <>
          <Polyline coordinates={routeCoordinates} strokeColor="rgba(255,255,255,0.92)" strokeWidth={9} />
          <Polyline coordinates={routeCoordinates} strokeColor={palette.accent} strokeWidth={5} />
        </>
      ) : null}
      {navigationMode && userCoordinates ? (
        <Marker coordinate={userCoordinates} tracksViewChanges={false}>
          <View accessibilityLabel={`Your live ${navigationMode} position`} style={styles.navigationMarker}>
            <FontAwesome6
              color="#FFFFFF"
              name={navigationMode === 'drive' ? 'car-side' : navigationMode === 'walk' ? 'person-walking' : 'bicycle'}
              size={15}
            />
          </View>
        </Marker>
      ) : null}
      {renderedInventoryFeatures.map((feature) => {
        if (feature.type === 'cluster') {
          return (
            <Marker
              coordinate={{ latitude: feature.latitude, longitude: feature.longitude }}
              key={`${feature.id}:${feature.count}:${feature.dominantCategory}`}
              onPress={() => {
                userMovedMap.current = true;
                mapRef.current?.animateCamera(
                  { center: { latitude: feature.latitude, longitude: feature.longitude }, zoom: Math.min(18, zoomFromLongitudeDelta(region.longitudeDelta) + 2) },
                  { duration: motionDuration(reduceMotion, 380) }
                );
              }}
              tracksViewChanges={false}>
              <View accessibilityLabel={`${feature.count} food places in this area`} style={styles.clusterPin}>
                <Text style={styles.clusterCount}>{feature.count > 999 ? '999+' : feature.count}</Text>
              </View>
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
              if (place) onSelect?.(place);
              else if (feature.businessId) onSelectBusinessId?.(feature.businessId);
            }}
            selected={feature.businessId === selectedId}
            title={place?.name ?? feature.name ?? 'Food place'}
          />
        );
      })}
      {!inventoryFeatures.length ? clientFeatures.map((feature) => {
        if (feature.kind === 'cluster') {
          return (
            <Marker
              coordinate={{ latitude: feature.latitude, longitude: feature.longitude }}
              key={feature.id}
            onPress={() => {
              userMovedMap.current = true;
              mapRef.current?.animateCamera(
                  { center: { latitude: feature.latitude, longitude: feature.longitude }, zoom: Math.min(18, zoomFromLongitudeDelta(region.longitudeDelta) + 2) },
                  { duration: motionDuration(reduceMotion, 380) }
                );
              }}
              tracksViewChanges={false}>
              <View accessibilityLabel={`${feature.count} food places in this area`} style={styles.clusterPin}>
                <Text style={styles.clusterCount}>{feature.count > 999 ? '999+' : feature.count}</Text>
              </View>
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
      }) : null}
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
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  clusterCount: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
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
