import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import {
  decideModerationItem,
  loadModerationQueue,
  type ModerationDecision,
  type ModerationQueueItem,
} from '@/lib/content-moderation';

export default function ModerationScreen() {
  const auth = useAuth();
  const [items, setItems] = useState<ModerationQueueItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const canLoad =
    auth.status === 'authenticated' &&
    auth.securityStatus === 'ready' &&
    auth.mfaEnrolled &&
    auth.assuranceLevel === 'aal2';

  const load = useCallback(async (offset = 0) => {
    if (!canLoad) return;
    if (offset) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setMessage(null);
    const result = await loadModerationQueue(offset);
    setLoading(false);
    setLoadingMore(false);
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.reason });
      return;
    }
    setItems((current) =>
      offset
        ? [
            ...new Map(
              [...current, ...result.data.items].map((item) => [
                `${item.targetType}:${item.targetId}`,
                item,
              ])
            ).values(),
          ]
        : result.data.items
    );
    setHasMore(result.data.hasMore);
  }, [canLoad]);

  useEffect(() => {
    if (!canLoad) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [canLoad, load]);

  const decide = async (item: ModerationQueueItem, decision: ModerationDecision) => {
    if (savingId) return;
    setSavingId(`${item.targetType}:${item.targetId}`);
    setMessage(null);
    const result = await decideModerationItem(item, decision, reason);
    setSavingId(null);
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.reason });
      if (result.code === 'CONFLICT') await load();
      return;
    }
    setItems((current) => current.filter((candidate) => candidate !== item));
    setSelectedId(null);
    setReason('');
    setMessage({
      tone: 'success',
      text: item.targetType === 'review_comment'
        ? decision === 'approved' ? 'Comment kept and reports dismissed with an audit receipt.' : 'Comment removed and reports resolved with an audit receipt.'
        : decision === 'approved' ? 'Content approved and audit receipt recorded.' : 'Content rejected and audit receipt recorded.',
    });
  };

  if (!canLoad) {
    return (
      <FocusAwareScreen>
        <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
          <PageShell narrow>
            <View style={styles.topbar}><BrandMark /></View>
            <View style={styles.gate}>
              <View style={styles.gateIcon}><FontAwesome6 color={palette.accentDeep} name="shield-halved" size={24} /></View>
              <Text accessibilityRole="header" style={styles.gateTitle}>Protected moderation workspace</Text>
              <Text style={styles.gateBody}>Sign in with an authorized staff account and verify a current authenticator code. Database roles—not this screen—decide access.</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push(auth.status === 'anonymous' ? '/auth' : '/security')} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>{auth.status === 'anonymous' ? 'Sign in' : 'Verify security'}</Text>
              </Pressable>
            </View>
          </PageShell>
        </ScrollView>
      </FocusAwareScreen>
    );
  }

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <BrandMark />
            <Pressable accessibilityLabel="Close moderation" accessibilityRole="button" onPress={() => router.back()} style={styles.closeButton}><FontAwesome6 color={palette.ink} name="xmark" size={14} /></Pressable>
          </View>
          <View style={styles.intro}>
            <Text style={styles.eyebrow}>Trust operations</Text>
            <Text accessibilityRole="header" style={styles.title}>Moderate with context and an audit trail.</Text>
            <Text style={styles.subtitle}>Approve or keep only professional, relevant, safe content. Every decision requires an internal reason.</Text>
            <Pressable accessibilityHint="Open reported chat and pickup site queues" accessibilityRole="button" onPress={() => router.push('/marketplace-moderation' as Href)} style={styles.operationsLink}>
              <Text style={styles.operationsLinkText}>Chat reports &amp; pickup safety</Text>
              <FontAwesome6 color={palette.ink} name="arrow-right" size={11} />
            </Pressable>
          </View>

          {message ? (
            <View accessibilityLiveRegion="polite" accessibilityRole={message.tone === 'error' ? 'alert' : undefined} style={[styles.message, message.tone === 'success' && styles.messageSuccess]}>
              <Text style={[styles.messageText, message.tone === 'success' && styles.messageTextSuccess]}>{message.text}</Text>
            </View>
          ) : null}

          {loading ? (
            <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.loadingText}>Loading the oldest pending content…</Text></View>
          ) : !items.length ? (
            <View style={styles.empty}><FontAwesome6 color={palette.success} name="circle-check" size={21} /><Text accessibilityRole="header" style={styles.emptyTitle}>Queue clear</Text><Text style={styles.emptyBody}>No pending content or reported profile comments are available to this operator.</Text></View>
          ) : (
            <View style={styles.queue}>
              {items.map((item) => {
                const key = `${item.targetType}:${item.targetId}`;
                const selected = selectedId === key;
                const mediaReady = item.context.all_media_clean !== false;
                return (
                  <View key={key} style={styles.item}>
                    <View style={styles.itemHeader}>
                      <View style={styles.itemCopy}>
                        <Text style={styles.itemType}>{item.targetType}</Text>
                        <Text style={styles.businessName}>{item.businessName}</Text>
                        <Text style={styles.author}>By {item.authorDisplayName} · {new Date(item.submittedAt).toLocaleString()}</Text>
                      </View>
                      {item.rating ? <Text accessibilityLabel={`${item.rating} stars`} style={styles.rating}>{'★'.repeat(item.rating)}</Text> : null}
                    </View>
                    <Text style={styles.body}>{item.body}</Text>
                    {item.targetType === 'review' && !mediaReady ? (
                      <View accessibilityRole="alert" style={styles.mediaHold}><FontAwesome6 color={palette.warning} name="image" size={11} /><Text style={styles.mediaHoldText}>Photo safety processing is incomplete. Approval is blocked.</Text></View>
                    ) : null}
                    {selected ? (
                      <View style={styles.decisionPanel}>
                        <TextInput accessibilityLabel="Internal moderation reason" maxLength={1000} multiline onChangeText={setReason} placeholder="Reason recorded in the restricted audit log" placeholderTextColor={palette.mutedLight} style={styles.reasonInput} textAlignVertical="top" value={reason} />
                        <View style={styles.decisionActions}>
                          <Pressable accessibilityRole="button" disabled={Boolean(savingId)} onPress={() => { setSelectedId(null); setReason(''); }} style={styles.cancelButton}><Text style={styles.cancelText}>Cancel</Text></Pressable>
                          <Pressable accessibilityRole="button" accessibilityState={{ busy: savingId === key, disabled: Boolean(savingId) }} disabled={Boolean(savingId)} onPress={() => void decide(item, 'rejected')} style={styles.rejectButton}><Text style={styles.rejectText}>{item.targetType === 'review_comment' ? 'Remove' : 'Reject'}</Text></Pressable>
                          <Pressable accessibilityRole="button" accessibilityState={{ busy: savingId === key, disabled: Boolean(savingId) || !mediaReady }} disabled={Boolean(savingId) || !mediaReady} onPress={() => void decide(item, 'approved')} style={[styles.approveButton, (!mediaReady || Boolean(savingId)) && styles.disabled]}>{savingId === key ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}<Text style={styles.approveText}>{item.targetType === 'review_comment' ? 'Keep' : 'Approve'}</Text></Pressable>
                        </View>
                      </View>
                    ) : (
                      <Pressable accessibilityRole="button" onPress={() => { setSelectedId(key); setReason(''); }} style={styles.reviewButton}><Text style={styles.reviewText}>Review decision</Text><FontAwesome6 color={palette.ink} name="arrow-right" size={10} /></Pressable>
                    )}
                  </View>
                );
              })}
              {hasMore ? (
                <Pressable accessibilityRole="button" accessibilityState={{ busy: loadingMore, disabled: loadingMore }} disabled={loadingMore} onPress={() => void load(items.length)} style={styles.loadMore}>{loadingMore ? <ActivityIndicator color={palette.ink} size="small" /> : null}<Text style={styles.loadMoreText}>Load more pending content</Text></Pressable>
              ) : null}
            </View>
          )}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 88, paddingHorizontal: spacing.lg },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: spacing.md },
  closeButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
  intro: { gap: spacing.sm, paddingBottom: spacing.xl, paddingTop: 48 },
  eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: palette.ink, fontSize: 32, fontWeight: '900', letterSpacing: -1.2, lineHeight: 37 },
  subtitle: { color: palette.muted, fontSize: 13, lineHeight: 20, maxWidth: 580 },
  operationsLink: { alignItems: 'center', alignSelf: 'flex-start', borderBottomColor: palette.ink, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  operationsLinkText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  message: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginBottom: spacing.lg, padding: spacing.md },
  messageSuccess: { backgroundColor: palette.successSoft },
  messageText: { color: palette.accentDeep, fontSize: 11, lineHeight: 17 },
  messageTextSuccess: { color: palette.success },
  loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 100 },
  loadingText: { color: palette.muted, fontSize: 11 },
  empty: { alignItems: 'center', borderBottomColor: palette.line, borderTopColor: palette.line, borderBottomWidth: 1, borderTopWidth: 1, gap: spacing.sm, paddingVertical: 60 },
  emptyTitle: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  emptyBody: { color: palette.muted, fontSize: 11, lineHeight: 17, maxWidth: 440, textAlign: 'center' },
  queue: { gap: 0 },
  item: { borderTopColor: palette.line, borderTopWidth: 1, gap: spacing.md, paddingVertical: spacing.xl },
  itemHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  itemCopy: { flex: 1, gap: 3 },
  itemType: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, letterSpacing: 0.7, textTransform: 'uppercase' },
  businessName: { color: palette.ink, fontSize: 15, fontWeight: '900' },
  author: { color: palette.muted, fontSize: 9 },
  rating: { color: palette.sun, fontSize: 11, letterSpacing: 2 },
  body: { color: palette.ink, fontSize: 13, lineHeight: 20 },
  mediaHold: { alignItems: 'center', backgroundColor: palette.warningSoft, borderRadius: radii.md, flexDirection: 'row', gap: spacing.sm, padding: spacing.sm },
  mediaHoldText: { color: palette.warning, flex: 1, fontSize: 9, lineHeight: 14 },
  reviewButton: { alignItems: 'center', alignSelf: 'flex-start', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 8, minHeight: 44, paddingHorizontal: 14 },
  reviewText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  decisionPanel: { backgroundColor: palette.surface, borderRadius: radii.lg, gap: spacing.md, padding: spacing.md },
  reasonInput: { borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 11, lineHeight: 17, minHeight: 94, padding: spacing.md },
  decisionActions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'flex-end' },
  cancelButton: { justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.sm },
  cancelText: { color: palette.muted, fontSize: 10, fontWeight: '800' },
  rejectButton: { alignItems: 'center', borderColor: palette.accentDeep, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 15 },
  rejectText: { color: palette.accentDeep, fontSize: 10, fontWeight: '900' },
  approveButton: { alignItems: 'center', backgroundColor: palette.success, borderRadius: radii.pill, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44, paddingHorizontal: 16 },
  approveText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  disabled: { opacity: 0.5 },
  loadMore: { alignItems: 'center', alignSelf: 'center', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: spacing.sm, justifyContent: 'center', marginTop: spacing.lg, minHeight: 46, paddingHorizontal: 18 },
  loadMoreText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  gate: { alignItems: 'center', gap: spacing.md, paddingVertical: 92 },
  gateIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 999, height: 60, justifyContent: 'center', width: 60 },
  gateTitle: { color: palette.ink, fontSize: 23, fontWeight: '900', textAlign: 'center' },
  gateBody: { color: palette.muted, fontSize: 12, lineHeight: 19, maxWidth: 480, textAlign: 'center' },
  primaryButton: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: radii.pill, justifyContent: 'center', minHeight: 48, paddingHorizontal: 20 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
});
