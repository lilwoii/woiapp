import FontAwesome from '@expo/vector-icons/FontAwesome';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import type { Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ImageBackground,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
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
import { TrustBadgeStrip } from '@/components/trust-badge-strip';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import {
  featureFlags,
  HOME_KITCHEN_UNAVAILABLE_REASON,
  isHomeKitchenBlocked,
} from '@/lib/features';
import { phoneHref, placeShareUrl, safeHttpsUrl } from '@/lib/links';
import { isMarketplaceChatAvailable, startMarketplaceConversation } from '@/lib/marketplace-chat';
import { externalDirectionsUrl } from '@/lib/navigation';
import {
  blockUser,
  createMarketplaceIdempotencyKey,
  fetchBusinessReviewsPage,
  type ReviewSort,
} from '@/lib/marketplace-api';
import { confirmAction, showMessage } from '@/lib/platform-dialog';
import { fetchBusinessBadges, fetchBusinessPosts } from '@/lib/social-feed';
import type { PublicBadge } from '@/lib/trust-badges';
import type { FeedItem } from '@/types/feed';
import { ReviewPhotoInput, type Review } from '@/types/marketplace';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export default function PlaceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { scopeKey } = useMarketplaceStore();
  return <ScopedPlaceDetailScreen id={id} key={`${scopeKey}:place:${id ?? ''}`} />;
}

function ScopedPlaceDetailScreen({ id }: { id?: string }) {
  const auth = useAuth();
  const {
    addReview,
    ensurePlace,
    followedIds,
    loadMoreReviews,
    publicPlaces,
    toggleFollow,
  } = useMarketplaceStore();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const loadedPlace = publicPlaces.find((entry) => entry.id === id);
  const placeBlocked = isHomeKitchenBlocked(loadedPlace?.category);
  // A managed home-kitchen record may remain in the account-scoped store for
  // Studio. Never let that private cache become a public detail route.
  const place = placeBlocked ? undefined : loadedPlace;
  const chatEligibleCategory = place?.category === 'pop_up' ||
    (place?.category === 'home_kitchen' && featureFlags.homeKitchens);
  const [rating, setRating] = useState(5);
  const [review, setReview] = useState('');
  const [reviewPhotos, setReviewPhotos] = useState<ReviewPhotoInput[]>([]);
  const [blockedAuthorIds, setBlockedAuthorIds] = useState<string[]>([]);
  const [showAllHours, setShowAllHours] = useState(false);
  const [activeMenuSection, setActiveMenuSection] = useState(0);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [moreReviewsLoading, setMoreReviewsLoading] = useState(false);
  const [reviewSort, setReviewSort] = useState<ReviewSort>('recent');
  const [reviewView, setReviewView] = useState<{ reviews: Review[]; hasMore: boolean } | null>(null);
  const [chatAvailable, setChatAvailable] = useState(false);
  const [chatStarting, setChatStarting] = useState(false);
  const [businessPosts, setBusinessPosts] = useState<FeedItem[]>([]);
  const [businessBadges, setBusinessBadges] = useState<PublicBadge[]>([]);
  const mounted = useRef(true);
  const reviewIntent = useRef<{ fingerprint: string; key: string } | null>(null);
  const [listingLoading, setListingLoading] = useState(
    !placeBlocked && (!place || (auth.isConfigured && !place.detailsLoaded))
  );
  const [listingError, setListingError] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const ready = Boolean(place && (!auth.isConfigured || place.detailsLoaded));
    const timer = setTimeout(() => {
      if (!active) return;
      if (placeBlocked) {
        setListingLoading(false);
        setListingError(HOME_KITCHEN_UNAVAILABLE_REASON);
        return;
      }
      if (!id || ready) {
        setListingLoading(false);
        return;
      }
      setListingLoading(true);
      setListingError(null);
      void ensurePlace(id).then((result) => {
        if (!active) return;
        setListingLoading(false);
        if (!result.ok) setListingError(result.reason);
      });
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [auth.isConfigured, ensurePlace, id, place, placeBlocked]);

  useEffect(() => {
    let active = true;
    if (!place || !chatEligibleCategory) return () => { active = false; };
    void isMarketplaceChatAvailable(place.id, place.category).then((available) => {
      if (active) setChatAvailable(available);
    });
    return () => { active = false; };
  }, [chatEligibleCategory, place]);

  useEffect(() => {
    let active = true;
    if (!place) return () => { active = false; };
    void Promise.all([fetchBusinessPosts(place.id), fetchBusinessBadges(place.id)]).then(([postResult, badgeResult]) => {
      if (!active) return;
      if (postResult.ok && postResult.data) setBusinessPosts(postResult.data.items.slice(0, 5));
      if (badgeResult.ok && badgeResult.data) setBusinessBadges(badgeResult.data);
    });
    return () => { active = false; };
  }, [place]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !place) return;
    const previousTitle = document.title;
    document.title = `${place.name} · ${place.categoryLabel} | Spottr`;
    const values = [
      ['meta[name="description"]', `${place.name}: ${place.description}`],
      ['meta[property="og:title"]', `${place.name} | Spottr`],
      ['meta[property="og:description"]', place.description],
      ['meta[property="og:url"]', placeShareUrl(place.id)],
    ] as const;
    const previous = values.map(([selector, value]) => {
      const element = document.querySelector<HTMLMetaElement>(selector);
      const prior = element?.content;
      if (element) element.content = value.slice(0, 300);
      return [element, prior] as const;
    });
    return () => {
      document.title = previousTitle;
      for (const [element, value] of previous) {
        if (element && value !== undefined) element.content = value;
      }
    };
  }, [place]);

  if (!place) {
    return (
      <View role="main" style={styles.missing}>
        {listingLoading ? (
          <>
            <ActivityIndicator color={palette.accentDeep} />
            <Text accessibilityLiveRegion="polite" style={styles.missingTitle}>Loading this listing…</Text>
          </>
        ) : (
          <>
            <FontAwesome6 color={palette.accent} name="location-dot" size={24} />
            <Text accessibilityLiveRegion="assertive" accessibilityRole="header" style={styles.missingTitle}>
              {listingError ?? 'This listing is unavailable.'}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.missingButton}>
              <Text style={styles.missingButtonText}>Browse nearby food</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  const followed = followedIds.includes(place.id);
  const selectedSection = place.menu[activeMenuSection] ?? place.menu[0];
  const callablePhone = phoneHref(place.phone);
  const safeWebsite = safeHttpsUrl(place.websiteUrl);
  const canOpenPublicDirections = place.category !== 'home_kitchen';

  const openDirections = () => {
    const url = externalDirectionsUrl(place, Platform.OS);
    if (!url) {
      showMessage('Directions unavailable', 'This listing does not have a valid public destination.');
      return;
    }
    void Linking.openURL(url).catch(() => {
      showMessage('Directions unavailable', 'Your maps app could not open this destination.');
    });
  };

  const openSpottrNavigation = () => {
    router.push({ pathname: '/navigation/[id]', params: { id: place.id } } as Href);
  };

  const shareListing = async () => {
    const url = placeShareUrl(place.id);
    try {
      await Share.share({
        message: `${place.name} on Spottr — ${place.todayHours}\n${url}`,
        title: place.name,
        url,
      });
    } catch {
      showMessage('Sharing unavailable', 'This listing could not be shared right now.');
    }
  };

  const openChat = async () => {
    if (isHomeKitchenBlocked(place.category)) {
      showMessage('Chat unavailable', HOME_KITCHEN_UNAVAILABLE_REASON);
      return;
    }
    const expectedUserId = auth.status === 'authenticated' ? auth.account?.id : null;
    if (!expectedUserId) {
      router.push('/auth');
      return;
    }
    setChatStarting(true);
    const result = await startMarketplaceConversation(place.id, expectedUserId, place.category);
    if (!mounted.current) return;
    setChatStarting(false);
    if (!result.ok || !result.data) {
      showMessage('Chat unavailable', result.ok ? 'This conversation could not be opened.' : result.reason);
      return;
    }
    router.push({ pathname: '/messages/[id]', params: { id: result.data } } as never);
  };

  const blockReviewer = async (authorId: string, displayName: string) => {
    if (auth.isConfigured && auth.status !== 'authenticated') {
      const continueToAuth = await confirmAction({
        title: 'Sign in to block members',
        message: 'Blocking is tied to your account so it applies across devices.',
        confirmLabel: 'Sign in',
      });
      if (!mounted.current) return;
      if (continueToAuth) router.push('/auth');
      return;
    }

    const confirmed = await confirmAction({
      title: `Block ${displayName}?`,
      message: 'Their reviews and responses will be hidden from your Spottr experience.',
      confirmLabel: 'Block member',
      destructive: true,
    });
    if (!mounted.current || !confirmed) return;

    const result = await blockUser(authorId, auth.account?.id);
    if (!mounted.current) return;
    if (!result.ok) {
      showMessage('Could not block member', result.reason);
      return;
    }
    setBlockedAuthorIds((current) => [...new Set([...current, authorId])]);
    showMessage('Member blocked', result.message ?? 'Their community content is now hidden.');
  };

  const handleFollow = async () => {
    const result = await toggleFollow(place.id);
    if (!mounted.current) return;
    if (!result.ok) {
      if (result.code === 'AUTH_REQUIRED') {
        const confirmed = await confirmAction({
          title: 'Sign in to follow',
          message: result.reason,
          confirmLabel: 'Sign in',
        });
        if (!mounted.current) return;
        if (confirmed) router.push('/auth');
      } else {
        showMessage('Could not update this follow', result.reason);
      }
    }
  };

  const pickReviewPhoto = async () => {
    if (reviewPhotos.length >= 4) {
      showMessage('Photo limit', 'Add up to four photos per review.');
      return;
    }

    if (auth.isConfigured && !featureFlags.mediaUploads) {
      showMessage(
        'Photo safety is not active',
        'Photo uploads stay disabled until the private scanning and moderation service is connected.'
      );
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!mounted.current) return;
    if (!permission.granted) {
      showMessage('Photo access needed', 'Allow photo access to attach images to your review.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      mediaTypes: ['images'],
      quality: 0.8,
    });

    if (!mounted.current || result.canceled || !result.assets[0]?.uri) return;
    const asset = result.assets[0];
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (asset.mimeType && !allowedTypes.includes(asset.mimeType)) {
      showMessage('Unsupported photo', 'Choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (asset.fileSize && asset.fileSize > 5 * 1024 * 1024) {
      showMessage('Photo is too large', 'Choose an image under 5 MB.');
      return;
    }
    if ((asset.width ?? 0) > 8192 || (asset.height ?? 0) > 8192) {
      showMessage('Photo dimensions are too large', 'Choose an image no larger than 8192 pixels per side.');
      return;
    }
    setReviewPhotos((current) => [
      ...current,
      {
        uri: asset.uri,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
      },
    ]);
  };

  const submitReview = async () => {
    if (reviewSubmitting) return;
    const fingerprint = JSON.stringify({
      placeId: place.id,
      rating,
      review,
      photos: reviewPhotos.map((photo) => [
        photo.uri,
        photo.mimeType ?? null,
        photo.fileSize ?? null,
      ]),
    });
    if (reviewIntent.current?.fingerprint !== fingerprint) {
      reviewIntent.current = {
        fingerprint,
        key: createMarketplaceIdempotencyKey('review'),
      };
    }
    setReviewSubmitting(true);
    setReviewMessage(null);
    const result = await addReview(place.id, {
      rating,
      comment: review,
      photos: reviewPhotos.map((photo) => photo.uri),
      photoUploads: reviewPhotos,
      idempotencyKey: reviewIntent.current.key,
    });
    if (!mounted.current) return;
    setReviewSubmitting(false);
    if (!result.ok) {
      setReviewMessage({ type: 'error', text: result.reason });
      if (result.code === 'AUTH_REQUIRED') {
        const confirmed = await confirmAction({
          title: 'Sign in to review',
          message: result.reason,
          confirmLabel: 'Sign in',
        });
        if (!mounted.current) return;
        if (confirmed) router.push('/auth');
      }
      return;
    }

    setReview('');
    reviewIntent.current = null;
    setReviewPhotos([]);
    setRating(5);
    setReviewMessage({
      type: 'success',
      text: result.message ?? 'Thanks — your review was submitted.',
    });
  };

  const showMoreReviews = async () => {
    if (moreReviewsLoading) return;
    setMoreReviewsLoading(true);
    if (reviewView) {
      const result = await fetchBusinessReviewsPage(
        place.id,
        reviewView.reviews.length,
        auth.account?.id,
        reviewSort
      );
      if (!mounted.current) return;
      setMoreReviewsLoading(false);
      if (!result.ok || !result.data) {
        showMessage('Reviews could not load', result.ok ? 'More reviews are unavailable.' : result.reason);
        return;
      }
      setReviewView((current) => {
        if (!current) return current;
        const byId = new Map(current.reviews.map((review) => [review.id, review]));
        for (const review of result.data?.reviews ?? []) byId.set(review.id, review);
        return { reviews: [...byId.values()], hasMore: result.data?.hasMore ?? false };
      });
      return;
    }
    const result = await loadMoreReviews(place.id);
    if (!mounted.current) return;
    setMoreReviewsLoading(false);
    if (!result.ok) showMessage('Reviews could not load', result.reason);
  };

  const changeReviewSort = async (nextSort: ReviewSort) => {
    if (moreReviewsLoading || nextSort === reviewSort) return;
    setReviewSort(nextSort);
    if (nextSort === 'recent') {
      setReviewView(null);
      return;
    }
    setMoreReviewsLoading(true);
    const result = await fetchBusinessReviewsPage(place.id, 0, auth.account?.id, nextSort);
    if (!mounted.current) return;
    setMoreReviewsLoading(false);
    if (!result.ok || !result.data) {
      setReviewSort('recent');
      showMessage('Top reviews unavailable', result.ok ? 'Top reviews could not be loaded.' : result.reason);
      return;
    }
    setReviewView({ reviews: result.data.reviews, hasMore: result.data.hasMore });
  };

  const displayedReviews = reviewView?.reviews ?? place.reviews;
  const displayedReviewsHaveMore = reviewView?.hasMore ?? place.hasMoreReviews;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell>
        <ImageBackground
          imageStyle={styles.heroImage}
          source={
            place.coverImageUrl
              ? { uri: place.coverImageUrl }
              : require('../../assets/images/spottr-icon.png')
          }
          style={styles.hero}>
          <View style={styles.heroShade} />
          <View style={styles.heroTop}>
            <Pressable accessibilityLabel="Go back" onPress={() => router.back()} style={styles.heroButton}>
              <FontAwesome6 color="#FFFFFF" name="arrow-left" size={14} />
            </Pressable>
            <View style={styles.heroActions}>
              <Pressable
                accessibilityLabel="Share listing"
                accessibilityRole="button"
                onPress={shareListing}
                style={styles.heroButton}>
                <FontAwesome6 color="#FFFFFF" name="arrow-up-from-bracket" size={14} />
              </Pressable>
              <Pressable
                accessibilityLabel={followed ? `Unfollow ${place.name}` : `Follow ${place.name}`}
                accessibilityState={{ selected: followed }}
                onPress={handleFollow}
                style={[styles.heroButton, followed && styles.heroButtonActive]}>
                <FontAwesome6 color="#FFFFFF" name="heart" size={14} solid={followed} />
              </Pressable>
            </View>
          </View>

          <View style={styles.heroCopy}>
            <View style={styles.heroBadgeRow}>
              <StatusPill status={place.status} />
              <View style={styles.verifiedBadge}>
                <FontAwesome6
                  color="#FFFFFF"
                  name={place.verified ? 'circle-check' : 'circle-info'}
                  size={12}
                  solid
                />
                <Text style={styles.verifiedText}>{place.sourceLabel}</Text>
              </View>
            </View>
            <Text style={[styles.heroTitle, wide && styles.heroTitleWide]}>{place.name}</Text>
            <TrustBadgeStrip badges={businessBadges} limit={4} showLabels />
            <Text style={styles.heroCategory}>
              {place.categoryLabel} · {place.cuisines.join(' · ')} · {'$'.repeat(place.priceLevel)}
            </Text>
            <View style={styles.heroMeta}>
              <Rating count={place.reviewCount} light rating={place.rating} />
              <Text style={styles.heroMetaDot}>·</Text>
              {place.distanceMiles !== null ? (
                <Text style={styles.heroMetaText}>{place.distanceMiles.toFixed(1)} mi away</Text>
              ) : null}
              <Text style={styles.heroMetaDot}>·</Text>
              <Text style={styles.heroMetaText}>
                {place.verified ? 'Confirmed' : 'Updated'} {place.lastConfirmedAt}
              </Text>
            </View>
          </View>
        </ImageBackground>

        <View style={styles.actionBar}>
          {featureFlags.pickupOrdering && place.pickup?.enabled && place.pickup.orderingMode === 'spottr' ? (
            <Pressable
              accessibilityLabel="Pickup pilot"
              accessibilityRole="button"
              onPress={() =>
                router.push(
                  {
                    pathname: '/order/[id]',
                    params: { id: place.id },
                  } as unknown as Href
                )
              }
              style={styles.primaryAction}>
              <FontAwesome6 color="#FFFFFF" name="bag-shopping" size={14} />
              <Text style={styles.primaryActionText}>Pickup pilot</Text>
            </Pressable>
          ) : null}
          {canOpenPublicDirections && featureFlags.inAppNavigation ? (
            <Pressable accessibilityLabel="Navigate in Spottr" accessibilityRole="button" onPress={openSpottrNavigation} style={styles.primaryAction}>
              <FontAwesome6 color="#FFFFFF" name="diamond-turn-right" size={14} />
              <Text style={styles.primaryActionText}>Navigate in Spottr</Text>
            </Pressable>
          ) : null}
          {canOpenPublicDirections ? (
            <Pressable accessibilityLabel="Open directions in external maps" accessibilityRole="link" onPress={openDirections} style={styles.secondaryAction}>
              <FontAwesome6 color={palette.ink} name="arrow-up-right-from-square" size={13} />
              <Text style={styles.secondaryActionText}>Open in Maps</Text>
            </Pressable>
          ) : null}
          {chatEligibleCategory && chatAvailable ? (
            <Pressable
              accessibilityLabel={`Message ${place.name}`}
              accessibilityRole="button"
              disabled={chatStarting}
              onPress={() => void openChat()}
              style={[styles.primaryAction, chatStarting && styles.buttonDisabled]}>
              {chatStarting ? <ActivityIndicator color="#FFFFFF" size="small" /> : <FontAwesome6 color="#FFFFFF" name="comment-dots" size={14} solid />}
              <Text style={styles.primaryActionText}>Message seller</Text>
            </Pressable>
          ) : null}
          {callablePhone ? (
            <Pressable
              accessibilityLabel="Call business"
              accessibilityRole="link"
              onPress={() => void Linking.openURL(callablePhone)}
              style={styles.secondaryAction}>
              <FontAwesome6 color={palette.ink} name="phone" size={13} />
              <Text style={styles.secondaryActionText}>Call</Text>
            </Pressable>
          ) : null}
          {safeWebsite ? (
            <Pressable
              accessibilityLabel="Open business website"
              accessibilityRole="link"
              onPress={() => void Linking.openURL(safeWebsite)}
              style={styles.secondaryAction}>
              <FontAwesome6 color={palette.ink} name="globe" size={13} />
              <Text style={styles.secondaryActionText}>Website</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel={followed ? `Unfollow ${place.name}` : `Follow ${place.name}`}
            accessibilityRole="button"
            accessibilityState={{ selected: followed }}
            onPress={handleFollow}
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
                <OwnerUpdate
                  onReport={() =>
                    router.push({
                      pathname: '/report',
                      params: {
                        targetId: place.update!.id,
                        targetType: 'update',
                      },
                    } as never)
                  }
                  update={place.update}
                />
              </View>
            ) : null}

            {businessPosts.length ? (
              <View style={styles.section}>
                <SectionHeading detail="Photos and notes published by this business." eyebrow="From the business" title="Latest posts" />
                <View style={styles.businessPosts}>
                  {businessPosts.map((post) => (
                    <View key={post.id} style={styles.businessPost}>
                      <View style={styles.businessPostMeta}>
                        <Text style={styles.businessPostName}>{place.name}</Text>
                        <View style={styles.businessPostMetaActions}>
                          <Text style={styles.businessPostTime}>{post.createdLabel} · {post.createdDateTimeLabel}</Text>
                          <Pressable accessibilityLabel={`Report post from ${place.name}`} accessibilityRole="button" onPress={() => router.push({ pathname: '/report', params: { targetId: post.id, targetType: 'business_post' } } as never)} style={styles.businessPostReport}>
                            <FontAwesome6 color={palette.muted} name="flag" size={8} />
                            <Text style={styles.businessPostReportText}>Report</Text>
                          </Pressable>
                        </View>
                      </View>
                      {post.body ? <Text style={styles.businessPostBody}>{post.body}</Text> : null}
                      {post.photos.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.businessPostPhotos}>{post.photos.map((photo) => <Image key={photo} source={{ uri: photo }} style={styles.businessPostPhoto} />)}</View></ScrollView> : null}
                    </View>
                  ))}
                </View>
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
                    <Text accessibilityLabel={`${currency.format(item.price)}${item.soldOut ? ', sold out' : ''}`} style={styles.menuPrice}>
                      {currency.format(item.price)}
                    </Text>
                    {item.photoUrl ? <Image source={{ uri: item.photoUrl }} style={styles.menuImage} /> : null}
                  </View>
                ))}
                {!selectedSection?.items.length ? (
                  <View style={styles.inlineEmpty}>
                    <FontAwesome6 color={palette.muted} name="receipt" size={16} />
                    <Text style={styles.inlineEmptyText}>This business has not published a menu yet.</Text>
                  </View>
                ) : null}
              </View>
              {selectedSection?.items.length ? (
                <Text style={styles.menuFreshness}>
                  {place.sourceLabel === 'Owner verified' || place.sourceLabel === 'Owner provided'
                    ? 'Owner-provided menu'
                    : `${place.sourceLabel} menu`}
                  {' · '}Prices are shown as listed; confirm changes with the business.
                </Text>
              ) : null}
            </View>

            {place.gallery.length ? (
              <View style={styles.section}>
                <SectionHeading eyebrow="Photos" title="From the counter & community" />
                <ScrollView
                  contentContainerStyle={styles.galleryRow}
                  horizontal
                  showsHorizontalScrollIndicator={false}>
                  {place.gallery.map((photo, index) => (
                    <View key={`${photo}-${index}`} style={styles.galleryImageWrap}>
                      <Image
                        accessibilityLabel={`${place.name} gallery photo ${index + 1}`}
                        source={{ uri: photo }}
                        style={styles.galleryImage}
                      />
                      {place.galleryMediaIds?.[index] ? (
                        <Pressable
                          accessibilityLabel={`Report gallery photo ${index + 1}`}
                          accessibilityRole="button"
                          onPress={() =>
                            router.push({
                              pathname: '/report',
                              params: {
                                targetId: place.galleryMediaIds![index],
                                targetType: 'media',
                              },
                            } as never)
                          }
                          style={styles.mediaReportButton}>
                          <FontAwesome6 color="#FFFFFF" name="flag" size={11} />
                        </Pressable>
                      ) : null}
                    </View>
                  ))}
                </ScrollView>
              </View>
            ) : null}

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
                  <Text style={styles.reliabilityValue}>{place.verified ? 'Verified' : 'Listed'}</Text>
                  <Text style={styles.reliabilityLabel}>Updated {place.lastConfirmedAt.toLowerCase()}</Text>
                </View>
              </View>
              <View style={styles.reviewOrdering}>
                <Text style={styles.reviewOrderingLabel}>ORDER</Text>
                <View accessibilityLabel="Review order" accessibilityRole="tablist" style={styles.reviewOrderTabs}>
                  {(['recent', 'top'] as const).map((item) => {
                    const selected = reviewSort === item;
                    return (
                      <Pressable
                        accessibilityRole="tab"
                        accessibilityState={{ selected, busy: moreReviewsLoading && selected }}
                        disabled={moreReviewsLoading}
                        key={item}
                        onPress={() => void changeReviewSort(item)}
                        style={[styles.reviewOrderTab, selected && styles.reviewOrderTabActive]}>
                        <Text style={[styles.reviewOrderText, selected && styles.reviewOrderTextActive]}>{item === 'recent' ? 'Recent' : 'Top'}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              {reviewSort === 'top' ? <Text style={styles.reviewOrderNote}>Top weighs eligible helpful votes and earned reviewer badges. Sponsored placement is never included.</Text> : null}
              <View style={styles.reviewList}>
                {displayedReviews
                  .filter((item) => !item.authorId || !blockedAuthorIds.includes(item.authorId))
                  .map((item) => (
                  <View key={item.id} style={styles.reviewCard}>
                    <View style={styles.reviewTop}>
                      <View style={styles.reviewerAvatar}>
                        <Text style={styles.reviewerInitial}>{item.displayName.charAt(0)}</Text>
                      </View>
                      <View style={styles.reviewerCopy}>
                        <View style={styles.reviewerIdentity}>
                          <Pressable
                            accessibilityLabel={`View ${item.displayName} profile`}
                            accessibilityRole={item.authorId ? 'link' : undefined}
                            disabled={!item.authorId}
                            onPress={() => item.authorId && router.push({ pathname: '/profile/[id]', params: { id: item.authorId } })}>
                            <Text style={styles.reviewerName}>{item.displayName}</Text>
                          </Pressable>
                          <TrustBadgeStrip badges={item.badges ?? []} />
                        </View>
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
                            <View key={`${photo}-${index}`} style={styles.reviewPhotoWrap}>
                              <Image source={{ uri: photo }} style={styles.reviewPhoto} />
                              {item.photoMediaIds?.[index] ? (
                                <Pressable
                                  accessibilityLabel={`Report review photo ${index + 1}`}
                                  accessibilityRole="button"
                                  onPress={() =>
                                    router.push({
                                      pathname: '/report',
                                      params: {
                                        targetId: item.photoMediaIds![index],
                                        targetType: 'media',
                                      },
                                    } as never)
                                  }
                                  style={styles.mediaReportButton}>
                                  <FontAwesome6 color="#FFFFFF" name="flag" size={11} />
                                </Pressable>
                              ) : null}
                            </View>
                          ))}
                        </View>
                      </ScrollView>
                    ) : null}
                    <View style={styles.reviewFooter}>
                      <FontAwesome6 color={palette.muted} name="thumbs-up" size={11} />
                      <Text style={styles.reviewHelpful}>Helpful · {item.helpfulCount}</Text>
                      <Pressable
                        accessibilityLabel={`Report review by ${item.displayName}`}
                        accessibilityRole="button"
                        onPress={() =>
                          router.push({
                            pathname: '/report',
                            params: { targetId: item.id, targetType: 'review' },
                          } as never)
                        }
                        style={styles.reportButton}>
                        <FontAwesome6 color={palette.muted} name="flag" size={10} />
                        <Text style={styles.reportButtonText}>Report</Text>
                      </Pressable>
                      {item.authorId ? (
                        <Pressable
                          accessibilityLabel={`Block ${item.displayName}`}
                          accessibilityRole="button"
                          onPress={() => void blockReviewer(item.authorId!, item.displayName)}
                          style={styles.blockButton}>
                          <FontAwesome6 color={palette.muted} name="user-slash" size={10} />
                          <Text style={styles.reportButtonText}>Block</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {item.ownerResponse ? (
                      <View style={styles.ownerResponse}>
                        <Text style={styles.ownerResponseLabel}>Response from {place.name}</Text>
                        <Text style={styles.ownerResponseBody}>{item.ownerResponse}</Text>
                        {item.ownerResponseId ? (
                          <Pressable
                            accessibilityLabel={`Report response from ${place.name}`}
                            accessibilityRole="button"
                            onPress={() =>
                              router.push({
                                pathname: '/report',
                                params: {
                                  targetId: item.ownerResponseId,
                                  targetType: 'response',
                                },
                              } as never)
                            }
                            style={styles.responseReportButton}>
                            <FontAwesome6 color={palette.muted} name="flag" size={10} />
                            <Text style={styles.reportButtonText}>Report response</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                ))}
                {displayedReviewsHaveMore ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ busy: moreReviewsLoading }}
                    disabled={moreReviewsLoading}
                    onPress={() => void showMoreReviews()}
                    style={styles.moreReviewsButton}>
                    {moreReviewsLoading ? (
                      <ActivityIndicator color={palette.accentDeep} size="small" />
                    ) : (
                      <FontAwesome6 color={palette.accentDeep} name="comments" size={12} />
                    )}
                    <Text style={styles.moreReviewsText}>
                      {moreReviewsLoading ? 'Loading reviews…' : 'Show more reviews'}
                    </Text>
                  </Pressable>
                ) : null}
                {!displayedReviews.length ? (
                  <View style={styles.inlineEmpty}>
                    <FontAwesome6 color={palette.muted} name="comment" size={16} />
                    <Text style={styles.inlineEmptyText}>No approved reviews yet. Be the first to share a visit.</Text>
                  </View>
                ) : null}
              </View>
            </View>

            <View style={styles.reviewComposer}>
              <SectionHeading
                detail="Professional language and image safety checks apply."
                eyebrow="Share your visit"
                title="Write a review"
              />
              <View accessibilityLabel="Review rating" accessibilityRole="radiogroup" style={styles.ratingPicker}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <Pressable
                    accessibilityLabel={`${value} star${value === 1 ? '' : 's'}`}
                    accessibilityRole="radio"
                    aria-checked={value === rating}
                    accessibilityState={{ checked: value === rating }}
                    key={value}
                    onPress={() => setRating(value)}
                    style={styles.ratingOption}>
                    <FontAwesome color={value <= rating ? palette.sun : palette.line} name="star" size={25} />
                  </Pressable>
                ))}
                <Text style={styles.ratingPickerText}>{rating}.0</Text>
              </View>
              <TextInput
                accessibilityLabel="Review"
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
                    <View key={`${photo.uri}-${index}`} style={styles.pendingPhotoWrap}>
                      <Image source={{ uri: photo.uri }} style={styles.pendingPhoto} />
                      <Pressable
                        accessibilityLabel="Remove photo"
                        accessibilityRole="button"
                        hitSlop={12}
                        onPress={() => setReviewPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        style={styles.removePhoto}>
                        <FontAwesome6 color="#FFFFFF" name="xmark" size={10} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
              {reviewMessage ? (
                <View
                  accessibilityLiveRegion="polite"
                  accessibilityRole="alert"
                  style={[
                    styles.reviewMessage,
                    reviewMessage.type === 'success' && styles.reviewMessageSuccess,
                  ]}>
                  <FontAwesome6
                    color={reviewMessage.type === 'success' ? palette.success : palette.accentDeep}
                    name={reviewMessage.type === 'success' ? 'circle-check' : 'triangle-exclamation'}
                    size={12}
                    solid
                  />
                  <Text
                    style={[
                      styles.reviewMessageText,
                      reviewMessage.type === 'success' && styles.reviewMessageTextSuccess,
                    ]}>
                    {reviewMessage.text}
                  </Text>
                </View>
              ) : null}
              <View style={styles.composerActions}>
                <Pressable accessibilityRole="button" onPress={pickReviewPhoto} style={styles.photoButton}>
                  <FontAwesome6 color={palette.ink} name="camera" size={13} />
                  <Text style={styles.photoButtonText}>Add photos</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={reviewSubmitting}
                  onPress={submitReview}
                  style={[styles.submitButton, reviewSubmitting && styles.buttonDisabled]}>
                  {reviewSubmitting ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.submitButtonText}>Submit review</Text>
                  )}
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
                      : [place.city, place.region, place.postalCode].filter(Boolean).join(', ')}
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
                  <Text style={styles.privacyText}>
                    Residence address and directions are never public. Use only a verified public meetup or private pickup detail released through Spottr after eligibility checks.
                  </Text>
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
              <Text style={styles.paymentCaveat}>
                {place.verified
                  ? 'Payment details confirmed by the verified business.'
                  : 'Payment details come from the listing source; confirm before ordering.'}
              </Text>
            </View>

            <View style={styles.sourcePanel}>
              <View style={styles.sourceIcon}>
                <FontAwesome6 color={palette.success} name="circle-check" size={18} solid />
              </View>
              <View style={styles.sourceCopy}>
                <Text style={styles.sourceTitle}>{place.sourceLabel}</Text>
                <Text style={styles.sourceBody}>
                  {place.sourceLabel === 'Owner verified'
                    ? 'The verified business manages its hours, menu, payments, and live updates.'
                    : place.sourceLabel === 'Licensed provider'
                      ? 'Core listing details come from a licensed data provider and are refreshed on a recorded schedule.'
                      : place.sourceLabel === 'Community added'
                        ? 'Community-provided details remain subject to verification and correction.'
                        : 'The owner supplied these details; identity verification is still pending.'}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={`Report listing for ${place.name}`}
                accessibilityRole="button"
                onPress={() =>
                  router.push({
                    pathname: '/report',
                    params: { targetId: place.id, targetType: 'business' },
                  } as never)
                }
                style={styles.sourceReport}>
                <FontAwesome6 color={palette.muted} name="flag" size={11} />
                <Text style={styles.sourceReportText}>Report listing</Text>
              </Pressable>
              {featureFlags.businessClaims &&
              (place.sourceLabel === 'Licensed provider' || place.sourceLabel === 'Community added') ? (
                <Pressable
                  accessibilityLabel={`Are you the owner of ${place.name}? Claim this place`}
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: '/business-onboarding',
                      params: { claim: '1', claimId: place.id, name: place.name },
                    } as never)
                  }
                  style={styles.sourceClaim}>
                  <FontAwesome6 color="#FFFFFF" name="key" size={11} />
                  <Text style={styles.sourceClaimText}>Are you the owner? Claim this place</Text>
                </Pressable>
              ) : null}
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
    ...StyleSheet.absoluteFill,
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
    height: 48,
    justifyContent: 'center',
    width: 48,
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
    minHeight: 48,
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
    minHeight: 48,
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
  inlineEmpty: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  inlineEmptyText: {
    color: palette.muted,
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
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
  galleryImageWrap: {
    borderRadius: radii.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  galleryImage: {
    backgroundColor: palette.line,
    borderRadius: radii.lg,
    height: 220,
    width: 300,
  },
  businessPosts: { borderTopColor: palette.line, borderTopWidth: 1 },
  businessPost: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.md, paddingVertical: spacing.lg },
  businessPostMeta: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  businessPostMetaActions: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  businessPostName: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  businessPostTime: { color: palette.muted, fontSize: 8 },
  businessPostReport: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 34, paddingHorizontal: spacing.xs },
  businessPostReportText: { color: palette.muted, fontSize: 8, fontWeight: '800' },
  businessPostBody: { color: palette.ink, fontSize: 12, lineHeight: 19 },
  businessPostPhotos: { flexDirection: 'row', gap: spacing.sm },
  businessPostPhoto: { borderRadius: radii.md, height: 164, width: 220 },
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
  reviewOrdering: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
  },
  reviewOrderingLabel: { color: palette.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1.1 },
  reviewOrderTabs: { flexDirection: 'row', gap: 2 },
  reviewOrderTab: { borderRadius: radii.pill, justifyContent: 'center', minHeight: 36, paddingHorizontal: 14 },
  reviewOrderTabActive: { backgroundColor: palette.dark },
  reviewOrderText: { color: palette.muted, fontSize: 10, fontWeight: '900', textTransform: 'capitalize' },
  reviewOrderTextActive: { color: '#FFFFFF' },
  reviewOrderNote: { color: palette.muted, fontSize: 9, lineHeight: 15, marginTop: -spacing.sm },
  reviewList: {
    gap: spacing.md,
  },
  moreReviewsButton: {
    alignItems: 'center',
    alignSelf: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
  },
  moreReviewsText: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '800',
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
  reviewerIdentity: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
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
  reviewPhotoWrap: {
    borderRadius: radii.md,
    overflow: 'hidden',
    position: 'relative',
  },
  reviewPhoto: {
    borderRadius: radii.md,
    height: 130,
    width: 170,
  },
  mediaReportButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 31, 29, 0.78)',
    borderBottomLeftRadius: radii.md,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 0,
    width: 44,
  },
  reviewFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  reportButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    marginLeft: 'auto',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  blockButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  reportButtonText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '700',
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
  responseReportButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 5,
    minHeight: 44,
    paddingRight: spacing.sm,
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
  ratingOption: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
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
  reviewMessage: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  reviewMessageSuccess: {
    backgroundColor: palette.successSoft,
  },
  reviewMessageText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  reviewMessageTextSuccess: {
    color: palette.success,
  },
  photoButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  photoButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 132,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  buttonDisabled: {
    opacity: 0.62,
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
    flexWrap: 'wrap',
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
  sourceReport: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 11,
  },
  sourceReportText: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: '800',
  },
  sourceClaim: {
    alignItems: 'center',
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    flexBasis: '100%',
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 14,
  },
  sourceClaimText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
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
