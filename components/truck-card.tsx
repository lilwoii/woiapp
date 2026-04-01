import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, spacing } from '@/constants/theme';
import { averageRating } from '@/context/truck-store';
import { Truck } from '@/types/truck';

type Props = {
  truck: Truck;
};

export function TruckCard({ truck }: Props) {
  return (
    <Link href={`/truck/${truck.id}`} asChild>
      <Pressable style={styles.card}>
        <View style={styles.topRow}>
          <View style={[styles.badge, { backgroundColor: truck.accent }]}>
            <Text style={styles.badgeText}>{truck.status}</Text>
          </View>
          <Text style={styles.distance}>{truck.distance}</Text>
        </View>
        <Text style={styles.name}>{truck.name}</Text>
        <Text style={styles.meta}>
          {truck.cuisine} - {averageRating(truck).toFixed(1)} stars
        </Text>
        <Text style={styles.address}>{truck.address}</Text>
        <Text style={styles.hours}>{truck.hoursLabel}</Text>
        <Text style={styles.note}>{truck.coverNote}</Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 24,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  distance: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  name: {
    color: palette.ink,
    fontSize: 22,
    fontWeight: '800',
  },
  meta: {
    color: palette.accentDeep,
    fontSize: 14,
    fontWeight: '700',
  },
  address: {
    color: palette.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  hours: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  note: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 18,
  },
});
