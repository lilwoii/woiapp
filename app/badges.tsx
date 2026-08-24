import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { TRUST_BADGES, type BadgeAudience, type BadgeTier } from '@/lib/trust-badges';

type BadgeFilter = 'all' | BadgeAudience;

const filters: { id: BadgeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'reviewer', label: 'Reviewers' },
  { id: 'business', label: 'Businesses' },
  { id: 'seller', label: 'Sellers' },
];

const tierColor: Record<BadgeTier, string> = {
  starter: palette.muted,
  bronze: '#8C5B37',
  silver: '#65716D',
  gold: '#8A5A00',
  signature: palette.accentDeep,
};

export default function BadgesScreen() {
  const [filter, setFilter] = useState<BadgeFilter>('reviewer');
  const badges = useMemo(
    () => TRUST_BADGES.filter((badge) => filter === 'all' || badge.audience === filter),
    [filter]
  );

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
              <FontAwesome6 color={palette.ink} name="arrow-left" size={13} />
            </Pressable>
            <Text style={styles.topbarTitle}>Badge guide</Text>
            <View style={styles.topbarSpacer} />
          </View>

          <View style={styles.hero}>
            <View style={styles.heroIcon}><FontAwesome6 color="#FFFFFF" name="award" size={21} /></View>
            <Text accessibilityRole="header" style={styles.heroTitle}>Trust you can inspect.</Text>
            <Text style={styles.heroBody}>
              Badges recognize real contributions and verified performance. They never replace the review itself, guarantee a business, or hide critical feedback.
            </Text>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters}>
            <View accessibilityRole="tablist" style={styles.filterRow}>
              {filters.map((item) => {
                const selected = filter === item.id;
                return (
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    key={item.id}
                    onPress={() => setFilter(item.id)}
                    style={[styles.filter, selected && styles.filterActive]}>
                    <Text style={[styles.filterText, selected && styles.filterTextActive]}>{item.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          <View style={styles.catalogHeader}>
            <Text style={styles.catalogTitle}>{badges.length} ways to build trust</Text>
            <Text style={styles.catalogDetail}>Requirements use approved, eligible activity and can exclude fraud, reversals, self-interactions, and enforcement actions.</Text>
          </View>

          <View style={styles.catalog}>
            {badges.map((badge) => (
              <View accessibilityLabel={`${badge.title}. ${badge.description} Requirement: ${badge.requirement}`} key={badge.code} style={styles.badgeRow}>
                <View style={[styles.badgeIcon, { borderColor: tierColor[badge.tier] }]}>
                  <FontAwesome6 color={tierColor[badge.tier]} name={badge.icon} size={13} />
                </View>
                <View style={styles.badgeCopy}>
                  <View style={styles.badgeTitleRow}>
                    <Text style={styles.badgeTitle}>{badge.title}</Text>
                    <Text style={[styles.tier, { color: tierColor[badge.tier] }]}>{badge.tier}</Text>
                  </View>
                  <Text style={styles.badgeDescription}>{badge.description}</Text>
                  <Text style={styles.badgeRequirement}>{badge.requirement}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.integrityNote}>
            <FontAwesome6 color={palette.success} name="shield-halved" size={14} />
            <Text style={styles.integrityText}>Sponsored placement is always labeled separately. Businesses cannot purchase achievements or a better organic review rank.</Text>
          </View>
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 120, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  backButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  topbarTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  topbarSpacer: { width: 42 },
  hero: { alignItems: 'center', marginTop: spacing.xxxl, paddingHorizontal: spacing.lg },
  heroIcon: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 22, height: 44, justifyContent: 'center', marginBottom: spacing.md, width: 44 },
  heroTitle: { color: palette.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1, textAlign: 'center' },
  heroBody: { color: palette.muted, fontSize: 12, lineHeight: 19, marginTop: spacing.sm, maxWidth: 520, textAlign: 'center' },
  filters: { marginHorizontal: -spacing.lg, marginTop: spacing.xxl },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: spacing.lg },
  filter: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, minHeight: 42, justifyContent: 'center', paddingHorizontal: 16 },
  filterActive: { backgroundColor: palette.dark, borderColor: palette.dark },
  filterText: { color: palette.muted, fontSize: 11, fontWeight: '900' },
  filterTextActive: { color: '#FFFFFF' },
  catalogHeader: { gap: 6, marginTop: spacing.xxl },
  catalogTitle: { color: palette.ink, fontSize: 19, fontWeight: '900', letterSpacing: -0.4 },
  catalogDetail: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  catalog: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.xl, borderWidth: 1, marginTop: spacing.lg, overflow: 'hidden' },
  badgeRow: { alignItems: 'flex-start', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.md, padding: spacing.md },
  badgeIcon: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: radii.md, borderWidth: 1, height: 40, justifyContent: 'center', width: 40 },
  badgeCopy: { flex: 1, gap: 4 },
  badgeTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  badgeTitle: { color: palette.ink, flex: 1, fontSize: 12, fontWeight: '900' },
  tier: { fontSize: 8, fontWeight: '900', letterSpacing: 0.7, textTransform: 'uppercase' },
  badgeDescription: { color: palette.muted, fontSize: 10, lineHeight: 15 },
  badgeRequirement: { color: palette.ink, fontSize: 9, fontWeight: '800', lineHeight: 14 },
  integrityNote: { alignItems: 'flex-start', backgroundColor: palette.successSoft, borderRadius: radii.lg, flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl, padding: spacing.md },
  integrityText: { color: palette.success, flex: 1, fontSize: 10, fontWeight: '700', lineHeight: 16 },
});
