import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { OwnerUpdate } from '@/components/owner-update';
import { Rating } from '@/components/rating';
import { StatusPill } from '@/components/status-pill';
import { palette, radii, spacing } from '@/constants/theme';
import { Place } from '@/types/marketplace';

type Props = {
  place: Place;
  followed: boolean;
  onToggleFollow: (placeId: string) => void;
  compact?: boolean;
};

export function PlaceCard({ place, followed, onToggleFollow, compact = false }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`View ${place.name}`}
      onPress={() => router.push(`/place/${place.id}`)}
      style={({ pressed }) => [styles.card, compact && styles.compactCard, pressed && styles.pressed]}>
      <Image source={{ uri: place.coverImageUrl }} style={[styles.image, compact && styles.compactImage]} />
      <View style={styles.body}>
        <View style={styles.topRow}>
          <StatusPill compact status={place.status} />
          <Pressable
            accessibilityLabel={followed ? `Unfollow ${place.name}` : `Follow ${place.name}`}
            hitSlop={12}
            onPress={(event) => {
              event.stopPropagation();
              onToggleFollow(place.id);
            }}
            style={[styles.saveButton, followed && styles.saveButtonActive]}>
            <FontAwesome6
              color={followed ? palette.accent : palette.ink}
              name={followed ? 'heart' : 'heart'}
              size={14}
              solid={followed}
            />
          </Pressable>
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
          <Text style={styles.meta}>{place.distanceMiles.toFixed(1)} mi</Text>
        </View>

        <Text numberOfLines={1} style={styles.cuisine}>
          {place.categoryLabel} · {place.cuisines.join(' · ')}
        </Text>
        <Text numberOfLines={1} style={styles.hours}>
          {place.todayHours}
        </Text>

        <View style={styles.paymentRow}>
          <FontAwesome6 color={palette.muted} name="wallet" size={12} />
          <Text numberOfLines={1} style={styles.paymentText}>
            {place.payments.slice(0, 3).join(' · ')}
            {place.payments.length > 3 ? ` +${place.payments.length - 3}` : ''}
          </Text>
        </View>

        {place.update && !compact ? <OwnerUpdate update={place.update} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 172,
    overflow: 'hidden',
  },
  compactCard: {
    minHeight: 142,
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
  },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
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

