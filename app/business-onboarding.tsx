import { useEffect, useState, type ComponentType } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { palette, spacing } from '@/constants/theme';

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

function BusinessOnboardingLoadError() {
  return (
    <View role="main" style={styles.screen}>
      <View accessibilityRole="alert" style={styles.loading}>
        <Text accessibilityRole="header" style={styles.title}>
          Business verification is temporarily unavailable
        </Text>
        <Text style={styles.body}>
          Your information has not been submitted. Refresh this screen or reopen Spottr to try
          again.
        </Text>
      </View>
    </View>
  );
}

export default function BusinessOnboardingRoute() {
  const [Screen, setScreen] = useState<ComponentType | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void import('@/components/business-onboarding-screen')
      .then((module) => {
        if (!active) return;
        setScreen(() => module.default);
      })
      .catch(() => {
        if (!active) return;
        setLoadFailed(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!Screen || Platform.OS !== 'web' || typeof window === 'undefined') return;
    window.dispatchEvent(new Event('spottr:route-content-ready'));
  }, [Screen]);

  if (loadFailed) return <BusinessOnboardingLoadError />;
  if (!Screen) return <BusinessOnboardingLoading />;
  return <Screen />;
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
