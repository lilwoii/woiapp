import FontAwesome from '@expo/vector-icons/FontAwesome';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Image,
  ImageBackground,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { OwnerUpdate } from '@/components/owner-update';
import { PageShell } from '@/components/page-shell';
import { Rating } from '@/components/rating';
import { SectionHeading } from '@/components/section-heading';
import { StatusPill } from '@/components/status-pill';
import { palette, radii, spacing } from '@/constants/theme';
import { useMarketplaceStore } from '@/context/marketplace-store';

export default function PlaceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { addReview, followedIds, places, toggleFollow } = useMarketplaceStore();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const place = places.find((entry) => entry.id === id);
  const [rating, setRating] = useState(5);
  const [review, setReview] = useState('');
  const [reviewPhotos, setReviewPhotos] = useState<string[]>([]);
  const [showAllHours, setShowAllHours] = useState(false);
  const [activeMenuSection, setActiveMenuSection] = useState(0);

  if (!place) {
    return (
      <View style={styles.missing}>
        <FontAwesome6 color={palette.accent} name="location-dot" size={24} />
        <Text style={styles.missingTitle}>This listing is unavailable.</Text>
        <Pressable onPress={() => router.back()} style={styles.missingButton}>
          <Text style={styles.missingButtonText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const followed = followedIds.includes(place.id);
  const selectedSection = place.menu[activeMenuSection] ?? place.menu[0];

  const openDirections = () => {
    const url =
      Platform.OS === 'ios'
        ? `maps://?daddr=${place.latitude},${place.longitude}`
        : `https://www.google.com/maps/dir/?api=1&destination=${place.latitude},${place.longitude}`;
    Linking.openURL(url);
  };

  const pickReviewPhoto = async () => {
    if (reviewPhotos.length >= 4) {
      Alert.alert('Photo limit', 'Add up to four photos per review.');
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo access needed', 'Allow photo access to attach images to your review.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      mediaTypes: ['images'],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]?.uri) {
      setReviewPhotos((current) => [...current, result.assets[0].uri]);
    }
  };

  const submitReview = () => {
    const result = addReview(place.id, { rating, comment: review, photos: reviewPhotos });
    if (!result.ok) {
      Alert.alert('Review needs attention', result.reason);
      return;
    }

    setReview('');
    setReviewPhotos([]);
    setRating(5);
    Alert.alert('Review submitted', 'Your review is visible in this preview. Production reviews enter moderation first.');
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell>
        <ImageBackground imageStyle={styles.heroImage} source={{ uri: place.coverImageUrl }} style={styles.hero}>
          <View style={styles.heroShade} />
          <View style={styles.heroTop}>
            <Pressable accessibilityLabel="Go back" onPress={() => router.back()} style={styles.heroButton}>
              <FontAwesome6 color="#FFFFFF" name="arrow-left" size={14} />
            </Pressable>
            <View style={styles.heroActions}>
              <Pressable accessibilityLabel="Share listing" style={styles.heroButton}>
                <FontAwesome6 color="#FFFFFF" name="arrow-up-from-bracket" size={14} />
              </Pressable>
              <Pressable
                accessibilityLabel={followed ? `Unfollow ${place.name}` : `Follow ${place.name}`}
                onPress={() => toggleFollow(place.id)}
                style={[styles.heroButton, followed && styles.heroButtonActive]}>
                <FontAwesome6 color="#FFFFFF" name="heart" size={14} solid={followed} />
              </Pressable>
            </View>
          </View>

          <View style={styles.heroCopy}>
            <View style={styles.heroBadgeRow}>
              <StatusPill status={place.status} />
              <View style={styles.verifiedBadge}>
                <FontAwesome6 color="#FFFFFF" name="circle-check" size={12} solid />
                <Text style={styles.verifiedText}>{place.sourceLabel}</Text>
              </View>
            </View>
            <Text style={[styles.heroTitle, wide && styles.heroTitleWide]}>{place.name}</Text>
            <Text style={styles.heroCategory}>
              {place.categoryLabel} · {place.cuisines.join(' · ')} · {'$'.repeat(place.priceLevel)}
            </Text>
            <View style={styles.heroMeta}>
              <Rating count={place.reviewCount} light rating={place.rating} />
              <Text style={styles.heroMetaDot}>·</Text>
              <Text style={styles.heroMetaText}>{place.distanceMiles.toFixed(1)} mi away</Text>
              <Text style={styles.heroMetaDot}>·</Text>
              <Text style={styles.heroMetaText}>Confirmed {place.lastConfirmedAt}</Text>
            </View>
          </View>
        </ImageBackground>

        <View style={styles.actionBar}>
          <Pressable onPress={openDirections} style={styles.primaryAction}>
            <FontAwesome6 color="#FFFFFF" name="diamond-turn-right" size={14} />
            <Text style={styles.primaryActionText}>Directions</Text>
          </Pressable>
          <Pressable style={styles.secondaryAction}>
            <FontAwesome6 color={palette.ink} name="phone" size={13} />
            <Text style={styles.secondaryActionText}>Call</Text>
          </Pressable>
          <Pressable style={styles.secondaryAction}>
            <FontAwesome6 color={palette.ink} name="globe" size={13} />
            <Text style={styles.secondaryActionText}>Website</Text>
          </Pressable>
          <Pressable
            onPress={() => toggleFollow(place.id)}
            style={[styles.secondaryAction, followed && styles.followAction]}>
            <FontAwesome6 color={followed ? palette.accent : palette.ink} name="heart" size={13} solid={followed} />
            <Text style={[styles.secondaryActionText, followed && styles.followActionText]}>
              {followed ? 'Following' : 'Follow'}
            </Text>
          </Pressable>
        </View>

        <View style={[styles.columns, wide && styles.columnsWide]}>
          <View style={[styles.mainColumn, wide && styles.mainColumnWide]}>
            {place.update ? (
              <View style={styles.section}>
                <OwnerUpdate update={place.update} />
              </View>
            ) : null}

            <View style={styles.section}>
              <SectionHeading eyebrow="About" title={`Meet ${place.name}`} />
              <Text style={styles.description}>{place.description}</Text>
              <View style={styles.featureRow}>
                {place.features.map((feature) => (
                  <View key={feature} style={styles.featureChip}>
                    <FontAwesome6 color={palette.success} name="check" size={10} />
                    <Text style={styles.featureText}>{feature}</Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <SectionHeading
                detail="Prices and availability are maintained by the business."
                eyebrow="Menu"
                title="What’s serving"
              />
              {place.menu.length > 1 ? (
                <ScrollView
                  contentContainerStyle={styles.menuTabs}
                  horizontal
                  showsHorizontalScrollIndicator={false}>
                  {place.menu.map((section, index) => (
                    <Pressable
                      key={section.id}
                      onPress={() => setActiveMenuSection(index)}
                      style={[styles.menuTab, index === activeMenuSection && styles.menuTabActive]}>
                      <Text style={[styles.menuTabText, index === activeMenuSection && styles.menuTabTextActive]}>
                        {section.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}
              <View style={styles.menuList}>
                {selectedSection?.items.map((item) => (
                  <View key={item.id} style={styles.menuItem}>
                    <View style={styles.menuItemCopy}>
                      <View style={styles.menuNameRow}>
                        <Text style={[styles.menuName, item.soldOut && styles.menuSoldOut]}>{item.name}</Text>
                        {item.popular ? <Text style={styles.popularLabel}>Popular</Text> : null}
                      </View>
                      <Text style={styles.menuDescription}>{item.description}</Text>
                      {item.dietary?.length ? (
                        <Text style={styles.dietary}>{item.dietary.join(' · ')}</Text>
                      ) : null}
                    </View>
                    <Text style={styles.menuPrice}>${item.price.toFixed(0)}</Text>
                    {item.photoUrl ? <Image source={{ uri: item.photoUrl }} style={styles.menuImage} /> : null}
                  </View>
                ))}
              </View>
              <Text style={styles.menuFreshness}>Menu confirmed by owner · Prices include no service fees</Text>
            </View>

            <View style={styles.section}>
              <SectionHeading eyebrow="Photos" title="From the counter & community" />
              <ScrollView
                contentContainerStyle={styles.galleryRow}
                horizontal
                showsHorizontalScrollIndicator={false}>
                {place.gallery.map((photo, index) => (
                  <Image key={`${photo}-${index}`} source={{ uri: photo }} style={styles.galleryImage} />
                ))}
              </ScrollView>
            </View>

            <View style={styles.section}>
              <SectionHeading
                detail="First-party reviews from Spottr accounts."
                eyebrow="Community"
                title={`${place.rating.toFixed(1)} from ${place.reviewCount.toLocaleString()} reviews`}
              />
              <View style={styles.reviewSummary}>
                <View>
                  <Text style={styles.reviewScore}>{place.rating.toFixed(1)}</Text>
                  <View style={styles.stars}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <FontAwesome
                        color={star <= Math.round(place.rating) ? palette.sun : palette.line}
                        key={star}
                        name="star"
                        size={14}
                      />
                    ))}
                  </View>
                </View>
                <View style={styles.reliability}>
                  <Text style={styles.reliabilityValue}>{place.reliabilityScore}%</Text>
                  <Text style={styles.reliabilityLabel}>location reliability</Text>
                </View>
              </View>
              <View style={styles.reviewList}>
                {place.reviews.map((item) => (
                  <View key={item.id} style={styles.reviewCard}>
                    <View style={styles.reviewTop}>
                      <View style={styles.reviewerAvatar}>
                        <Text style={styles.reviewerInitial}>{item.displayName.charAt(0)}</Text>
                      </View>
                      <View style={styles.reviewerCopy}>
                        <Text style={styles.reviewerName}>{item.displayName}</Text>
                        <Text style={styles.reviewerMeta}>
                          @{item.username} · {item.createdAt}
                        </Text>
                      </View>
                      <Rating compact rating={item.rating} />
                    </View>
                    <Text style={styles.reviewBody}>{item.comment}</Text>
                    {item.photos.length ? (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={styles.reviewPhotos}>
                          {item.photos.map((photo, index) => (
                            <Image key={`${photo}-${index}`} source={{ uri: photo }} style={styles.reviewPhoto} />
                          ))}
                        </View>
                      </ScrollView>
                    ) : null}
                    <View style={styles.reviewFooter}>
                      <FontAwesome6 color={palette.muted} name="thumbs-up" size={11} />
                      <Text style={styles.reviewHelpful}>Helpful · {item.helpfulCount}</Text>
                    </View>
                    {item.ownerResponse ? (
                      <View style={styles.ownerResponse}>
                        <Text style={styles.ownerResponseLabel}>Response from {place.name}</Text>
                        <Text style={styles.ownerResponseBody}>{item.ownerResponse}</Text>
                      </View>
                    ) : null}
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.reviewComposer}>
              <SectionHeading
                detail="Professional language and image safety checks apply."
                eyebrow="Share your visit"
                title="Write a review"
              />
              <View style={styles.ratingPicker}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <Pressable
                    accessibilityLabel={`${value} star${value === 1 ? '' : 's'}`}
                    key={value}
                    onPress={() => setRating(value)}>
                    <FontAwesome color={value <= rating ? palette.sun : palette.line} name="star" size={25} />
                  </Pressable>
                ))}
                <Text style={styles.ratingPickerText}>{rating}.0</Text>
              </View>
              <TextInput
                maxLength={500}
                multiline
                onChangeText={setReview}
                placeholder="What should other people know?"
                placeholderTextColor={palette.mutedLight}
                style={styles.reviewInput}
                textAlignVertical="top"
                value={review}
              />
              {reviewPhotos.length ? (
                <View style={styles.pendingPhotos}>
                  {reviewPhotos.map((photo, index) => (
                    <View key={`${photo}-${index}`} style={styles.pendingPhotoWrap}>
                      <Image source={{ uri: photo }} style={styles.pendingPhoto} />
                      <Pressable
                        accessibilityLabel="Remove photo"
                        onPress={() => setReviewPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        style={styles.removePhoto}>
                        <FontAwesome6 color="#FFFFFF" name="xmark" size={10} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
              <View style={styles.composerActions}>
                <Pressable onPress={pickReviewPhoto} style={styles.photoButton}>
                  <FontAwesome6 color={palette.ink} name="camera" size={13} />
                  <Text style={styles.photoButtonText}>Add photos</Text>
                </Pressable>
                <Pressable onPress={submitReview} style={styles.submitButton}>
                  <Text style={styles.submitButtonText}>Submit review</Text>
                </Pressable>
              </View>
            </View>
          </View>

          <View style={[styles.sideColumn, wide && styles.sideColumnWide]}>
            <View style={styles.infoPanel}>
              <View style={styles.infoHeader}>
                <Text style={styles.infoTitle}>Location & hours</Text>
                <Text style={styles.infoFresh}>Updated {place.lastConfirmedAt}</Text>
              </View>
              <View style={styles.infoRow}>
                <View style={styles.infoIcon}>
                  <FontAwesome6 color={palette.accent} name="location-dot" size={14} solid />
                </View>
                <View style={styles.infoCopy}>
                  <Text style={styles.infoPrimary}>{place.address}</Text>
                  <Text style={styles.infoSecondary}>
                    {place.category === 'home_kitchen'
                      ? place.serviceArea
                      : `${place.city}, CA ${place.postalCode}`}
                  </Text>
                </View>
              </View>
              <View style={styles.infoRow}>
                <View style={styles.infoIcon}>
                  <FontAwesome6 color={palette.success} name="clock" size={13} />
                </View>
                <View style={styles.infoCopy}>
                  <Text style={styles.infoPrimary}>{place.todayHours}</Text>
                  <Pressable onPress={() => setShowAllHours((current) => !current)}>
                    <Text style={styles.infoLink}>{showAllHours ? 'Hide weekly hours' : 'View weekly hours'}</Text>
                  </Pressable>
                </View>
              </View>
              {showAllHours ? (
                <View style={styles.hoursList}>
                  {place.weeklyHours.map((entry) => (
                    <View key={entry.day} style={styles.hoursRow}>
                      <Text style={styles.hoursDay}>{entry.day.slice(0, 3)}</Text>
                      <Text style={styles.hoursValue}>{entry.closed ? 'Closed' : entry.hours}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {place.nextStop ? (
                <View style={styles.nextStop}>
                  <FontAwesome6 color={palette.accent} name="truck-fast" size={13} />
                  <View style={styles.nextStopCopy}>
                    <Text style={styles.nextStopLabel}>Next stop</Text>
                    <Text style={styles.nextStopText}>{place.nextStop}</Text>
                  </View>
                </View>
              ) : null}
              {place.category === 'home_kitchen' ? (
                <View style={styles.privacyNote}>
                  <FontAwesome6 color={palette.success} name="user-shield" size={13} />
                  <Text style={styles.privacyText}>Residence address is hidden. Exact pickup details are shared privately.</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.infoPanel}>
              <Text style={styles.infoTitle}>Accepted payments</Text>
              <View style={styles.paymentGrid}>
                {place.payments.map((payment) => (
                  <View key={payment} style={styles.paymentChip}>
                    <FontAwesome6 color={palette.ink} name="check" size={10} />
                    <Text style={styles.paymentText}>{payment}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.paymentCaveat}>Payment details confirmed by the business.</Text>
            </View>

            <View style={styles.sourcePanel}>
              <View style={styles.sourceIcon}>
                <FontAwesome6 color={palette.success} name="badge-check" size={18} />
              </View>
              <View style={styles.sourceCopy}>
                <Text style={styles.sourceTitle}>{place.sourceLabel}</Text>
                <Text style={styles.sourceBody}>
                  Hours, menu, payment methods, and live updates come directly from the business.
                </Text>
              </View>
            </View>
          </View>
        </View>
      </PageShell>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    paddingBottom: 72,
  },
  hero: {
    height: 540,
    justifyContent: 'space-between',
    overflow: 'hidden',
    padding: spacing.lg,
  },
  heroImage: {
    backgroundColor: palette.dark,
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8, 15, 13, 0.52)',
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  heroActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  heroButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 26, 24, 0.54)',
    borderColor: 'rgba(255,255,255,0.26)',
    borderRadius: 999,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  heroButtonActive: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  heroCopy: {
    gap: spacing.sm,
    maxWidth: 820,
  },
  heroBadgeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  verifiedBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 26, 24, 0.54)',
    borderColor: 'rgba(255,255,255,0.26)',
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  verifiedText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 43,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 47,
  },
  heroTitleWide: {
    fontSize: 63,
    letterSpacing: -3.2,
    lineHeight: 65,
  },
  heroCategory: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  heroMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  heroMetaDot: {
    color: 'rgba(255,255,255,0.55)',
  },
  heroMetaText: {
    color: '#E8EFEC',
    fontSize: 12,
    fontWeight: '600',
  },
  actionBar: {
    backgroundColor: palette.surface,
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  secondaryAction: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryActionText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  followAction: {
    backgroundColor: palette.accentSoft,
    borderColor: palette.accentSoft,
  },
  followActionText: {
    color: palette.accentDeep,
  },
  columns: {
    gap: spacing.xxl,
    padding: spacing.lg,
  },
  columnsWide: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  mainColumn: {
    gap: spacing.xxxl,
  },
  mainColumnWide: {
    flex: 1.35,
  },
  sideColumn: {
    gap: spacing.lg,
  },
  sideColumnWide: {
    flex: 0.65,
    maxWidth: 390,
  },
  section: {
    gap: spacing.lg,
  },
  description: {
    color: palette.ink,
    fontSize: 16,
    lineHeight: 25,
    maxWidth: 760,
  },
  featureRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  featureChip: {
    alignItems: 'center',
    backgroundColor: palette.successSoft,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  featureText: {
    color: palette.success,
    fontSize: 10,
    fontWeight: '800',
  },
  menuTabs: {
    gap: spacing.sm,
  },
  menuTab: {
    borderBottomColor: 'transparent',
    borderBottomWidth: 2,
    paddingBottom: 8,
    paddingHorizontal: 4,
  },
  menuTabActive: {
    borderBottomColor: palette.accent,
  },
  menuTabText: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  menuTabTextActive: {
    color: palette.ink,
  },
  menuList: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
  },
  menuItem: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  menuItemCopy: {
    flex: 1,
    gap: 5,
  },
  menuNameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  menuName: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: '900',
  },
  menuSoldOut: {
    color: palette.muted,
    textDecorationLine: 'line-through',
  },
  popularLabel: {
    color: palette.accentDeep,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  menuDescription: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  dietary: {
    color: palette.success,
    fontSize: 10,
    fontWeight: '700',
  },
  menuPrice: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  menuImage: {
    backgroundColor: palette.line,
    borderRadius: radii.md,
    height: 74,
    width: 74,
  },
  menuFreshness: {
    color: palette.mutedLight,
    fontSize: 10,
  },
  galleryRow: {
    gap: spacing.md,
  },
  galleryImage: {
    backgroundColor: palette.line,
    borderRadius: radii.lg,
    height: 220,
    width: 300,
  },
  reviewSummary: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  reviewScore: {
    color: palette.ink,
    fontSize: 41,
    fontWeight: '900',
    letterSpacing: -2,
  },
  stars: {
    flexDirection: 'row',
    gap: 3,
  },
  reliability: {
    alignItems: 'flex-end',
    gap: 3,
  },
  reliabilityValue: {
    color: palette.success,
    fontSize: 22,
    fontWeight: '900',
  },
  reliabilityLabel: {
    color: palette.muted,
    fontSize: 10,
  },
  reviewList: {
    gap: spacing.md,
  },
  reviewCard: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  reviewTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  reviewerAvatar: {
    alignItems: 'center',
    backgroundColor: palette.dark,
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  reviewerInitial: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  reviewerCopy: {
    flex: 1,
    gap: 2,
  },
  reviewerName: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  reviewerMeta: {
    color: palette.muted,
    fontSize: 9,
  },
  reviewBody: {
    color: palette.ink,
    fontSize: 13,
    lineHeight: 20,
  },
  reviewPhotos: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  reviewPhoto: {
    borderRadius: radii.md,
    height: 130,
    width: 170,
  },
  reviewFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  reviewHelpful: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: '700',
  },
  ownerResponse: {
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    gap: 5,
    padding: spacing.md,
  },
  ownerResponseLabel: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '900',
  },
  ownerResponseBody: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  reviewComposer: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  ratingPicker: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  ratingPickerText: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
    marginLeft: 8,
  },
  reviewInput: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 14,
    lineHeight: 21,
    minHeight: 120,
    padding: spacing.md,
  },
  pendingPhotos: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  pendingPhotoWrap: {
    position: 'relative',
  },
  pendingPhoto: {
    borderRadius: radii.md,
    height: 78,
    width: 78,
  },
  removePhoto: {
    alignItems: 'center',
    backgroundColor: palette.ink,
    borderRadius: 999,
    height: 22,
    justifyContent: 'center',
    position: 'absolute',
    right: -5,
    top: -5,
    width: 22,
  },
  composerActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  photoButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  photoButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  submitButton: {
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  infoPanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  infoHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  infoTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  infoFresh: {
    color: palette.success,
    fontSize: 9,
    fontWeight: '800',
  },
  infoRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  infoIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  infoCopy: {
    flex: 1,
    gap: 4,
  },
  infoPrimary: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
    lineHeight: 17,
  },
  infoSecondary: {
    color: palette.muted,
    fontSize: 10,
    lineHeight: 15,
  },
  infoLink: {
    color: palette.accentDeep,
    fontSize: 10,
    fontWeight: '800',
  },
  hoursList: {
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    gap: 8,
    padding: spacing.md,
  },
  hoursRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  hoursDay: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: '800',
  },
  hoursValue: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '700',
  },
  nextStop: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  nextStopCopy: {
    flex: 1,
    gap: 3,
  },
  nextStopLabel: {
    color: palette.accentDeep,
    fontSize: 9,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  nextStopText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 15,
  },
  privacyNote: {
    alignItems: 'flex-start',
    backgroundColor: palette.successSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  privacyText: {
    color: palette.success,
    flex: 1,
    fontSize: 10,
    lineHeight: 15,
  },
  paymentGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  paymentChip: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  paymentText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '800',
  },
  paymentCaveat: {
    color: palette.mutedLight,
    fontSize: 9,
  },
  sourcePanel: {
    alignItems: 'flex-start',
    backgroundColor: palette.successSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  sourceIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  sourceCopy: {
    flex: 1,
    gap: 5,
  },
  sourceTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  sourceBody: {
    color: palette.muted,
    fontSize: 10,
    lineHeight: 15,
  },
  missing: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  missingTitle: {
    color: palette.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  missingButton: {
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  missingButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
});
