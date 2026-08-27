import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { loadCreatorInvitations, respondCreatorInvitation } from '@/lib/creator-invitations';
import type { CreatorInvitation } from '@/types/creator-invitations';

type Filter = 'received' | 'sent';

export default function CreatorInvitationsScreen() {
  const auth = useAuth();
  const accountId = auth.status === 'authenticated' ? auth.account?.id : undefined;
  const [items, setItems] = useState<CreatorInvitation[]>([]);
  const [filter, setFilter] = useState<Filter>('received');
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const result = await loadCreatorInvitations(accountId);
    setLoading(false);
    if (!result.ok || !result.data) setNotice(result.ok ? 'Invitations are unavailable.' : result.reason);
    else setItems(result.data);
  }, [accountId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const respond = async (item: CreatorInvitation, decision: 'accepted' | 'declined') => {
    if (!accountId || savingId) return;
    setSavingId(item.id);
    const result = await respondCreatorInvitation(item.id, decision, notes[item.id] ?? '', accountId);
    setSavingId(null);
    if (!result.ok || !result.data) {
      setNotice(result.ok ? 'The response was not saved.' : result.reason);
      return;
    }
    setItems((current) => current.map((candidate) => candidate.id === item.id ? {
      ...candidate,
      status: result.data!,
      responseNote: notes[item.id]?.trim() || null,
      respondedAt: new Date().toISOString(),
    } : candidate));
  };

  if (auth.status !== 'authenticated') {
    return <FocusAwareScreen><View role="main" style={styles.gate}><FontAwesome6 color={palette.accentDeep} name="envelope" size={22} /><Text accessibilityRole="header" style={styles.gateTitle}>Private invitations</Text><Text style={styles.gateBody}>Sign in to review invitations from verified businesses.</Text><Pressable accessibilityRole="button" onPress={() => router.replace('/auth')} style={styles.primary}><Text style={styles.primaryText}>Sign in</Text></Pressable></View></FocusAwareScreen>;
  }

  const visible = items.filter((item) => filter === 'received' ? item.isRecipient : !item.isRecipient);
  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}><Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}><FontAwesome6 color={palette.ink} name="arrow-left" size={12} /></Pressable><Text style={styles.topbarTitle}>Invitations</Text><Pressable accessibilityLabel="Invitation privacy settings" accessibilityRole="button" onPress={() => router.push('/profile-edit')} style={styles.iconButton}><FontAwesome6 color={palette.ink} name="sliders" size={12} /></Pressable></View>
          <View style={styles.heading}><Text style={styles.eyebrow}>PRIVATE · OPTIONAL</Text><Text accessibilityRole="header" style={styles.title}>Community invitations.</Text><Text style={styles.subtitle}>Invitations never affect organic badges, review ranking, or a business’s rating.</Text></View>
          <View accessibilityRole="tablist" style={styles.tabs}>{(['received', 'sent'] as const).map((value) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: filter === value }} key={value} onPress={() => setFilter(value)} style={[styles.tab, filter === value && styles.tabActive]}><Text style={[styles.tabText, filter === value && styles.tabTextActive]}>{value === 'received' ? 'Received' : 'Sent'}</Text></Pressable>)}</View>
          {notice ? <View accessibilityRole="alert" style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View> : null}
          {loading ? <View style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.meta}>Loading invitations…</Text></View> : visible.length ? <View style={styles.list}>{visible.map((item) => <InvitationRow item={item} key={item.id} note={notes[item.id] ?? ''} onNote={(value) => setNotes((current) => ({ ...current, [item.id]: value }))} onRespond={respond} saving={savingId === item.id} />)}</View> : <View style={styles.empty}><FontAwesome6 color={palette.accentDeep} name="calendar-check" size={18} /><Text style={styles.emptyTitle}>Nothing here yet</Text><Text style={styles.emptyBody}>{filter === 'received' ? 'Eligible reviewers can opt in from Public profile settings.' : 'Open an eligible reviewer profile to send a private invitation.'}</Text></View>}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

function InvitationRow({ item, note, onNote, onRespond, saving }: { item: CreatorInvitation; note: string; onNote: (value: string) => void; onRespond: (item: CreatorInvitation, decision: 'accepted' | 'declined') => Promise<void>; saving: boolean }) {
  const pending = item.isRecipient && item.status === 'pending';
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.startsAt));
  return <View style={styles.item}>
    <View style={styles.itemHeader}><View style={styles.itemCopy}><Text style={styles.business}>{item.businessName}</Text><Text style={styles.meta}>{item.isRecipient ? `From ${item.senderName}` : `To ${item.recipientName}`} · {date}</Text></View><View style={[styles.status, item.status === 'accepted' && styles.statusAccepted]}><Text style={[styles.statusText, item.status === 'accepted' && styles.statusAcceptedText]}>{item.status}</Text></View></View>
    <Text style={styles.itemTitle}>{item.title}</Text><Text style={styles.message}>{item.message}</Text>
    <View style={styles.independence}><FontAwesome6 color={palette.success} name="shield" size={9} /><Text style={styles.independenceText}>No review is expected or required.</Text></View>
    {item.responseNote ? <View style={styles.response}><Text style={styles.responseLabel}>Response</Text><Text style={styles.responseText}>{item.responseNote}</Text></View> : null}
    {pending ? <><TextInput accessibilityLabel="Optional private response" maxLength={500} multiline onChangeText={onNote} placeholder="Optional note to the business" placeholderTextColor={palette.mutedLight} style={styles.noteInput} value={note} /><View style={styles.actions}><Pressable accessibilityRole="button" disabled={saving} onPress={() => void onRespond(item, 'declined')} style={styles.decline}><Text style={styles.declineText}>Decline</Text></Pressable><Pressable accessibilityRole="button" disabled={saving} onPress={() => void onRespond(item, 'accepted')} style={styles.accept}>{saving ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}<Text style={styles.acceptText}>Accept invitation</Text></Pressable></View></> : null}
  </View>;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 }, content: { padding: spacing.lg, paddingBottom: 120 }, topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, iconButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: 99, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, topbarTitle: { color: palette.ink, fontSize: 12, fontWeight: '900' }, heading: { gap: 7, marginTop: spacing.xxxl }, eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, fontWeight: '900', letterSpacing: 1 }, title: { color: palette.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1 }, subtitle: { color: palette.muted, fontSize: 10, lineHeight: 16 }, tabs: { borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: 4, marginTop: spacing.xl, paddingBottom: spacing.sm }, tab: { borderRadius: 99, minHeight: 38, paddingHorizontal: 16, justifyContent: 'center' }, tabActive: { backgroundColor: palette.dark }, tabText: { color: palette.muted, fontSize: 9, fontWeight: '900' }, tabTextActive: { color: '#FFFFFF' }, list: { marginTop: spacing.md }, item: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.sm, paddingVertical: spacing.xl }, itemHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm }, itemCopy: { flex: 1, gap: 3 }, business: { color: palette.ink, fontSize: 12, fontWeight: '900' }, meta: { color: palette.muted, fontSize: 8, lineHeight: 13 }, status: { backgroundColor: palette.accentSoft, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5 }, statusAccepted: { backgroundColor: palette.successSoft }, statusText: { color: palette.accentDeep, fontSize: 8, fontWeight: '900', textTransform: 'uppercase' }, statusAcceptedText: { color: palette.success }, itemTitle: { color: palette.ink, fontSize: 16, fontWeight: '900' }, message: { color: palette.ink, fontSize: 11, lineHeight: 18 }, independence: { alignItems: 'center', flexDirection: 'row', gap: 6 }, independenceText: { color: palette.success, fontSize: 8, fontWeight: '800' }, response: { backgroundColor: palette.surface, borderRadius: radii.md, gap: 4, padding: spacing.md }, responseLabel: { color: palette.muted, fontSize: 8, fontWeight: '900', textTransform: 'uppercase' }, responseText: { color: palette.ink, fontSize: 10, lineHeight: 16 }, noteInput: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 10, minHeight: 76, padding: 12, textAlignVertical: 'top' }, actions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' }, decline: { borderColor: palette.line, borderRadius: 99, borderWidth: 1, justifyContent: 'center', minHeight: 42, paddingHorizontal: 16 }, declineText: { color: palette.ink, fontSize: 9, fontWeight: '900' }, accept: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 99, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 42, paddingHorizontal: 17 }, acceptText: { color: '#FFFFFF', fontSize: 9, fontWeight: '900' }, empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: 60 }, emptyTitle: { color: palette.ink, fontSize: 16, fontWeight: '900' }, emptyBody: { color: palette.muted, fontSize: 9, lineHeight: 15, maxWidth: 380, textAlign: 'center' }, loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: 50 }, notice: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginTop: spacing.md, padding: spacing.md }, noticeText: { color: palette.accentDeep, fontSize: 9, lineHeight: 15 }, gate: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl }, gateTitle: { color: palette.ink, fontSize: 22, fontWeight: '900' }, gateBody: { color: palette.muted, fontSize: 10, textAlign: 'center' }, primary: { backgroundColor: palette.accentDeep, borderRadius: 99, justifyContent: 'center', minHeight: 46, paddingHorizontal: spacing.xl }, primaryText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
});
