import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams } from 'expo-router';

import { SectionTitle } from '@/components/section-title';
import { palette, spacing } from '@/constants/theme';
import { averageRating, useTruckStore } from '@/context/truck-store';

export default function TruckDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { trucks, addReview } = useTruckStore();
  const truck = trucks.find((entry) => entry.id === id);
  const [author, setAuthor] = useState('');
  const [comment, setComment] = useState('');
  const [rating, setRating] = useState(5);

  if (!truck) {
    return (
      <View style={styles.missingWrap}>
        <Text style={styles.missingText}>Truck not found.</Text>
      </View>
    );
  }

  const submitReview = () => {
    if (!comment.trim()) {
      Alert.alert('Add a review', 'Write a few words about the food or the location experience.');
      return;
    }

    addReview(truck.id, { author, comment, rating });
    setAuthor('');
    setComment('');
    setRating(5);
    Alert.alert('Review posted', `Your ${rating}-star review is now live in ${truck.name}.`);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <LinearGradient colors={['#FFF2E6', truck.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
        <Text style={styles.heroLabel}>{truck.status}</Text>
        <Text style={styles.heroTitle}>{truck.name}</Text>
        <Text style={styles.heroMeta}>
          {truck.cuisine} - {averageRating(truck).toFixed(1)} stars - {truck.reviews.length} reviews
        </Text>
        <Text style={styles.heroBody}>{truck.description}</Text>
        <Text style={styles.heroFoot}>{truck.address}</Text>
        <Text style={styles.heroFoot}>{truck.hoursLabel}</Text>
      </LinearGradient>

      <View style={styles.section}>
        <SectionTitle eyebrow="Menu" title="Current lineup" detail={truck.coverNote} />
        <View style={styles.menuList}>
          {truck.menu.map((item) => (
            <View key={item.id} style={styles.menuRow}>
              <View style={styles.menuText}>
                <Text style={styles.menuName}>{item.name}</Text>
                {item.tag ? <Text style={styles.menuTag}>{item.tag}</Text> : null}
              </View>
              <Text style={styles.menuPrice}>{item.price}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <SectionTitle
          eyebrow="Add review"
          title="Keep it useful"
          detail="Rate the food, accuracy of the location, and whether the owner update matched reality."
        />
        <View style={styles.reviewComposer}>
          <TextInput
            placeholder="Your name"
            placeholderTextColor={palette.muted}
            style={styles.input}
            value={author}
            onChangeText={setAuthor}
          />
          <View style={styles.ratingRow}>
            {[1, 2, 3, 4, 5].map((value) => (
              <Pressable
                key={value}
                style={[styles.ratingChip, rating === value && styles.ratingChipActive]}
                onPress={() => setRating(value)}>
                <Text style={[styles.ratingText, rating === value && styles.ratingTextActive]}>{value} stars</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            placeholder="How was it?"
            placeholderTextColor={palette.muted}
            style={[styles.input, styles.reviewInput]}
            multiline
            value={comment}
            onChangeText={setComment}
          />
          <Pressable style={styles.submitButton} onPress={submitReview}>
            <Text style={styles.submitText}>Post review</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <SectionTitle eyebrow="Recent reviews" title="What people are saying" />
        <View style={styles.reviewList}>
          {truck.reviews.map((review) => (
            <View key={review.id} style={styles.reviewCard}>
              <Text style={styles.reviewAuthor}>
                {review.author} - {review.rating} stars
              </Text>
              <Text style={styles.reviewComment}>{review.comment}</Text>
            </View>
          ))}
        </View>
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
    paddingBottom: 80,
  },
  hero: {
    borderRadius: 30,
    gap: spacing.sm,
    padding: spacing.xl,
  },
  heroLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1.1,
  },
  heroMeta: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  heroBody: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 22,
  },
  heroFoot: {
    color: '#fff',
    fontSize: 14,
  },
  section: {
    gap: spacing.lg,
  },
  menuList: {
    gap: spacing.sm,
  },
  menuRow: {
    alignItems: 'center',
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.md,
  },
  menuText: {
    flex: 1,
    gap: 4,
  },
  menuName: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  menuTag: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '700',
  },
  menuPrice: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  reviewComposer: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: 28,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 18,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  reviewInput: {
    minHeight: 110,
    paddingTop: 14,
    textAlignVertical: 'top',
  },
  ratingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  ratingChip: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  ratingChipActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  ratingText: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  ratingTextActive: {
    color: '#fff',
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: 999,
    paddingVertical: 14,
  },
  submitText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  reviewList: {
    gap: spacing.md,
  },
  reviewCard: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 22,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  reviewAuthor: {
    color: palette.accentDeep,
    fontSize: 14,
    fontWeight: '800',
  },
  reviewComment: {
    color: palette.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  missingWrap: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    justifyContent: 'center',
  },
  missingText: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: '700',
  },
});
