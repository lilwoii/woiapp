import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import {
  loadPendingPickupSites,
  loadReportedChatMessages,
  moderateReportedChatMessage,
  reviewPendingPickupSite,
  type PendingPickupSite,
  type ReportedChatMessage,
} from '@/lib/marketplace-operations';

type Queue = 'chat' | 'pickup';
type Notice = { tone: 'error' | 'success'; text: string };

export default function MarketplaceModerationScreen() {
  const auth = useAuth();
  const [queue, setQueue] = useState<Queue>('chat');
  const [chats, setChats] = useState<ReportedChatMessage[]>([]);
  const [sites, setSites] = useState<PendingPickupSite[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const canLoad = auth.status === 'authenticated' && auth.securityStatus === 'ready' && auth.mfaEnrolled && auth.assuranceLevel === 'aal2';

  const load = useCallback(async () => {
    if (!canLoad) return;
    setLoading(true); setNotice(null); setSelected(null); setReason(''); setConfirmed(false);
    const result = queue === 'chat' ? await loadReportedChatMessages() : await loadPendingPickupSites();
    setLoading(false);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); return; }
    if (queue === 'chat') setChats(result.data as ReportedChatMessage[]); else setSites(result.data as PendingPickupSite[]);
  }, [canLoad, queue]);

  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  const decideChat = async (item: ReportedChatMessage, visibility: 'visible' | 'held' | 'removed') => {
    if (busy) return; setBusy(true); setNotice(null);
    const result = await moderateReportedChatMessage(item, visibility, reason); setBusy(false);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); return; }
    if (visibility !== 'held') setChats((current) => current.filter((candidate) => candidate.reportId !== item.reportId));
    setSelected(null); setReason(''); setNotice({ tone: 'success', text: visibility === 'removed' ? 'Message removed and reports resolved.' : visibility === 'held' ? 'Message held for continued review.' : 'Report dismissed and message restored.' });
  };

  const decideSite = async (item: PendingPickupSite, state: 'approved' | 'rejected') => {
    if (busy) return; setBusy(true); setNotice(null);
    const result = await reviewPendingPickupSite(item, state, reason, confirmed); setBusy(false);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); return; }
    setSites((current) => current.filter((candidate) => candidate.publicId !== item.publicId)); setSelected(null); setReason(''); setConfirmed(false);
    setNotice({ tone: 'success', text: state === 'approved' ? 'Non-residential pickup site approved.' : 'Pickup site rejected.' });
  };

  const directions = async (site: PendingPickupSite) => {
    const coordinate = `${site.latitude},${site.longitude}`;
    const url = Platform.OS === 'ios' ? `https://maps.apple.com/?daddr=${encodeURIComponent(coordinate)}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coordinate)}`;
    await Linking.openURL(url);
  };

  if (!canLoad) return <FocusAwareScreen><ScrollView contentContainerStyle={styles.content} style={styles.screen}><PageShell narrow><View style={styles.topbar}><BrandMark /></View><View style={styles.gate}><FontAwesome6 color={palette.accentDeep} name="shield-halved" size={24} /><Text accessibilityRole="header" style={styles.gateTitle}>Protected marketplace operations</Text><Text style={styles.copy}>A verified Spottr moderator or administrator account is required. Database roles enforce access to reports and exact pickup details.</Text><Pressable accessibilityRole="button" onPress={() => router.push(auth.status === 'anonymous' ? '/auth' : '/security')} style={styles.primary}><Text style={styles.primaryText}>{auth.status === 'anonymous' ? 'Sign in' : 'Verify security'}</Text></Pressable></View></PageShell></ScrollView></FocusAwareScreen>;

  const count = queue === 'chat' ? chats.length : sites.length;
  return <FocusAwareScreen><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" style={styles.screen}><PageShell narrow>
    <View style={styles.topbar}><BrandMark /><Pressable accessibilityLabel="Close marketplace moderation" accessibilityRole="button" onPress={() => router.back()} style={styles.close}><FontAwesome6 color={palette.ink} name="xmark" size={14} /></Pressable></View>
    <View style={styles.intro}><Text style={styles.eyebrow}>Trust operations</Text><Text accessibilityRole="header" style={styles.title}>Resolve risk with context.</Text><Text style={styles.copy}>Exact pickup locations are restricted and every decision is written to the audit trail.</Text></View>
    <View accessibilityRole="tablist" style={styles.tabs}>{(['chat', 'pickup'] as const).map((tab) => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: queue === tab }} onPress={() => setQueue(tab)} style={[styles.tab, queue === tab && styles.tabActive]}><Text style={[styles.tabText, queue === tab && styles.tabTextActive]}>{tab === 'chat' ? 'Reported chat' : 'Pickup sites'}</Text></Pressable>)}</View>
    {notice ? <View accessibilityLiveRegion="polite" accessibilityRole={notice.tone === 'error' ? 'alert' : undefined} style={[styles.notice, notice.tone === 'success' && styles.noticeGood]}><Text style={[styles.noticeText, notice.tone === 'success' && styles.noticeGoodText]}>{notice.text}</Text></View> : null}
    {loading ? <View style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.copy}>Loading protected queue…</Text></View> : count === 0 ? <View style={styles.empty}><FontAwesome6 color={palette.success} name="circle-check" size={21} /><Text accessibilityRole="header" style={styles.emptyTitle}>Queue clear</Text><Text style={styles.copy}>No {queue === 'chat' ? 'reported messages' : 'pickup sites'} need a decision.</Text></View> : queue === 'chat' ? chats.map((item) => {
      const open = selected === item.reportId;
      return <View key={item.reportId} style={styles.item}><Text style={styles.kicker}>{item.reportReason} · {new Date(item.reportedAt).toLocaleString()}</Text><Text style={styles.itemTitle}>{item.senderName}{item.senderUsername ? ` · @${item.senderUsername}` : ''}</Text><Text style={styles.body}>{item.body}</Text>{item.reportDetail ? <Text style={styles.reportDetail}>Reporter detail: {item.reportDetail}</Text> : null}<Text style={styles.meta}>{item.attachmentCount} private photo{item.attachmentCount === 1 ? '' : 's'} · Current state: {item.visibility}</Text>
        {open ? <Decision reason={reason} setReason={setReason} cancel={() => { setSelected(null); setReason(''); }}><Pressable accessibilityRole="button" disabled={busy} onPress={() => void decideChat(item, 'visible')} style={styles.secondary}><Text style={styles.secondaryText}>Dismiss report</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={() => void decideChat(item, 'held')} style={styles.secondary}><Text style={styles.secondaryText}>Hold</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={() => void decideChat(item, 'removed')} style={styles.danger}><Text style={styles.dangerText}>Remove message</Text></Pressable></Decision> : <ReviewButton onPress={() => setSelected(item.reportId)} />}
      </View>;
    }) : sites.map((site) => {
      const open = selected === site.publicId;
      return <View key={site.publicId} style={styles.item}><Text style={styles.kicker}>{site.kind.replaceAll('_', ' ')} · {new Date(site.submittedAt).toLocaleString()}</Text><Text style={styles.itemTitle}>{site.label}</Text><Text style={styles.body}>{site.addressLine}{site.postalCode ? ` · ${site.postalCode}` : ''}{'\n'}{site.city}, {site.region}</Text><Text style={styles.meta}>{site.latitude.toFixed(6)}, {site.longitude.toFixed(6)} · {site.businessName}</Text><Pressable accessibilityRole="link" onPress={() => void directions(site)} style={styles.direction}><FontAwesome6 color={palette.accentDeep} name="diamond-turn-right" size={12} /><Text style={styles.directionText}>Get directions to inspect</Text></Pressable>
        {open ? <Decision reason={reason} setReason={setReason} cancel={() => { setSelected(null); setReason(''); setConfirmed(false); }}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed((value) => !value)} style={styles.checkRow}><View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>{confirmed ? <FontAwesome6 color="#FFFFFF" name="check" size={10} /> : null}</View><Text style={styles.checkText}>I confirmed this is a non-residential public or commercial place.</Text></Pressable><View style={styles.actionRow}><Pressable accessibilityRole="button" disabled={busy} onPress={() => void decideSite(site, 'rejected')} style={styles.danger}><Text style={styles.dangerText}>Reject</Text></Pressable><Pressable accessibilityRole="button" disabled={busy || !confirmed} onPress={() => void decideSite(site, 'approved')} style={[styles.primary, (!confirmed || busy) && styles.disabled]}><Text style={styles.primaryText}>Approve site</Text></Pressable></View></Decision> : <ReviewButton onPress={() => setSelected(site.publicId)} />}
      </View>;
    })}
  </PageShell></ScrollView></FocusAwareScreen>;
}

function Decision({ reason, setReason, cancel, children }: { reason: string; setReason: (value: string) => void; cancel: () => void; children: React.ReactNode }) { return <View style={styles.decision}><TextInput accessibilityLabel="Internal audit reason" maxLength={1000} multiline onChangeText={setReason} placeholder="Internal reason for the restricted audit log" placeholderTextColor={palette.mutedLight} style={styles.reason} textAlignVertical="top" value={reason} /><View style={styles.actionRow}>{children}</View><Pressable accessibilityRole="button" onPress={cancel} style={styles.cancel}><Text style={styles.cancelText}>Cancel review</Text></Pressable></View>; }
function ReviewButton({ onPress }: { onPress: () => void }) { return <Pressable accessibilityRole="button" onPress={onPress} style={styles.review}><Text style={styles.reviewText}>Review decision</Text><FontAwesome6 color={palette.ink} name="arrow-right" size={10} /></Pressable>; }

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 }, content: { paddingBottom: 88, paddingHorizontal: spacing.lg }, topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: spacing.md }, close: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 }, intro: { gap: spacing.sm, paddingBottom: spacing.xl, paddingTop: 48 }, eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }, title: { color: palette.ink, fontSize: 32, fontWeight: '900', letterSpacing: -1.2, lineHeight: 38 }, copy: { color: palette.muted, fontSize: 13, lineHeight: 20, maxWidth: 620 }, gate: { alignItems: 'flex-start', gap: spacing.md, paddingVertical: 64 }, gateTitle: { color: palette.ink, fontSize: 26, fontWeight: '900' },
  tabs: { borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', marginBottom: spacing.xl }, tab: { minHeight: 48, justifyContent: 'center', marginBottom: -1, paddingHorizontal: spacing.md }, tabActive: { borderBottomColor: palette.accentDeep, borderBottomWidth: 2 }, tabText: { color: palette.muted, fontSize: 11, fontWeight: '800' }, tabTextActive: { color: palette.ink }, notice: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginBottom: spacing.lg, padding: spacing.md }, noticeGood: { backgroundColor: palette.successSoft }, noticeText: { color: palette.accentDeep, fontSize: 12 }, noticeGoodText: { color: palette.success }, loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 120 }, empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: 60 }, emptyTitle: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  item: { borderTopColor: palette.line, borderTopWidth: 1, gap: spacing.sm, paddingVertical: spacing.xl }, kicker: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, letterSpacing: .6, textTransform: 'uppercase' }, itemTitle: { color: palette.ink, fontSize: 17, fontWeight: '900' }, body: { color: palette.ink, fontSize: 14, lineHeight: 22, maxWidth: 680 }, reportDetail: { backgroundColor: palette.warningSoft, color: palette.warning, fontSize: 11, lineHeight: 17, padding: spacing.sm }, meta: { color: palette.mutedLight, fontSize: 10 }, review: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: spacing.sm, minHeight: 44 }, reviewText: { color: palette.ink, fontSize: 11, fontWeight: '900' }, direction: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 8, minHeight: 44 }, directionText: { color: palette.accentDeep, fontSize: 11, fontWeight: '900' },
  decision: { backgroundColor: palette.surface, borderRadius: radii.md, gap: spacing.md, padding: spacing.md }, reason: { borderColor: palette.line, borderRadius: radii.sm, borderWidth: 1, color: palette.ink, fontSize: 13, minHeight: 92, padding: spacing.md }, actionRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, secondary: { alignItems: 'center', borderColor: palette.line, borderRadius: 99, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.md }, secondaryText: { color: palette.ink, fontSize: 11, fontWeight: '800' }, danger: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 99, justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.md }, dangerText: { color: palette.accentDeep, fontSize: 11, fontWeight: '900' }, primary: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 99, justifyContent: 'center', minHeight: 46, paddingHorizontal: spacing.lg }, primaryText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' }, disabled: { opacity: .45 }, cancel: { alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center' }, cancelText: { color: palette.muted, fontSize: 10, fontWeight: '800' }, checkRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, maxWidth: 580, minHeight: 44 }, checkbox: { alignItems: 'center', borderColor: palette.line, borderRadius: 5, borderWidth: 1, height: 22, justifyContent: 'center', width: 22 }, checkboxChecked: { backgroundColor: palette.success, borderColor: palette.success }, checkText: { color: palette.ink, flex: 1, fontSize: 11, lineHeight: 17 },
});
