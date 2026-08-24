import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radii } from '@/constants/theme';
import { badgeAccessibilityLabel, type PublicBadge } from '@/lib/trust-badges';

const tierColor: Record<PublicBadge['tier'], string> = {
  starter: palette.muted,
  bronze: '#8C5B37',
  silver: '#65716D',
  gold: '#8A5A00',
  signature: palette.accentDeep,
};

type TrustBadgeStripProps = {
  badges: readonly PublicBadge[];
  limit?: number;
  showLabels?: boolean;
};

export function TrustBadgeStrip({ badges, limit = 3, showLabels = false }: TrustBadgeStripProps) {
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const visible = badges.slice(0, limit);
  if (!visible.length) return null;

  return (
    <View accessibilityRole="list" style={styles.wrap}>
      {visible.map((badge) => {
        const expanded = activeCode === badge.code;
        return (
          <View key={badge.code} style={styles.badgeWrap}>
            <Pressable
              accessibilityHint="Shows badge details"
              accessibilityLabel={badgeAccessibilityLabel(badge)}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onHoverIn={() => setActiveCode(badge.code)}
              onHoverOut={() => setActiveCode((current) => current === badge.code ? null : current)}
              onPress={() => setActiveCode((current) => current === badge.code ? null : badge.code)}
              style={[styles.badge, { borderColor: tierColor[badge.tier] }]}>
              <FontAwesome6 color={tierColor[badge.tier]} name={badge.icon} size={9} />
              {showLabels ? <Text style={[styles.label, { color: tierColor[badge.tier] }]}>{badge.shortLabel}</Text> : null}
            </Pressable>
            {expanded ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/badges')}
                style={styles.tooltip}>
                <Text style={styles.tooltipTitle}>{badge.title}</Text>
                <Text style={styles.tooltipBody}>{badge.requirement}</Text>
                <Text style={styles.tooltipLink}>{Platform.OS === 'web' ? 'View all badges →' : 'Open badge guide →'}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      {badges.length > visible.length ? (
        <Pressable
          accessibilityLabel={`View ${badges.length - visible.length} more badges`}
          accessibilityRole="link"
          onPress={() => router.push('/badges')}
          style={styles.more}>
          <Text style={styles.moreText}>+{badges.length - visible.length}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  badgeWrap: { position: 'relative', zIndex: 2 },
  badge: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  label: { fontSize: 8, fontWeight: '900', letterSpacing: 0.2 },
  tooltip: {
    backgroundColor: palette.dark,
    borderRadius: radii.md,
    elevation: 8,
    gap: 3,
    left: 0,
    minWidth: 210,
    padding: 12,
    position: 'absolute',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    top: 28,
    zIndex: 20,
  },
  tooltipTitle: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  tooltipBody: { color: palette.darkMuted, fontSize: 9, lineHeight: 14 },
  tooltipLink: { color: '#FFFFFF', fontSize: 9, fontWeight: '900', marginTop: 3 },
  more: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    height: 24,
    justifyContent: 'center',
    minWidth: 28,
    paddingHorizontal: 7,
  },
  moreText: { color: palette.muted, fontSize: 8, fontWeight: '900' },
});
