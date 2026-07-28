import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { palette, radii, spacing } from '@/constants/theme';

export default function NotFoundScreen() {
  return (
    <View style={styles.screen}>
      <BrandMark />
      <View style={styles.icon}>
        <FontAwesome6 color={palette.accent} name="location-dot" size={23} />
      </View>
      <Text style={styles.title}>We couldn’t find that stop.</Text>
      <Text style={styles.detail}>The listing may have moved, expired, or changed its public link.</Text>
      <Link href="/" asChild>
        <Pressable style={styles.button}>
          <Text style={styles.buttonText}>Back to discovery</Text>
        </Pressable>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 54,
    justifyContent: 'center',
    marginTop: spacing.xl,
    width: 54,
  },
  title: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.7,
    textAlign: 'center',
  },
  detail: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 20,
    maxWidth: 420,
    textAlign: 'center',
  },
  button: {
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    marginTop: spacing.sm,
    paddingHorizontal: 17,
    paddingVertical: 12,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
});

