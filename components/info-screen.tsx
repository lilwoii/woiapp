import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';

type Props = PropsWithChildren<{
  eyebrow: string;
  title: string;
  summary: string;
}>;

export function InfoScreen({ eyebrow, title, summary, children }: Props) {
  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} style={styles.screen}>
      <PageShell narrow>
        <View style={styles.topbar}>
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}>
            <FontAwesome6 color={palette.ink} name="arrow-left" size={14} />
          </Pressable>
          <BrandMark />
          <View style={styles.spacer} />
        </View>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{eyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          <Text style={styles.summary}>{summary}</Text>
        </View>
        <View style={styles.body}>{children}</View>
      </PageShell>
    </ScrollView>
  );
}

export function InfoSection({
  icon,
  title,
  children,
}: PropsWithChildren<{ icon: keyof typeof FontAwesome6.glyphMap; title: string }>) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionIcon}>
        <FontAwesome6 color={palette.accentDeep} name={icon} size={14} />
      </View>
      <View style={styles.sectionCopy}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          {title}
        </Text>
        <Text style={styles.sectionBody}>{children}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 72 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  backButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  spacer: { width: 48 },
  hero: { gap: spacing.sm, marginTop: spacing.xxxl },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 42,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 46,
  },
  summary: { color: palette.muted, fontSize: 15, lineHeight: 23, maxWidth: 680 },
  body: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    marginTop: spacing.xxl,
    overflow: 'hidden',
  },
  section: {
    alignItems: 'flex-start',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  sectionIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  sectionCopy: { flex: 1, gap: 6 },
  sectionTitle: { color: palette.ink, fontSize: 15, fontWeight: '900' },
  sectionBody: { color: palette.muted, fontSize: 13, lineHeight: 20 },
});
