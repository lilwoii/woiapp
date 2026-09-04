import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { TrustBadgeStrip } from '@/components/trust-badge-strip';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { fetchFollowedFeed } from '@/lib/social-feed';
import type { FeedCursor, FeedFilter, FeedItem } from '@/types/feed';

const filters: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'business_post', label: 'Places' },
  { id: 'user_review', label: 'Reviews' },
];

export default function FeedScreen() {
  const auth = useAuth();
  const accountId = auth.status === 'authenticated' ? auth.account?.id : undefined;
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [snapshot, setSnapshot] = useState<{
    accountId: string;
    filter: FeedFilter;
    generation: number;
    items: FeedItem[];
    hasMore: boolean;
    nextCursor?: FeedCursor;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<{
    accountId: string;
    filter: FeedFilter;
    generation: number;
    retry: 'reload' | 'load_more';
    message: string;
  } | null>(null);
  const feedRequestGeneration = useRef(0);
  const loadMoreGeneration = useRef(0);
  const current = snapshot && snapshot.accountId === accountId && snapshot.filter === filter
    ? snapshot
    : null;
  const currentError = error && error.accountId === accountId && error.filter === filter
    ? error
    : null;

  useEffect(() => {
    let active = true;
    const generation = ++feedRequestGeneration.current;
    loadMoreGeneration.current += 1;
    if (!accountId) return () => { active = false; };
    const requestedAccountId = accountId;
    const requestedFilter = filter;
    const timer = setTimeout(() => {
      if (!active || generation !== feedRequestGeneration.current) return;
      setLoadingMore(false);
      setLoading(true);
      setError(null);
      void fetchFollowedFeed(requestedFilter, requestedAccountId).then((result) => {
        if (!active || generation !== feedRequestGeneration.current) return;
        setLoading(false);
        if (!result.ok || !result.data) {
          setError({
            accountId: requestedAccountId,
            filter: requestedFilter,
            generation,
            retry: 'reload',
            message: result.ok ? 'Your feed is unavailable.' : result.reason,
          });
          return;
        }
        setSnapshot({
          accountId: requestedAccountId,
          filter: requestedFilter,
          generation,
          items: result.data.items,
          hasMore: result.data.hasMore,
          nextCursor: result.data.nextCursor,
        });
      });
    }, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [accountId, filter, reloadKey]);

  const loadMore = async () => {
    if (!accountId || !current || !current.hasMore || !current.nextCursor || loadingMore) return;
    const requestedAccountId = accountId;
    const requestedFilter = filter;
    const generation = current.generation;
    const loadMoreRequest = ++loadMoreGeneration.current;
    setError(null);
    setLoadingMore(true);
    try {
      const result = await fetchFollowedFeed(requestedFilter, requestedAccountId, current.nextCursor);
      if (
        generation !== feedRequestGeneration.current ||
        loadMoreRequest !== loadMoreGeneration.current
      ) return;
      if (!result.ok || !result.data) {
        setError({
          accountId: requestedAccountId,
          filter: requestedFilter,
          generation,
          retry: 'load_more',
          message: result.ok ? 'More posts are unavailable.' : result.reason,
        });
        return;
      }
      setSnapshot((existing) => {
        if (
          !existing ||
          existing.accountId !== requestedAccountId ||
          existing.filter !== requestedFilter ||
          existing.generation !== generation
        ) return existing;
        const byKey = new Map(existing.items.map((item) => [`${item.type}:${item.id}`, item]));
        for (const item of result.data?.items ?? []) byKey.set(`${item.type}:${item.id}`, item);
        return {
          ...existing,
          items: [...byKey.values()],
          hasMore: result.data?.hasMore ?? false,
          nextCursor: result.data?.nextCursor,
        };
      });
    } finally {
      if (loadMoreRequest === loadMoreGeneration.current) setLoadingMore(false);
    }
  };

  if (auth.status !== 'authenticated') {
    return (
      <FocusAwareScreen>
        <View role="main" style={styles.gate}>
          <View style={styles.gateIcon}><FontAwesome6 color={palette.accentDeep} name="newspaper" size={20} /></View>
          <Text accessibilityRole="header" style={styles.gateTitle}>Your local food feed</Text>
          <Text style={styles.gateBody}>Sign in to see new posts from saved places and reviews from people you follow.</Text>
          <Pressable accessibilityRole="button" onPress={() => router.push('/auth')} style={styles.primaryButton}><Text style={styles.primaryText}>Sign in</Text></Pressable>
        </View>
      </FocusAwareScreen>
    );
  }

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} style={styles.screen}>
        <PageShell narrow>
          <View style={styles.heading}>
            <Text style={styles.eyebrow}>FOLLOWING</Text>
            <Text accessibilityRole="header" style={styles.title}>Fresh from your spots.</Text>
            <Text style={styles.subtitle}>Posts from saved places and reviews from people you follow, newest first.</Text>
          </View>

          <View accessibilityLabel="Feed filter" accessibilityRole="tablist" style={styles.filters}>
            {filters.map((item) => {
              const selected = item.id === filter;
              return (
                <Pressable accessibilityRole="tab" accessibilityState={{ selected }} aria-selected={selected} key={item.id} onPress={() => setFilter(item.id)} style={[styles.filter, selected && styles.filterActive]}>
                  <Text style={[styles.filterText, selected && styles.filterTextActive]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {currentError && current ? (
            <View accessibilityRole="alert" style={styles.error}>
              <Text style={styles.errorText}>{currentError.message}</Text>
              <Pressable
                accessibilityRole="button"
                disabled={currentError.retry === 'load_more' ? loadingMore : loading}
                onPress={() => {
                  setError(null);
                  if (currentError.retry === 'load_more') void loadMore();
                  else setReloadKey((value) => value + 1);
                }}
                style={styles.retryButton}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}
          {!current && !currentError ? (
            <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.loadingText}>Loading followed updates…</Text></View>
          ) : currentError && !current ? (
            <View accessibilityRole="alert" style={styles.error}>
              <Text style={styles.errorText}>{currentError.message}</Text>
              <Pressable
                accessibilityRole="button"
                disabled={loading}
                onPress={() => {
                  setError(null);
                  setReloadKey((value) => value + 1);
                }}
                style={styles.retryButton}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : current?.items.length ? (
            <View style={styles.feed}>
              {current.items.map((item) => <FeedRow item={item} key={`${item.type}:${item.id}`} />)}
              {current.hasMore ? (
                <Pressable accessibilityRole="button" accessibilityState={{ busy: loadingMore }} disabled={loadingMore} onPress={() => void loadMore()} style={styles.loadMore}>
                  {loadingMore ? <ActivityIndicator color={palette.ink} size="small" /> : null}
                  <Text style={styles.loadMoreText}>Load more</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <View style={styles.empty}>
              <FontAwesome6 color={palette.accentDeep} name="user-plus" size={19} />
              <Text style={styles.emptyTitle}>Your feed starts with a follow</Text>
              <Text style={styles.emptyBody}>Save a place or follow a reviewer to collect their latest activity here.</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/')} style={styles.secondaryButton}><Text style={styles.secondaryText}>Explore nearby</Text></Pressable>
            </View>
          )}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const isBusiness = item.type === 'business_post';
  return (
    <View style={styles.item}>
      <View style={styles.itemHeader}>
        <Pressable accessibilityLabel={`View ${item.businessName}`} accessibilityRole="link" onPress={() => router.push({ pathname: '/place/[id]', params: { id: item.businessId } })} style={styles.identityIcon}>
          {item.businessLogoUrl ? <Image accessibilityLabel={`${item.businessName} logo`} source={{ uri: item.businessLogoUrl }} style={styles.identityLogo} /> : <FontAwesome6 color={palette.accentDeep} name={isBusiness ? 'store' : 'utensils'} size={11} />}
        </Pressable>
        <View style={styles.itemIdentity}>
          {isBusiness ? <View style={styles.authorLine}><Text style={styles.identityName}>{item.businessName}</Text><TrustBadgeStrip badges={item.badges} limit={3} /></View> : (
            <View style={styles.authorLine}>
              <Pressable accessibilityRole="link" onPress={() => item.authorId && router.push({ pathname: '/profile/[id]', params: { id: item.authorId } })}>
                <Text style={styles.identityName}>{item.authorDisplayName ?? 'Spottr member'}</Text>
              </Pressable>
              <TrustBadgeStrip badges={item.badges} limit={3} />
            </View>
          )}
          <Text style={styles.itemMeta}>{isBusiness ? 'Business post' : `@${item.authorUsername ?? 'member'} reviewed ${item.businessName}`} · {item.createdLabel} · {item.createdDateTimeLabel}</Text>
        </View>
        {item.rating ? <View accessibilityLabel={`${item.rating} stars`} style={styles.rating}>{[1, 2, 3, 4, 5].map((star) => <FontAwesome6 color={star <= item.rating! ? palette.sun : palette.line} key={star} name="star" size={9} />)}</View> : null}
      </View>
      {item.body ? <Text style={styles.itemBody}>{item.body}</Text> : null}
      {item.photos.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.photos}>{item.photos.map((photo) => <Image key={photo} source={{ uri: photo }} style={styles.photo} />)}</View></ScrollView> : null}
      <View style={styles.itemActions}>
        <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/place/[id]', params: { id: item.businessId } })} style={styles.placeLink}>
          <Text style={styles.placeLinkText}>View {item.businessName}</Text>
          <FontAwesome6 color={palette.ink} name="arrow-right" size={9} />
        </Pressable>
        {isBusiness ? (
          <Pressable accessibilityLabel={`Report post from ${item.businessName}`} accessibilityRole="button" onPress={() => router.push({ pathname: '/report', params: { targetId: item.id, targetType: 'business_post' } })} style={styles.reportLink}>
            <FontAwesome6 color={palette.muted} name="flag" size={8} />
            <Text style={styles.reportText}>Report</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 120, paddingHorizontal: spacing.lg, paddingTop: spacing.xl },
  heading: { gap: 7, paddingTop: spacing.lg },
  eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  title: { color: palette.ink, fontSize: 31, fontWeight: '900', letterSpacing: -1.1 },
  subtitle: { color: palette.muted, fontSize: 11, lineHeight: 17, maxWidth: 520 },
  filters: { borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: 3, marginTop: spacing.xl, paddingBottom: spacing.sm },
  filter: { borderRadius: radii.pill, justifyContent: 'center', minHeight: 38, paddingHorizontal: 15 },
  filterActive: { backgroundColor: palette.dark },
  filterText: { color: palette.muted, fontSize: 10, fontWeight: '900' },
  filterTextActive: { color: '#FFFFFF' },
  feed: { marginTop: spacing.sm },
  item: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.md, paddingVertical: spacing.xl },
  itemHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  identityIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 999, height: 36, justifyContent: 'center', width: 36 },
  identityLogo: { borderRadius: 999, height: '100%', width: '100%' },
  itemIdentity: { flex: 1, gap: 3 },
  authorLine: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  identityName: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  itemMeta: { color: palette.muted, fontSize: 8, lineHeight: 13 },
  rating: { flexDirection: 'row', gap: 1 },
  itemBody: { color: palette.ink, fontSize: 13, lineHeight: 20, maxWidth: 680 },
  photos: { flexDirection: 'row', gap: spacing.sm },
  photo: { backgroundColor: palette.line, borderRadius: radii.md, height: 180, width: 230 },
  placeLink: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 7, minHeight: 38 },
  placeLinkText: { color: palette.ink, fontSize: 9, fontWeight: '900' },
  itemActions: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  reportLink: { alignItems: 'center', flexDirection: 'row', gap: 5, minHeight: 38, paddingHorizontal: spacing.sm },
  reportText: { color: palette.muted, fontSize: 8, fontWeight: '800' },
  loadMore: { alignItems: 'center', alignSelf: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 46, paddingHorizontal: spacing.lg },
  loadMoreText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 180 },
  loadingText: { color: palette.muted, fontSize: 10 },
  error: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginTop: spacing.md, padding: spacing.md },
  errorText: { color: palette.accentDeep, fontSize: 10, lineHeight: 16 },
  retryButton: { alignItems: 'center', alignSelf: 'flex-start', borderColor: palette.accentDeep, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center', marginTop: spacing.sm, minHeight: 40, paddingHorizontal: spacing.md },
  retryText: { color: palette.accentDeep, fontSize: 10, fontWeight: '900' },
  empty: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, borderTopColor: palette.line, borderTopWidth: 1, gap: spacing.sm, marginTop: spacing.xl, paddingVertical: 54 },
  emptyTitle: { color: palette.ink, fontSize: 16, fontWeight: '900' },
  emptyBody: { color: palette.muted, fontSize: 10, lineHeight: 16, maxWidth: 380, textAlign: 'center' },
  secondaryButton: { borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center', marginTop: spacing.sm, minHeight: 44, paddingHorizontal: spacing.lg },
  secondaryText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  gate: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  gateIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 999, height: 52, justifyContent: 'center', width: 52 },
  gateTitle: { color: palette.ink, fontSize: 22, fontWeight: '900' },
  gateBody: { color: palette.muted, fontSize: 11, lineHeight: 17, maxWidth: 420, textAlign: 'center' },
  primaryButton: { backgroundColor: palette.dark, borderRadius: radii.pill, justifyContent: 'center', minHeight: 46, paddingHorizontal: spacing.xl },
  primaryText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
});
