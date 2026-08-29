import FontAwesome from '@expo/vector-icons/FontAwesome';
import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

type Props = {
  rating: number;
  count?: number;
  light?: boolean;
  compact?: boolean;
};

export function Rating({ rating, count, light = false, compact = false }: Props) {
  const ink = light ? '#FFFFFF' : palette.ink;
  const accessibilityLabel = `${rating.toFixed(1)} stars${
    typeof count === 'number' ? `, ${count.toLocaleString()} ${count === 1 ? 'review' : 'reviews'}` : ''
  }`;

  return (
    <View accessibilityLabel={accessibilityLabel} accessibilityRole="text" accessible style={styles.row}>
      <FontAwesome accessibilityElementsHidden color={palette.sun} importantForAccessibility="no" name="star" size={compact ? 12 : 14} />
      <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.rating, { color: ink }, compact && styles.compact]}>{rating.toFixed(1)}</Text>
      {typeof count === 'number' ? (
        <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.count, { color: light ? '#E8EFEC' : palette.muted }, compact && styles.compact]}>
          ({count.toLocaleString()})
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  rating: {
    fontSize: 14,
    fontWeight: '800',
  },
  count: {
    fontSize: 13,
    fontWeight: '600',
  },
  compact: {
    fontSize: 12,
  },
});

