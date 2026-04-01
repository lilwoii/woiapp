import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SectionTitle } from '@/components/section-title';
import { palette, spacing } from '@/constants/theme';
import { averageRating, useTruckStore } from '@/context/truck-store';

export default function ReviewsScreen() {
  const { trucks } = useTruckStore();

  const latestReviews = trucks
    .flatMap((truck) => truck.reviews.map((review) => ({ ...review, truckId: truck.id, truckName: truck.name })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const topRated = [...trucks].sort((a, b) => averageRating(b) - averageRating(a)).slice(0, 3);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionTitle
        eyebrow="Community"
        title="In-app reviews keep the whole experience in one lane."
        detail="No Yelp handoff, no outdated posts, and no guessing if the truck is actually there."
      />

      <View style={styles.heroStrip}>
        {topRated.map((truck, index) => (
          <Link href={`/truck/${truck.id}`} asChild key={truck.id}>
            <Pressable style={[styles.heroCard, index === 0 && styles.heroCardWide]}>
              <Text style={styles.rank}>#{index + 1}</Text>
              <Text style={[styles.heroName, index === 0 && styles.heroNameLight]}>{truck.name}</Text>
              <Text style={[styles.heroMeta, index === 0 && styles.heroMetaLight]}>
                {averageRating(truck).toFixed(1)} stars - {truck.reviews.length} reviews
              </Text>
            </Pressable>
          </Link>
        ))}
      </View>

      <View style={styles.feed}>
        {latestReviews.map((review) => (
          <Link href={`/truck/${review.truckId}`} asChild key={review.id}>
            <Pressable style={styles.reviewCard}>
              <Text style={styles.reviewTruck}>{review.truckName}</Text>
              <Text style={styles.reviewMeta}>
                {review.author} - {review.rating} stars
              </Text>
              <Text style={styles.reviewBody}>{review.comment}</Text>
            </Pressable>
          </Link>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    gap: spacing.xl,
    padding: spacing.lg,
    paddingBottom: 120,
  },
  heroStrip: {
    gap: spacing.md,
  },
  heroCard: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: 28,
    borderWidth: 1,
    gap: 6,
    padding: spacing.lg,
  },
  heroCardWide: {
    backgroundColor: '#18291E',
  },
  rank: {
    color: palette.accent,
    fontSize: 12,
    fontWeight: '800',
  },
  heroName: {
    color: palette.ink,
    fontSize: 22,
    fontWeight: '800',
  },
  heroNameLight: {
    color: '#fff',
  },
  heroMeta: {
    color: palette.muted,
    fontSize: 14,
    fontWeight: '700',
  },
  heroMetaLight: {
    color: '#E3EEE7',
  },
  feed: {
    gap: spacing.md,
  },
  reviewCard: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 22,
    borderWidth: 1,
    gap: 6,
    padding: spacing.lg,
  },
  reviewTruck: {
    color: palette.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  reviewMeta: {
    color: palette.accentDeep,
    fontSize: 13,
    fontWeight: '700',
  },
  reviewBody: {
    color: palette.ink,
    fontSize: 14,
    lineHeight: 20,
  },
});
