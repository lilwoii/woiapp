import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radii } from '@/constants/theme';
import { Place } from '@/types/marketplace';

type Props = {
  places: Place[];
  selectedId?: string;
  onSelect?: (place: Place) => void;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function coordinates(place: Place) {
  const left = clamp(((place.longitude + 118.46) / 0.3) * 76 + 12, 8, 88);
  const top = clamp(((34.14 - place.latitude) / 0.14) * 72 + 12, 10, 84);
  return { left: `${left}%` as const, top: `${top}%` as const };
}

function MapPin({ place, selected, onPress }: { place: Place; selected: boolean; onPress: () => void }) {
  const isTruck = place.category === 'food_truck';

  return (
    <Pressable
      accessibilityLabel={`${place.name}, ${place.distanceMiles.toFixed(1)} miles away`}
      onPress={onPress}
      style={[styles.pinWrap, coordinates(place)]}>
      {selected ? <View style={styles.pinPulse} /> : null}
      <View style={[styles.pin, selected && styles.pinSelected, isTruck && styles.truckPin]}>
        {isTruck ? (
          <FontAwesome6 color="#FFFFFF" name="truck" size={15} />
        ) : (
          <Image source={{ uri: place.logoUrl }} style={styles.logoPin} />
        )}
      </View>
      {selected ? (
        <View style={styles.pinLabel}>
          <Text numberOfLines={1} style={styles.pinName}>
            {place.name}
          </Text>
          <Text style={styles.pinMeta}>
            {place.status === 'open' ? 'Open' : place.categoryLabel} · {place.distanceMiles.toFixed(1)} mi
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function LiveMap({ places, selectedId, onSelect }: Props) {
  return (
    <View style={styles.map}>
      <View style={[styles.road, styles.roadOne]} />
      <View style={[styles.road, styles.roadTwo]} />
      <View style={[styles.road, styles.roadThree]} />
      <View style={[styles.road, styles.roadFour]} />
      <View style={[styles.block, styles.blockOne]} />
      <View style={[styles.block, styles.blockTwo]} />
      <View style={[styles.block, styles.blockThree]} />
      <Text style={[styles.neighborhood, styles.silverLake]}>SILVER LAKE</Text>
      <Text style={[styles.neighborhood, styles.downtown]}>DOWNTOWN</Text>
      <Text style={[styles.neighborhood, styles.hollywood]}>HOLLYWOOD</Text>

      <View style={styles.currentLocation}>
        <View style={styles.currentDot} />
      </View>

      {places.map((place) => (
        <MapPin
          key={place.id}
          onPress={() => onSelect?.(place)}
          place={place}
          selected={selectedId === place.id}
        />
      ))}

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={styles.legendTruck}>
            <FontAwesome6 color="#FFFFFF" name="truck" size={10} />
          </View>
          <Text style={styles.legendText}>Food truck</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={styles.legendLogo} />
          <Text style={styles.legendText}>Local business</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    backgroundColor: '#E9EAE3',
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    height: 470,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  road: {
    backgroundColor: '#FCFAF5',
    borderColor: '#D8D8D1',
    borderWidth: 1,
    position: 'absolute',
  },
  roadOne: {
    height: '150%',
    left: '31%',
    top: '-20%',
    transform: [{ rotate: '18deg' }],
    width: 34,
  },
  roadTwo: {
    height: 30,
    left: '-10%',
    top: '38%',
    transform: [{ rotate: '-9deg' }],
    width: '130%',
  },
  roadThree: {
    height: '130%',
    right: '23%',
    top: '-15%',
    transform: [{ rotate: '-12deg' }],
    width: 22,
  },
  roadFour: {
    bottom: '19%',
    height: 22,
    left: '-5%',
    transform: [{ rotate: '4deg' }],
    width: '120%',
  },
  block: {
    backgroundColor: '#DCE4D8',
    borderRadius: 40,
    opacity: 0.8,
    position: 'absolute',
  },
  blockOne: {
    height: 110,
    left: '5%',
    top: '8%',
    transform: [{ rotate: '-8deg' }],
    width: 160,
  },
  blockTwo: {
    bottom: '8%',
    height: 94,
    right: '5%',
    transform: [{ rotate: '8deg' }],
    width: 140,
  },
  blockThree: {
    height: 75,
    right: '12%',
    top: '18%',
    width: 96,
  },
  neighborhood: {
    color: '#A0A7A2',
    fontFamily: 'SpaceMono',
    fontSize: 9,
    letterSpacing: 1.4,
    position: 'absolute',
  },
  silverLake: {
    right: '12%',
    top: '12%',
  },
  downtown: {
    bottom: '10%',
    left: '43%',
  },
  hollywood: {
    left: '7%',
    top: '31%',
  },
  currentLocation: {
    alignItems: 'center',
    backgroundColor: 'rgba(44, 125, 231, 0.18)',
    borderRadius: 999,
    height: 38,
    justifyContent: 'center',
    left: '47%',
    position: 'absolute',
    top: '48%',
    width: 38,
  },
  currentDot: {
    backgroundColor: '#2C7DE7',
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 3,
    height: 16,
    width: 16,
  },
  pinWrap: {
    alignItems: 'center',
    position: 'absolute',
    transform: [{ translateX: -22 }, { translateY: -22 }],
    zIndex: 3,
  },
  pinPulse: {
    backgroundColor: 'rgba(241, 90, 58, 0.18)',
    borderRadius: 999,
    height: 64,
    position: 'absolute',
    top: -10,
    width: 64,
  },
  pin: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 3,
    elevation: 4,
    height: 44,
    justifyContent: 'center',
    shadowColor: '#18211D',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    width: 44,
  },
  pinSelected: {
    borderColor: palette.accent,
    transform: [{ scale: 1.12 }],
  },
  truckPin: {
    backgroundColor: palette.dark,
  },
  logoPin: {
    borderRadius: 999,
    height: 34,
    width: 34,
  },
  pinLabel: {
    backgroundColor: palette.ink,
    borderRadius: 12,
    gap: 2,
    marginTop: 6,
    maxWidth: 180,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  pinName: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  pinMeta: {
    color: palette.darkMuted,
    fontSize: 9,
    fontWeight: '600',
  },
  legend: {
    backgroundColor: 'rgba(255, 253, 248, 0.94)',
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    bottom: 14,
    flexDirection: 'row',
    gap: 14,
    left: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
    position: 'absolute',
  },
  legendItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  legendTruck: {
    alignItems: 'center',
    backgroundColor: palette.dark,
    borderRadius: 999,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  legendLogo: {
    backgroundColor: palette.accent,
    borderColor: '#FFFFFF',
    borderRadius: 999,
    borderWidth: 2,
    height: 20,
    width: 20,
  },
  legendText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '700',
  },
});

