import FontAwesome from '@expo/vector-icons/FontAwesome';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { TrustBadgeStrip } from '@/components/trust-badge-strip';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { fetchPublicProfile, setProfileFollow } from '@/lib/marketplace-api';
import { showMessage } from '@/lib/platform-dialog';
import type { PublicProfile } from '@/types/social';

export default function PublicProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ScopedPublicProfile id={id} key={id ?? 'missing-profile'} />;
}

function ScopedPublicProfile({ id }: { id?: string }) {
  const auth = useAuth();
  const [snapshot, setSnapshot] = useState<{ id: string; profile: PublicProfile } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const profile = id && snapshot?.id === id ? snapshot.profile : null;

  useEffect(() => {
    let current = true;
    if (!id) return () => { current = false; };
    void fetchPublicProfile(id).then((result) => {
      if (!current) return;
      if (result.ok && result.data) setSnapshot({ id, profile: result.data });
      else setError(result.ok ? 'This profile is unavailable.' : result.reason);
    });
    return () => { current = false; };
  }, [id]);

  const toggleFollow = async () => {
    if (!profile || followBusy) return;
    if (auth.status !== 'authenticated' || !auth.account?.id) {
      router.push('/auth');
      return;
    }
    setFollowBusy(true);
    const next = !profile.followedByViewer;
    const result = await setProfileFollow(profile.id, next, auth.account.id);
    setFollowBusy(false);
    if (!result.ok) {
      showMessage('Follow unavailable', result.reason);
      return;
    }
    setSnapshot((current) => current?.id === profile.id ? {
      ...current,
      profile: {
        ...current.profile,
        followedByViewer: next,
        followerCount: Math.max(0, current.profile.followerCount + (next ? 1 : -1)),
      },
    } : current);
  };

  if (!profile && !error) {
    return (
      <FocusAwareScreen>
        <View style={styles.centered}>
          <ActivityIndicator color={palette.accentDeep} />
          <Text style={styles.loadingText}>Loading profile…</Text>
        </View>
      </FocusAwareScreen>
    );
  }

  if (!profile) {
    return (
      <FocusAwareScreen>
        <View style={styles.centered}>
          <View style={styles.emptyIcon}><FontAwesome6 color={palette.accentDeep} name="user-shield" size={20} /></View>
          <Text accessibilityRole="header" style={styles.emptyTitle}>Profile unavailable</Text>
          <Text style={styles.emptyBody}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backAction}><Text style={styles.backActionText}>Go back</Text></Pressable>
        </View>
      </FocusAwareScreen>
    );
  }

  const initials = profile.displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase('en-US');

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}>
              <FontAwesome6 color={palette.ink} name="arrow-left" size={13} />
            </Pressable>
            <Text numberOfLines={1} style={styles.topbarName}>@{profile.username}</Text>
            <Pressable
              accessibilityLabel={`Report ${profile.displayName}`}
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/report', params: { targetId: profile.id, targetType: 'user' } } as never)}
              style={styles.iconButton}>
              <FontAwesome6 color={palette.muted} name="flag" size={12} />
            </Pressable>
          </View>

          <View style={styles.banner}>
            {profile.bannerUrl ? <Image accessibilityLabel={`${profile.displayName} profile banner`} source={{ uri: profile.bannerUrl }} style={styles.bannerImage} /> : (
              <View style={styles.bannerFallback}>
                <View style={styles.bannerGlow} />
                <FontAwesome6 color={palette.darkMuted} name="location-dot" size={18} />
              </View>
            )}
          </View>

          <View style={styles.identityRow}>
            <View style={styles.avatarRing}>
              {profile.avatarUrl ? <Image accessibilityLabel={`${profile.displayName} avatar`} source={{ uri: profile.avatarUrl }} style={styles.avatar} /> : (
                <View style={styles.avatarFallback}><Text style={styles.avatarText}>{initials || 'S'}</Text></View>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: followBusy, selected: profile.followedByViewer }}
              disabled={followBusy}
              onPress={() => void toggleFollow()}
              style={[styles.followButton, profile.followedByViewer && styles.followButtonActive]}>
              {followBusy ? <ActivityIndicator color={profile.followedByViewer ? palette.ink : '#FFFFFF'} size="small" /> : (
                <Text style={[styles.followText, profile.followedByViewer && styles.followTextActive]}>{profile.followedByViewer ? 'Following' : 'Follow'}</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.identityCopy}>
            <View style={styles.nameLine}>
              <Text accessibilityRole="header" style={styles.displayName}>{profile.displayName}</Text>
              <TrustBadgeStrip badges={profile.badges} limit={5} />
            </View>
            <Text style={styles.username}>@{profile.username}</Text>
            {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}
            {profile.links.length ? (
              <View style={styles.links}>
                {profile.links.map((link) => (
                  <Pressable accessibilityRole="link" key={link.url} onPress={() => void Linking.openURL(link.url)} style={styles.link}>
                    <FontAwesome6 color={palette.accentDeep} name="link" size={10} />
                    <Text numberOfLines={1} style={styles.linkText}>{link.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>

          <View style={styles.stats}>
            <View style={styles.stat}><Text style={styles.statValue}>{profile.reviewCount}</Text><Text style={styles.statLabel}>Reviews</Text></View>
            <View style={styles.stat}><Text style={styles.statValue}>{profile.followerCount}</Text><Text style={styles.statLabel}>Followers</Text></View>
            <View style={styles.stat}><Text style={styles.statValue}>{profile.followingCount ?? '—'}</Text><Text style={styles.statLabel}>Following</Text></View>
            <View style={styles.stat}><Text style={styles.statValue}>{profile.favoriteCount ?? '—'}</Text><Text style={styles.statLabel}>Favorites</Text></View>
          </View>

          <View style={styles.reviewHeader}>
            <View><Text style={styles.eyebrow}>FIRST-HAND EXPERIENCES</Text><Text style={styles.reviewTitle}>Reviews by {profile.displayName}</Text></View>
            <Pressable accessibilityRole="link" onPress={() => router.push('/badges')}><Text style={styles.badgeGuide}>Badge guide</Text></Pressable>
          </View>

          <View style={styles.reviews}>
            {profile.reviews.map((review) => (
              <View key={review.id} style={styles.reviewCard}>
                <Pressable
                  accessibilityRole="link"
                  onPress={() => router.push({ pathname: '/place/[id]', params: { id: review.businessId } })}
                  style={styles.reviewPlaceRow}>
                  <View style={styles.placeIcon}><FontAwesome6 color={palette.accentDeep} name="store" size={11} /></View>
                  <View style={styles.reviewPlaceCopy}>
                    <Text style={styles.reviewPlace}>{review.businessName}</Text>
                    <Text style={styles.reviewDate}>{review.postedLabel}</Text>
                  </View>
                  <View style={styles.reviewStars}>
                    {[1, 2, 3, 4, 5].map((star) => <FontAwesome color={star <= review.rating ? palette.sun : palette.line} key={star} name="star" size={10} />)}
                  </View>
                </Pressable>
                <Text style={styles.reviewBody}>{review.body}</Text>
                {review.photos.length ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={styles.reviewPhotos}>{review.photos.map((photo) => <Image key={photo} source={{ uri: photo }} style={styles.reviewPhoto} />)}</View>
                  </ScrollView>
                ) : null}
                <View style={styles.reviewMeta}>
                  <FontAwesome6 color={palette.muted} name="thumbs-up" size={10} />
                  <Text style={styles.reviewMetaText}>{review.helpfulCount} helpful</Text>
                  <Text style={styles.reviewMetaDivider}>•</Text>
                  <Text style={styles.reviewMetaText}>Discussion appears here on the author’s profile</Text>
                </View>
              </View>
            ))}
            {!profile.reviews.length ? <View style={styles.noReviews}><Text style={styles.noReviewsTitle}>No public reviews yet</Text><Text style={styles.noReviewsBody}>Approved first-hand reviews will appear here.</Text></View> : null}
          </View>
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 120, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  centered: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.sm, justifyContent: 'center', padding: spacing.xl },
  loadingText: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  emptyIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 24, height: 48, justifyContent: 'center', width: 48 },
  emptyTitle: { color: palette.ink, fontSize: 22, fontWeight: '900' },
  emptyBody: { color: palette.muted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  backAction: { backgroundColor: palette.dark, borderRadius: radii.pill, marginTop: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: 13 },
  backActionText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  iconButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  topbarName: { color: palette.ink, flex: 1, fontSize: 12, fontWeight: '900', marginHorizontal: spacing.md, textAlign: 'center' },
  banner: { borderRadius: radii.xl, height: 178, marginTop: spacing.xl, overflow: 'hidden' },
  bannerImage: { height: '100%', width: '100%' },
  bannerFallback: { alignItems: 'center', backgroundColor: palette.dark, flex: 1, justifyContent: 'center', overflow: 'hidden' },
  bannerGlow: { backgroundColor: palette.accent, borderRadius: 130, height: 180, opacity: 0.22, position: 'absolute', right: -50, top: -90, width: 180 },
  identityRow: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', marginTop: -38, paddingHorizontal: spacing.md },
  avatarRing: { backgroundColor: palette.bg, borderRadius: 999, padding: 4 },
  avatar: { borderRadius: 999, height: 84, width: 84 },
  avatarFallback: { alignItems: 'center', backgroundColor: palette.dark, borderRadius: 999, height: 84, justifyContent: 'center', width: 84 },
  avatarText: { color: '#FFFFFF', fontSize: 21, fontWeight: '900' },
  followButton: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: radii.pill, justifyContent: 'center', minHeight: 42, minWidth: 104, paddingHorizontal: 18 },
  followButtonActive: { backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1 },
  followText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  followTextActive: { color: palette.ink },
  identityCopy: { gap: 5, marginTop: spacing.md, paddingHorizontal: spacing.md },
  nameLine: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  displayName: { color: palette.ink, fontSize: 25, fontWeight: '900', letterSpacing: -0.7 },
  username: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  bio: { color: palette.ink, fontSize: 12, lineHeight: 19, marginTop: 5, maxWidth: 600 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
  link: { alignItems: 'center', flexDirection: 'row', gap: 5, maxWidth: 190 },
  linkText: { color: palette.accentDeep, fontSize: 10, fontWeight: '800' },
  stats: { borderBottomColor: palette.line, borderBottomWidth: 1, borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', marginTop: spacing.xl },
  stat: { flex: 1, gap: 3, paddingVertical: spacing.lg },
  statValue: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  statLabel: { color: palette.muted, fontSize: 9 },
  reviewHeader: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xxxl },
  eyebrow: { color: palette.accentDeep, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  reviewTitle: { color: palette.ink, fontSize: 20, fontWeight: '900', letterSpacing: -0.4, marginTop: 5 },
  badgeGuide: { color: palette.accentDeep, fontSize: 10, fontWeight: '900' },
  reviews: { gap: spacing.md, marginTop: spacing.lg },
  reviewCard: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, gap: spacing.md, padding: spacing.lg },
  reviewPlaceRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  placeIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: radii.md, height: 34, justifyContent: 'center', width: 34 },
  reviewPlaceCopy: { flex: 1, gap: 2 },
  reviewPlace: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  reviewDate: { color: palette.muted, fontSize: 9 },
  reviewStars: { flexDirection: 'row', gap: 2 },
  reviewBody: { color: palette.ink, fontSize: 13, lineHeight: 20 },
  reviewPhotos: { flexDirection: 'row', gap: spacing.sm },
  reviewPhoto: { borderRadius: radii.md, height: 126, width: 158 },
  reviewMeta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  reviewMetaText: { color: palette.muted, fontSize: 9, fontWeight: '700' },
  reviewMetaDivider: { color: palette.line, fontSize: 9 },
  noReviews: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, gap: 5, padding: spacing.xxl },
  noReviewsTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  noReviewsBody: { color: palette.muted, fontSize: 10 },
});
