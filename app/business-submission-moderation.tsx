import { lazy, Suspense } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { PageShell } from '@/components/page-shell';
import { palette, spacing } from '@/constants/theme';

const BusinessSubmissionModerationScreen = lazy(
  () => import('@/components/business-submission-moderation-screen'),
);

function BusinessSubmissionModerationLoading() {
  return (
    <View style={styles.screen}>
      <PageShell narrow>
        <View accessibilityLiveRegion="polite" style={styles.loading}>
          <Text accessibilityRole="header" style={styles.title}>
            Protected business approvals
          </Text>
          <ActivityIndicator
            accessibilityLabel="Loading business approvals"
            color={palette.accentDeep}
          />
          <Text style={styles.body}>Loading the secure approval workspace…</Text>
        </View>
      </PageShell>
    </View>
  );
}

export default function BusinessSubmissionModerationRoute() {
  return (
    <Suspense fallback={<BusinessSubmissionModerationLoading />}>
      <BusinessSubmissionModerationScreen />
    </Suspense>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  loading: {
    alignItems: 'center',
    gap: spacing.md,
    justifyContent: 'center',
    minHeight: 360,
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
