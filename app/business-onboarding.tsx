import { lazy, Suspense } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { palette, spacing } from '@/constants/theme';

const BusinessOnboardingScreen = lazy(
  () => import('@/components/business-onboarding-screen'),
);

function BusinessOnboardingLoading() {
  return (
    <View role="main" style={styles.screen}>
      <View accessibilityLiveRegion="polite" style={styles.loading}>
        <Text accessibilityRole="header" style={styles.title}>
          Business verification
        </Text>
        <ActivityIndicator
          accessibilityLabel="Loading business verification"
          color={palette.accentDeep}
        />
        <Text style={styles.body}>Loading the secure business workspace…</Text>
      </View>
    </View>
  );
}

export default function BusinessOnboardingRoute() {
  return (
    <Suspense fallback={<BusinessOnboardingLoading />}>
      <BusinessOnboardingScreen />
    </Suspense>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  loading: {
    alignItems: 'center',
    gap: spacing.md,
    justifyContent: 'center',
    minHeight: 260,
    paddingVertical: spacing.xl,
  },
  title: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
  },
  body: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});
