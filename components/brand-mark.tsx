import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

type Props = {
  compact?: boolean;
  light?: boolean;
};

export function BrandMark({ compact = false, light = false }: Props) {
  const ink = light ? '#FFFFFF' : palette.ink;

  return (
    <View accessibilityLabel="Spottr" accessibilityRole="image" style={styles.wrap}>
      <View style={[styles.mark, { borderColor: ink }]}>
        <View style={[styles.compassNeedle, { backgroundColor: palette.accent }]} />
        <View style={[styles.compassDot, { backgroundColor: ink }]} />
      </View>
      {!compact ? <Text style={[styles.wordmark, { color: ink }]}>Spottr</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  mark: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 2,
    height: 31,
    justifyContent: 'center',
    transform: [{ rotate: '-18deg' }],
    width: 31,
  },
  compassNeedle: {
    borderRadius: 999,
    height: 13,
    position: 'absolute',
    top: 2,
    width: 5,
  },
  compassDot: {
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  wordmark: {
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.9,
  },
});
