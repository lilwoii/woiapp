import { StyleSheet } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import { Truck } from '@/types/truck';

type Props = {
  trucks: Truck[];
};

const initialRegion = {
  latitude: 34.0522,
  longitude: -118.2437,
  latitudeDelta: 0.24,
  longitudeDelta: 0.18,
};

export function LiveMap({ trucks }: Props) {
  return (
    <MapView style={styles.map} initialRegion={initialRegion}>
      {trucks.map((truck) => (
        <Marker
          key={truck.id}
          coordinate={{ latitude: truck.latitude, longitude: truck.longitude }}
          pinColor={truck.accent}
          title={truck.name}
          description={truck.hoursLabel}
        />
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: {
    height: 280,
    width: '100%',
  },
});
