import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { featureFlags } from '@/lib/features';
import { confirmAction, showMessage } from '@/lib/platform-dialog';
import { createMarketplaceIdempotencyKey } from '@/lib/marketplace-api';
import { createBusinessPost, deleteBusinessPost, fetchBusinessPostMediaCandidates, fetchBusinessPosts, uploadBusinessPostMedia } from '@/lib/social-feed';
import type { BusinessPostMediaCandidate, FeedItem } from '@/types/feed';

export default function BusinessPostsScreen() {
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  const auth = useAuth();
  const { managedPlaceIds, places } = useMarketplaceStore();
  const business = places.find((place) => place.id === businessId && managedPlaceIds.includes(place.id));
  const accountId = auth.status === 'authenticated' ? auth.account?.id : undefined;
  const canManage = Boolean(
    business && accountId && auth.securityStatus === 'ready' && auth.mfaEnrolled && auth.assuranceLevel === 'aal2'
  );
  const [posts, setPosts] = useState<FeedItem[]>([]);
  const [candidates, setCandidates] = useState<BusinessPostMediaCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const postAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const load = useCallback(async () => {
    if (!business || !accountId || !canManage) return;
    setLoading(true);
    const [postResult, mediaResult] = await Promise.all([
      fetchBusinessPosts(business.id),
      fetchBusinessPostMediaCandidates(business.id, accountId),
    ]);
    setLoading(false);
    if (!postResult.ok || !postResult.data) {
      setMessage({ tone: 'error', text: postResult.ok ? 'Posts are unavailable.' : postResult.reason });
      return;
    }
    setPosts(postResult.data.items);
    if (mediaResult.ok && mediaResult.data) setCandidates(mediaResult.data);
  }, [accountId, business, canManage]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const chooseUpload = async () => {
    if (!business || !accountId || uploading) return;
    if (!featureFlags.mediaUploads) {
      setMessage({
        tone: 'error',
        text: 'Photo uploads are not available in this release. Text posts remain available.',
      });
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showMessage('Photo permission required', 'Allow photo access to add a business post image.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [4, 3], quality: 0.9 });
    if (picked.canceled || !picked.assets[0]) return;
    const image = picked.assets[0];
    setUploading(true);
    setMessage(null);
    const result = await uploadBusinessPostMedia({ uri: image.uri, mimeType: image.mimeType, fileSize: image.fileSize }, business.id, accountId);
    setUploading(false);
    setMessage({ tone: result.ok ? 'success' : 'error', text: result.ok ? result.message ?? 'Image queued for approval.' : result.reason });
  };

  const toggleCandidate = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 4 ? [...current, id] : current);
  };

  const publish = async () => {
    if (!business || !accountId || saving) return;
    setSaving(true);
    setMessage(null);
    const fingerprint = `${business.id}\u0000${body.trim()}\u0000${selectedIds.join(',')}`;
    const idempotencyKey = postAttempt.current?.fingerprint === fingerprint
      ? postAttempt.current.key
      : createMarketplaceIdempotencyKey('post');
    postAttempt.current = { fingerprint, key: idempotencyKey };
    const result = await createBusinessPost(business.id, body, selectedIds, accountId, idempotencyKey);
    setSaving(false);
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.reason });
      return;
    }
    setBody('');
    setSelectedIds([]);
    postAttempt.current = null;
    setMessage({ tone: 'success', text: 'Post published to followers and your business profile.' });
    await load();
  };

  const remove = async (post: FeedItem) => {
    if (!accountId || saving) return;
    const confirmed = await confirmAction({ title: 'Delete this post?', message: 'It will disappear from your business profile and follower feeds.', confirmLabel: 'Delete post', destructive: true });
    if (!confirmed) return;
    setSaving(true);
    const result = await deleteBusinessPost(post.id, accountId);
    setSaving(false);
    if (!result.ok || !result.data) {
      showMessage('Delete unavailable', result.ok ? 'This post was already removed.' : result.reason);
      return;
    }
    setPosts((current) => current.filter((item) => item.id !== post.id));
  };

  if (!canManage || !business) {
    return (
      <FocusAwareScreen>
        <View role="main" style={styles.gate}>
          <View style={styles.gateIcon}><FontAwesome6 color={palette.accentDeep} name="shield-halved" size={20} /></View>
          <Text accessibilityRole="header" style={styles.gateTitle}>Protected publishing</Text>
          <Text style={styles.gateBody}>Choose a managed business and verify a current authenticator code before publishing.</Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace(auth.status === 'anonymous' ? '/auth' : '/security')} style={styles.primaryButton}><Text style={styles.primaryText}>{auth.status === 'anonymous' ? 'Sign in' : 'Verify security'}</Text></Pressable>
        </View>
      </FocusAwareScreen>
    );
  }

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}><FontAwesome6 color={palette.ink} name="arrow-left" size={12} /></Pressable>
            <Text numberOfLines={1} style={styles.topbarTitle}>{business.name}</Text>
            <View style={styles.secure}><FontAwesome6 color={palette.success} name="lock" size={9} /><Text style={styles.secureText}>Protected</Text></View>
          </View>

          <View style={styles.heading}>
            <Text style={styles.eyebrow}>BUSINESS POSTS</Text>
            <Text accessibilityRole="header" style={styles.title}>Keep followers in the loop.</Text>
            <Text style={styles.subtitle}>Share food photos, specials, schedule changes, or a short update. Posts remain until you delete them.</Text>
          </View>

          <View style={styles.composer}>
            <View style={styles.composerHeader}><Text style={styles.composerLabel}>NEW POST</Text><Text style={styles.counter}>{body.length}/500</Text></View>
            <TextInput accessibilityLabel="Business post" maxLength={500} multiline onChangeText={setBody} placeholder="What should followers know?" placeholderTextColor={palette.mutedLight} style={styles.input} textAlignVertical="top" value={body} />
            <View style={styles.mediaHeader}>
              <Text style={styles.mediaLabel}>APPROVED PHOTOS · {selectedIds.length}/4</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !featureFlags.mediaUploads || uploading, busy: uploading }}
                disabled={!featureFlags.mediaUploads || uploading}
                onPress={() => void chooseUpload()}
                style={[styles.uploadButton, !featureFlags.mediaUploads && styles.disabled]}>
                {uploading ? <ActivityIndicator color={palette.ink} size="small" /> : <FontAwesome6 color={palette.ink} name="image" size={10} />}
                <Text style={styles.uploadText}>{uploading ? 'Uploading…' : featureFlags.mediaUploads ? 'Upload new' : 'Upload gated'}</Text>
              </Pressable>
            </View>
            {candidates.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.candidates}>{candidates.map((candidate) => { const selected = selectedIds.includes(candidate.id); return <Pressable accessibilityLabel={`${selected ? 'Remove' : 'Select'} approved post image`} accessibilityRole="button" accessibilityState={{ selected }} key={candidate.id} onPress={() => toggleCandidate(candidate.id)} style={[styles.candidate, selected && styles.candidateSelected]}><Image source={{ uri: candidate.url }} style={styles.candidateImage} />{selected ? <View style={styles.selectedMark}><FontAwesome6 color="#FFFFFF" name="check" size={9} /></View> : null}</Pressable>; })}</View></ScrollView> : <Text style={styles.mediaHint}>{featureFlags.mediaUploads ? 'New images appear here after automated safety processing and approval.' : 'Text posts remain available. New photos stay off until the safety pipeline is approved.'}</Text>}
            {message ? <View accessibilityLiveRegion="polite" accessibilityRole={message.tone === 'error' ? 'alert' : undefined} style={[styles.message, message.tone === 'success' && styles.messageSuccess]}><Text style={[styles.messageText, message.tone === 'success' && styles.messageTextSuccess]}>{message.text}</Text></View> : null}
            <Pressable accessibilityRole="button" accessibilityState={{ busy: saving }} disabled={saving || (!body.trim() && !selectedIds.length)} onPress={() => void publish()} style={[styles.publishButton, (saving || (!body.trim() && !selectedIds.length)) && styles.disabled]}>{saving ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}<Text style={styles.publishText}>Publish post</Text><FontAwesome6 color="#FFFFFF" name="arrow-up" size={10} /></Pressable>
          </View>

          <View style={styles.postHeading}><Text style={styles.postHeadingText}>PUBLISHED</Text><Text style={styles.postCount}>{posts.length}</Text></View>
          {loading ? <View style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.loadingText}>Loading posts…</Text></View> : posts.length ? <View>{posts.map((post) => <View key={post.id} style={styles.post}><View style={styles.postMeta}><Text style={styles.postTime}>{post.createdLabel} · {post.createdDateTimeLabel}</Text><Pressable accessibilityLabel="Delete post" accessibilityRole="button" onPress={() => void remove(post)} style={styles.deleteButton}><FontAwesome6 color={palette.muted} name="trash" size={10} /></Pressable></View>{post.body ? <Text style={styles.postBody}>{post.body}</Text> : null}{post.photos.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.postPhotos}>{post.photos.map((photo) => <Image key={photo} source={{ uri: photo }} style={styles.postPhoto} />)}</View></ScrollView> : null}</View>)}</View> : <View style={styles.empty}><Text style={styles.emptyTitle}>No posts yet</Text><Text style={styles.emptyBody}>Your first post will appear here and in follower feeds.</Text></View>}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 100, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  iconButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  topbarTitle: { color: palette.ink, flex: 1, fontSize: 12, fontWeight: '900', marginHorizontal: spacing.md, textAlign: 'center' },
  secure: { alignItems: 'center', flexDirection: 'row', gap: 5, width: 72 },
  secureText: { color: palette.success, fontSize: 8, fontWeight: '900' },
  heading: { gap: 7, paddingTop: 46 },
  eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  title: { color: palette.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1 },
  subtitle: { color: palette.muted, fontSize: 11, lineHeight: 18, maxWidth: 550 },
  composer: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.md, paddingBottom: spacing.xxl, paddingTop: spacing.xl },
  composerHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  composerLabel: { color: palette.ink, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  counter: { color: palette.muted, fontSize: 9 },
  input: { borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, color: palette.ink, fontSize: 13, lineHeight: 20, minHeight: 116, padding: spacing.md },
  mediaHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  mediaLabel: { color: palette.muted, fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },
  uploadButton: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 40, paddingHorizontal: spacing.sm },
  uploadText: { color: palette.ink, fontSize: 9, fontWeight: '900' },
  candidates: { flexDirection: 'row', gap: spacing.sm },
  candidate: { borderColor: 'transparent', borderRadius: radii.md, borderWidth: 2, height: 92, overflow: 'hidden', width: 120 },
  candidateSelected: { borderColor: palette.accentDeep },
  candidateImage: { height: '100%', width: '100%' },
  selectedMark: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 999, height: 22, justifyContent: 'center', position: 'absolute', right: 5, top: 5, width: 22 },
  mediaHint: { color: palette.muted, fontSize: 9, lineHeight: 15 },
  message: { backgroundColor: palette.accentSoft, borderRadius: radii.md, padding: spacing.sm },
  messageSuccess: { backgroundColor: palette.successSoft },
  messageText: { color: palette.accentDeep, fontSize: 9, lineHeight: 15 },
  messageTextSuccess: { color: palette.success },
  publishButton: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: palette.dark, borderRadius: radii.pill, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 46, paddingHorizontal: spacing.lg },
  publishText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  disabled: { opacity: 0.5 },
  postHeading: { alignItems: 'center', flexDirection: 'row', gap: 7, paddingTop: spacing.xxl },
  postHeadingText: { color: palette.ink, fontSize: 9, fontWeight: '900', letterSpacing: 0.9 },
  postCount: { color: palette.muted, fontSize: 9 },
  post: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.md, paddingVertical: spacing.xl },
  postMeta: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  postTime: { color: palette.muted, fontSize: 9 },
  deleteButton: { alignItems: 'center', height: 36, justifyContent: 'center', width: 36 },
  postBody: { color: palette.ink, fontSize: 13, lineHeight: 20 },
  postPhotos: { flexDirection: 'row', gap: spacing.sm },
  postPhoto: { borderRadius: radii.md, height: 164, width: 220 },
  loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 100 },
  loadingText: { color: palette.muted, fontSize: 9 },
  empty: { alignItems: 'center', gap: 5, paddingVertical: 48 },
  emptyTitle: { color: palette.ink, fontSize: 14, fontWeight: '900' },
  emptyBody: { color: palette.muted, fontSize: 9 },
  gate: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  gateIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 999, height: 52, justifyContent: 'center', width: 52 },
  gateTitle: { color: palette.ink, fontSize: 22, fontWeight: '900' },
  gateBody: { color: palette.muted, fontSize: 11, lineHeight: 17, maxWidth: 420, textAlign: 'center' },
  primaryButton: { backgroundColor: palette.dark, borderRadius: radii.pill, justifyContent: 'center', minHeight: 46, paddingHorizontal: spacing.xl },
  primaryText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
});
