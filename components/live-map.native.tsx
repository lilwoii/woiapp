import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';

import { palette, radii } from '@/constants/theme';
import { clusterPlaces, zoomFromLongitudeDelta } from '@/lib/map-clustering';
import type { MapViewport } from '@/types/map';
import { Place } from '@/types/marketplace';

type Props = {
  places: Place[];
  selectedId?: string;
  onSelect?: (place: Place) => void;
  onSearchArea?: (viewport: MapViewport) => Promise<void> | void;
  userCoordinates?: { latitude: number; longitude: number } | null;
};

const initialRegion = {
  latitude: 34.0722,
  longitude: -118.2737,
  latitudeDelta: 0.18,
  longitudeDelta: 0.17,
};

const categoryIcons = {
  food_truck: 'truck',
  restaurant: 'utensils',
  pop_up: 'store',
  cafe_bakery: 'mug-hot',
  home_kitchen: 'house',
} as const;

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
  };
}

export function LiveMap({ places, selectedId, onSelect, onSearchArea, userCoordinates }: Props) {
  const mapRef = useRef<MapView | null>(null);
  const [region, setRegion] = useState<Region>(
    userCoordinates
      ? { ...userCoordinates, latitudeDelta: 0.12, longitudeDelta: 0.12 }
      : initialRegion
  );
  const [pendingViewport, setPendingViewport] = useState<MapViewport | null>(null);
  const userMovedMap = useRef(false);
  const features = useMemo(
    () => clusterPlaces(places, zoomFromLongitudeDelta(region.longitudeDelta)),
    [places, region.longitudeDelta]
  );

  useEffect(() => {
    const selected = places.find((place) => place.id === selectedId);
    if (!selected) return;
    mapRef.current?.animateCamera(
      { center: { latitude: selected.latitude, longitude: selected.longitude }, zoom: 14 },
      { duration: 380 }
    );
  }, [places, selectedId]);

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
        userMovedMap.current = true;
      }}
      onTouchStart={() => {
        userMovedMap.current = true;
      }}
      onRegionChangeComplete={(nextRegion) => {
        setRegion(nextRegion);
        if (userMovedMap.current && onSearchArea) {
          setPendingViewport(viewportFromRegion(nextRegion));
        }
        userMovedMap.current = false;
      }}
      showsUserLocation={Boolean(userCoordinates)}
      style={styles.map}>
      {features.map((feature) => {
        if (feature.kind === 'cluster') {
          return (
            <Marker
              coordinate={{ latitude: feature.latitude, longitude: feature.longitude }}
              key={feature.id}
              onPress={() => {
                mapRef.current?.animateCamera(
                  { center: { latitude: feature.latitude, longitude: feature.longitude }, zoom: Math.min(18, zoomFromLongitudeDelta(region.longitudeDelta) + 2) },
                  { duration: 380 }
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
        const isTruck = place.category === 'food_truck';
        const isSelected = selectedId === place.id;

        return (
          <Marker
            coordinate={{ latitude: place.latitude, longitude: place.longitude }}
            description={`${place.categoryLabel} · ${place.todayHours}`}
            key={place.id}
            onPress={() => onSelect?.(place)}
            title={place.name}
            tracksViewChanges={false}>
            <View style={[styles.pin, isTruck && styles.truckPin, isSelected && styles.selectedPin]}>
              {isTruck ? (
                <FontAwesome6 color="#FFFFFF" name="truck" size={15} />
              ) : place.logoUrl ? (
                <Image source={{ uri: place.logoUrl }} style={styles.logo} />
              ) : (
                <FontAwesome6 color={palette.ink} name={categoryIcons[place.category]} size={14} />
              )}
            </View>
          </Marker>
        );
      })}
    </MapView>
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
  truckPin: {
    backgroundColor: palette.dark,
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
});
