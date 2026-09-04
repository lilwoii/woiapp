import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useRef } from 'react';
import { AppState, ImageBackground, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { palette, radii, spacing } from '@/constants/theme';
import type { SponsoredPlace } from '@/types/marketplace';

type Props = {
  interactionReady: boolean;
  place: SponsoredPlace;
  reasonOpen: boolean;
  onHide: () => void;
  onImpression: () => void;
  onOpen: () => void;
  onToggleReason: () => void;
};

const MINIMUM_VISIBLE_RATIO = 0.5;
const MINIMUM_VISIBLE_DURATION_MS = 1_000;
const VISIBILITY_POLL_MS = 250;

export function SponsoredLane({
  interactionReady,
  place,
  reasonOpen,
  onHide,
  onImpression,
  onOpen,
  onToggleReason,
}: Props) {
  const placement = place.sponsoredPlacement;
  const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();
  const containerRef = useRef<View>(null);
  const impressionCallback = useRef(onImpression);
  const impressionSent = useRef(false);
  const wide = viewportWidth >= 900;
  useEffect(() => {
    impressionCallback.current = onImpression;
  }, [onImpression]);
  useEffect(() => {
    impressionSent.current = false;
    let mounted = true;
    let foreground = AppState.currentState === 'active';
    let visibleSince: number | null = null;
    const measureVisibility = () => {
      if (!mounted || !foreground || impressionSent.current) return;
      containerRef.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
        if (!mounted || !foreground || impressionSent.current) return;
        if (measuredWidth <= 0 || measuredHeight <= 0) {
          visibleSince = null;
          return;
        }
        const visibleWidth = Math.max(
          0,
          Math.min(x + measuredWidth, viewportWidth) - Math.max(x, 0),
        );
        const visibleHeight = Math.max(
          0,
          Math.min(y + measuredHeight, viewportHeight) - Math.max(y, 0),
        );
        const visibleRatio = (visibleWidth * visibleHeight) / (measuredWidth * measuredHeight);
        if (visibleRatio < MINIMUM_VISIBLE_RATIO) {
          visibleSince = null;
          return;
        }
        const now = Date.now();
        visibleSince ??= now;
        if (now - visibleSince >= MINIMUM_VISIBLE_DURATION_MS) {
          impressionSent.current = true;
          impressionCallback.current();
        }
      });
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      foreground = state === 'active';
      if (!foreground) visibleSince = null;
    });
    const visibilityTimer = setInterval(measureVisibility, VISIBILITY_POLL_MS);
    measureVisibility();
    return () => {
      mounted = false;
      clearInterval(visibilityTimer);
      appStateSubscription.remove();
    };
  }, [placement.id, viewportHeight, viewportWidth]);
  if (!placement) return null;

  return (
    <View
      ref={containerRef}
      accessibilityLabel="Sponsored nearby"
      collapsable={false}
      style={styles.section}>
      <View style={styles.headingRow}>
        <Text accessibilityRole="header" style={styles.heading}>Sponsored nearby</Text>
        <Text style={styles.headingDetail}>A separate paid placement</Text>
      </View>
      <View style={[styles.placement, wide && styles.placementWide]}>
        <ImageBackground
          accessibilityIgnoresInvertColors
          imageStyle={styles.image}
          source={{ uri: place.coverImageUrl }}
          style={[styles.imageFrame, wide && styles.imageFrameWide]}>
          <View style={styles.imageShade} />
          <View style={styles.adBadge}>
            <Text style={styles.adBadgeText}>{placement.disclosure}</Text>
          </View>
          <View style={styles.imageCopy}>
            <Text numberOfLines={1} style={styles.name}>{place.name}</Text>
            <Text numberOfLines={1} style={styles.meta}>
              {place.categoryLabel} · {place.cuisines.slice(0, 2).join(' · ')}
            </Text>
          </View>
        </ImageBackground>
        <View style={[styles.sponsorControls, wide && styles.sponsorControlsWide]}>
          <View style={styles.actions}>
            <Pressable
              accessibilityLabel="Why this ad?"
              accessibilityRole="button"
              accessibilityState={{ expanded: reasonOpen }}
              onPress={onToggleReason}
              style={styles.quietButton}>
              <FontAwesome6 color={palette.muted} name="circle-info" size={11} />
              <Text style={styles.quietText}>Why this ad?</Text>
            </Pressable>
            <Pressable accessibilityLabel={`Hide sponsored ad for ${place.name}`} accessibilityRole="button" onPress={onHide} style={styles.quietButton}>
              <FontAwesome6 color={palette.muted} name="eye-slash" size={11} />
              <Text style={styles.quietText}>Hide</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`View sponsored listing for ${place.name}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !interactionReady }}
              disabled={!interactionReady}
              onPress={onOpen}
              style={[styles.openButton, !interactionReady && styles.openButtonDisabled]}>
              <Text style={styles.openText}>View menu</Text>
              <FontAwesome6 color="#FFFFFF" name="arrow-right" size={10} />
            </Pressable>
          </View>
          {reasonOpen ? (
            <View accessibilityLiveRegion="polite" style={styles.reason}>
              <Text style={styles.reasonText}>{placement.reason} Payment did not change Spottr’s organic results.</Text>
            </View>
          ) : (
            <Text style={styles.organicNote}>Relevant paid visibility. Organic ranking stays unchanged.</Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm, marginBottom: spacing.xl },
  headingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
  heading: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  headingDetail: { color: palette.muted, fontSize: 9 },
  placement: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.sm, paddingBottom: spacing.md },
  placementWide: { alignItems: 'stretch', flexDirection: 'row' },
  imageFrame: { height: 150, justifyContent: 'space-between', overflow: 'hidden', padding: spacing.md },
  imageFrameWide: { flex: 1.35, height: 118 },
  image: { borderRadius: radii.xl },
  imageShade: { backgroundColor: 'rgba(14, 24, 22, 0.38)', borderRadius: radii.xl, bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  adBadge: { alignSelf: 'flex-start', backgroundColor: 'rgba(255, 253, 248, 0.96)', borderRadius: radii.pill, paddingHorizontal: 9, paddingVertical: 6 },
  adBadgeText: { color: palette.ink, fontSize: 9, fontWeight: '900' },
  imageCopy: { gap: 3 },
  name: { color: '#FFFFFF', fontSize: 23, fontWeight: '900', letterSpacing: -0.5 },
  meta: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  actions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sponsorControls: { gap: spacing.sm },
  sponsorControlsWide: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.md },
  quietButton: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 44, paddingHorizontal: 6 },
  quietText: { color: palette.muted, fontSize: 9, fontWeight: '800' },
  openButton: { alignItems: 'center', backgroundColor: palette.ink, borderRadius: radii.pill, flexDirection: 'row', gap: 7, justifyContent: 'center', marginLeft: 'auto', minHeight: 44, paddingHorizontal: 15 },
  openButtonDisabled: { opacity: 0.5 },
  openText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  reason: { backgroundColor: palette.bg, borderRadius: radii.md, padding: spacing.md },
  reasonText: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  organicNote: { color: palette.muted, fontSize: 9, lineHeight: 14 },
});
