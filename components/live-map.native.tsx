import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useRef } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import { palette } from '@/constants/theme';
import { Place } from '@/types/marketplace';

type Props = {
  places: Place[];
  selectedId?: string;
  onSelect?: (place: Place) => void;
  userCoordinates?: { latitude: number; longitude: number } | null;
};

const initialRegion = {
  latitude: 34.0722,
  longitude: -118.2737,
  latitudeDelta: 0.18,
  longitudeDelta: 0.17,
};

export function LiveMap({ places, selectedId, onSelect, userCoordinates }: Props) {
  const mapRef = useRef<MapView | null>(null);

  useEffect(() => {
    const selected = places.find((place) => place.id === selectedId);
    if (!selected) return;
    mapRef.current?.animateCamera(
      { center: { latitude: selected.latitude, longitude: selected.longitude }, zoom: 14 },
      { duration: 380 }
    );
  }, [places, selectedId]);

  return (
    <MapView
      initialRegion={
        userCoordinates
          ? { ...userCoordinates, latitudeDelta: 0.12, longitudeDelta: 0.12 }
          : initialRegion
      }
      ref={mapRef}
      showsUserLocation={Boolean(userCoordinates)}
      style={styles.map}>
      {places.map((place) => {
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
                <Text style={styles.logoFallback}>{place.name.charAt(0).toLocaleUpperCase('en-US')}</Text>
              )}
            </View>
          </Marker>
        );
      })}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: {
    height: 470,
    width: '100%',
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
