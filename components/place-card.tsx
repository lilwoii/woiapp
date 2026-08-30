import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { OwnerUpdate } from '@/components/owner-update';
import { Rating } from '@/components/rating';
import { StatusPill } from '@/components/status-pill';
import { palette, radii, spacing } from '@/constants/theme';
import { showMessage } from '@/lib/platform-dialog';
import { ActionResult, Place } from '@/types/marketplace';

type Props = {
  place: Place;
  followed: boolean;
  onToggleFollow: (placeId: string) => Promise<ActionResult>;
  compact?: boolean;
};

export function PlaceCard({ place, followed, onToggleFollow, compact = false }: Props) {
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    const result = await onToggleFollow(place.id);
    setSaving(false);
    if (!result.ok && result.code === 'AUTH_REQUIRED') {
      router.push('/auth');
      return;
    }
    if (!result.ok) showMessage('Follow could not be updated', result.reason);
  };

  return (
    <View style={[styles.card, compact && styles.compactCard]}>
      <Pressable
        accessibilityLabel={`View ${place.name}`}
        accessibilityRole="link"
        onPress={() => router.push(`/place/${place.id}`)}
        style={({ pressed }) => [styles.cardAction, pressed && styles.pressed]}>
        <Image
          accessibilityLabel={`${place.name} food and business photo`}
          source={
            place.coverImageUrl
              ? { uri: place.coverImageUrl }
              : require('../assets/images/spottr-icon.png')
          }
          style={[styles.image, compact && styles.compactImage]}
        />
        <View style={styles.body}>
          <View style={styles.topRow}>
            <StatusPill compact status={place.status} />
          </View>

          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={styles.name}>
              {place.name}
            </Text>
            {place.verified ? (
              <FontAwesome6 color={palette.success} name="circle-check" size={15} solid />
            ) : null}
          </View>

          <View style={styles.metaRow}>
            <Rating compact count={place.reviewCount} rating={place.rating} />
            <Text style={styles.dot}>·</Text>
            <Text style={styles.meta}>{'$'.repeat(place.priceLevel)}</Text>
            <Text style={styles.dot}>·</Text>
            {place.distanceMiles !== null ? (
              <Text style={styles.meta}>{place.distanceMiles.toFixed(1)} mi</Text>
            ) : null}
          </View>

          <Text numberOfLines={1} style={styles.cuisine}>
            {place.categoryLabel} · {place.cuisines.join(' · ')}
          </Text>
          {place.mobility ? (
            <View style={styles.movingRow}>
              <FontAwesome6 color={palette.warning} name="truck-fast" size={12} />
              <View style={styles.movingCopy}>
                <Text numberOfLines={1} style={styles.movingAddress}>
                  Next: {[
                    place.mobility.nextStop.address,
                    place.mobility.nextStop.city,
                    place.mobility.nextStop.region,
                  ].filter(Boolean).join(', ')}
                </Text>
                <Text numberOfLines={1} style={styles.movingWindow}>
                  {place.mobility.nextStop.timeWindow}
                </Text>
              </View>
            </View>
          ) : (
            <Text numberOfLines={1} style={styles.hours}>
              {place.todayHours}
            </Text>
          )}

          <View style={styles.paymentRow}>
            <FontAwesome6 color={palette.muted} name="wallet" size={12} />
            <Text numberOfLines={1} style={styles.paymentText}>
              {place.payments.length ? place.payments.slice(0, 3).join(' · ') : 'Payments not confirmed'}
              {place.payments.length > 3 ? ` +${place.payments.length - 3}` : ''}
            </Text>
          </View>

          {place.update && !compact ? <OwnerUpdate update={place.update} /> : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityLabel={followed ? `Unfollow ${place.name}` : `Follow ${place.name}`}
        accessibilityRole="button"
        accessibilityState={{ busy: saving, selected: followed }}
        disabled={saving}
        hitSlop={8}
        onPress={toggle}
        style={[styles.saveButton, followed && styles.saveButtonActive]}>
        {saving ? (
          <ActivityIndicator color={followed ? palette.accentDeep : palette.ink} size="small" />
        ) : (
          <FontAwesome6
            color={followed ? palette.accentDeep : palette.ink}
            name="heart"
            size={14}
            solid={followed}
          />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    minHeight: 172,
    overflow: 'hidden',
    position: 'relative',
  },
  compactCard: {
    minHeight: 142,
  },
  cardAction: {
    flex: 1,
    flexDirection: 'row',
  },
  pressed: {
    opacity: 0.9,
    transform: [{ scale: 0.995 }],
  },
  image: {
    backgroundColor: palette.line,
    width: 156,
  },
  compactImage: {
    width: 124,
  },
  body: {
    flex: 1,
    gap: 7,
    padding: spacing.md,
    paddingRight: 58,
  },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 12,
    top: 12,
    width: 44,
    zIndex: 4,
  },
  saveButtonActive: {
    backgroundColor: palette.accentSoft,
    borderColor: palette.accentSoft,
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  name: {
    color: palette.ink,
    flexShrink: 1,
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  meta: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  dot: {
    color: palette.mutedLight,
  },
  cuisine: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  hours: {
    color: palette.muted,
    fontSize: 12,
  },
  movingRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 7,
  },
  movingCopy: {
    flex: 1,
    gap: 1,
  },
  movingAddress: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  movingWindow: {
    color: palette.warning,
    fontSize: 10,
    fontWeight: '800',
  },
  paymentRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  paymentText: {
    color: palette.muted,
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
  },
});
