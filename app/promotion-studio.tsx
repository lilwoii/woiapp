import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { createMarketplaceIdempotencyKey } from '@/lib/marketplace-api';
import {
  createSponsoredCampaignDraft,
  endSponsoredCampaign,
  loadSponsoredCampaignQuote,
  loadSponsoredCampaigns,
  submitSponsoredCampaign,
} from '@/lib/sponsorship';
import type { SponsoredCampaign, SponsoredCampaignQuote } from '@/types/sponsorship';

const radiusOptions = [5, 10, 25, 50] as const;

function defaultStartDate() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function money(minor: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(minor / 100);
}

export default function PromotionStudioScreen() {
  const auth = useAuth();
  const { managedPlaceIds, places } = useMarketplaceStore();
  const businesses = useMemo(() => places.filter((place) => managedPlaceIds.includes(place.id) && place.verified), [managedPlaceIds, places]);
  const accountId = auth.status === 'authenticated' ? auth.account?.id : undefined;
  const [businessId, setBusinessId] = useState('');
  const selectedBusinessId = businessId || businesses[0]?.id || '';
  const [campaigns, setCampaigns] = useState<SponsoredCampaign[]>([]);
  const [quoteState, setQuoteState] = useState<{ businessId: string; value: SponsoredCampaignQuote | null } | null>(null);
  const quote = quoteState?.businessId === selectedBusinessId ? quoteState.value : null;
  const [budget, setBudget] = useState('150');
  const [radiusMiles, setRadiusMiles] = useState<(typeof radiusOptions)[number]>(10);
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const result = await loadSponsoredCampaigns(businesses.map((business) => business.id), accountId);
    setLoading(false);
    if (!result.ok || !result.data) setNotice({ tone: 'error', text: result.ok ? 'Campaigns are unavailable.' : result.reason });
    else setCampaigns(result.data);
  }, [accountId, businesses]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    let active = true;
    if (!accountId || !selectedBusinessId || Platform.OS !== 'web') {
      return () => { active = false; };
    }
    const timer = setTimeout(() => {
      void loadSponsoredCampaignQuote(selectedBusinessId, accountId).then((result) => {
        if (!active) return;
        if (result.ok) setQuoteState({ businessId: selectedBusinessId, value: result.data ?? null });
        else setNotice({ tone: 'error', text: result.reason });
      });
    }, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [accountId, selectedBusinessId]);

  const createDraft = async () => {
    if (!accountId || !selectedBusinessId || !quote || saving) return;
    const dollars = Number(budget);
    const budgetMinor = Math.round(dollars * 100);
    const starts = new Date(`${startDate}T12:00:00`);
    if (!Number.isFinite(dollars) || budgetMinor < quote.minimumMonthlyMinor || budgetMinor > quote.maximumMonthlyMinor || !Number.isFinite(starts.getTime())) {
      setNotice({ tone: 'error', text: `Enter a 30-day budget from ${money(quote.minimumMonthlyMinor)} to ${money(quote.maximumMonthlyMinor)} and a valid start date.` });
      return;
    }
    const fingerprint = [selectedBusinessId, budgetMinor, radiusMiles, starts.toISOString()].join('\u0000');
    const key = attempt.current?.fingerprint === fingerprint ? attempt.current.key : createMarketplaceIdempotencyKey('sponsor');
    attempt.current = { fingerprint, key };
    setSaving('create');
    setNotice(null);
    const result = await createSponsoredCampaignDraft({
      businessId: selectedBusinessId,
      monthlyBudgetMinor: budgetMinor,
      radiusMeters: Math.min(80467, Math.round(radiusMiles * 1609.344)),
      startsAt: starts.toISOString(),
      idempotencyKey: key,
    }, accountId);
    setSaving(null);
    setNotice({ tone: result.ok ? 'success' : 'error', text: result.ok ? 'Campaign draft created. Review it below before submitting.' : result.reason });
    if (result.ok) { attempt.current = null; await load(); }
  };

  const transition = async (campaign: SponsoredCampaign, action: 'submit' | 'end') => {
    if (!accountId || saving) return;
    setSaving(campaign.id);
    const result = action === 'submit'
      ? await submitSponsoredCampaign(campaign, accountId)
      : await endSponsoredCampaign(campaign, accountId);
    setSaving(null);
    setNotice({ tone: result.ok ? 'success' : 'error', text: result.ok ? (action === 'submit' ? 'Campaign submitted for billing and safety review.' : 'Campaign ended.') : result.reason });
    if (result.ok) await load();
  };

  if (auth.status !== 'authenticated' || auth.assuranceLevel !== 'aal2') {
    return <FocusAwareScreen><View role="main" style={styles.gate}><FontAwesome6 color={palette.accentDeep} name="bullhorn" size={22} /><Text accessibilityRole="header" style={styles.gateTitle}>Promotion Studio</Text><Text style={styles.gateBody}>Sign in and verify your authenticator to manage sponsored campaigns.</Text><Pressable accessibilityRole="button" onPress={() => router.replace(auth.status === 'authenticated' ? '/security' : '/auth')} style={styles.primary}><Text style={styles.primaryText}>{auth.status === 'authenticated' ? 'Verify security' : 'Sign in'}</Text></Pressable></View></FocusAwareScreen>;
  }

  const visibleCampaigns = campaigns.filter((campaign) => campaign.businessId === selectedBusinessId);
  return <FocusAwareScreen><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" style={styles.screen}><PageShell narrow>
    <View style={styles.topbar}><Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}><FontAwesome6 color={palette.ink} name="arrow-left" size={12} /></Pressable><Text style={styles.topbarTitle}>Promotion Studio</Text><View style={styles.spacer} /></View>
    <View style={styles.heading}><Text style={styles.eyebrow}>PAID, NEVER ORGANIC</Text><Text accessibilityRole="header" style={styles.title}>Reach nearby diners.</Text><Text style={styles.subtitle}>Sponsored placements live in a separate, clearly labelled lane. Payment never changes organic search, ratings, reviews, or badges.</Text></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false}><View accessibilityLabel="Campaign business" accessibilityRole="radiogroup" style={styles.businesses}>{businesses.map((business) => <Pressable accessibilityRole="radio" aria-checked={business.id === selectedBusinessId} accessibilityState={{ checked: business.id === selectedBusinessId }} key={business.id} onPress={() => setBusinessId(business.id)} style={[styles.choice, business.id === selectedBusinessId && styles.choiceActive]}><Text style={[styles.choiceText, business.id === selectedBusinessId && styles.choiceTextActive]}>{business.name}</Text></Pressable>)}</View></ScrollView>
    {!businesses.length ? <View accessibilityRole="alert" style={styles.notice}><Text style={styles.noticeError}>A verified, publicly visible business is required.</Text></View> : null}
    {Platform.OS === 'web' && quote ? <View style={styles.composer}>
      <View style={styles.quoteLine}><View><Text style={styles.sectionTitle}>30-day discovery campaign</Text><Text style={styles.meta}>Server-approved pricing · billed only after activation</Text></View><Text style={styles.minimum}>From {money(quote.minimumMonthlyMinor)}</Text></View>
      <View style={styles.fields}><View style={styles.field}><Text style={styles.label}>Budget (USD)</Text><TextInput accessibilityLabel="30-day campaign budget in US dollars" keyboardType="decimal-pad" onChangeText={setBudget} style={styles.input} value={budget} /></View><View style={styles.field}><Text style={styles.label}>Start date</Text><TextInput accessibilityLabel="Campaign start date YYYY-MM-DD" autoCapitalize="none" onChangeText={setStartDate} placeholder="YYYY-MM-DD" style={styles.input} value={startDate} /></View></View>
      <Text style={styles.label}>Reach around your verified location</Text><View accessibilityLabel="Campaign radius" accessibilityRole="radiogroup" style={styles.radiusRow}>{radiusOptions.map((radius) => <Pressable accessibilityRole="radio" aria-checked={radiusMiles === radius} accessibilityState={{ checked: radiusMiles === radius }} key={radius} onPress={() => setRadiusMiles(radius)} style={[styles.radius, radiusMiles === radius && styles.radiusActive]}><Text style={[styles.radiusText, radiusMiles === radius && styles.radiusTextActive]}>{radius} mi</Text></Pressable>)}</View>
      <View style={styles.disclosure}><FontAwesome6 color={palette.accentDeep} name="rectangle-ad" size={12} /><Text style={styles.disclosureText}>Every placement says “{quote.disclosure}.” Submitting does not charge you. Activation remains off until billing, safety, and finance checks pass.</Text></View>
      <Pressable accessibilityRole="button" accessibilityState={{ busy: saving === 'create', disabled: Boolean(saving) }} disabled={Boolean(saving)} onPress={() => void createDraft()} style={[styles.primary, Boolean(saving) && styles.disabled]}>{saving === 'create' ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Create campaign draft</Text>}</Pressable>
    </View> : Platform.OS === 'web' && selectedBusinessId ? <View style={styles.unavailable}><Text style={styles.sectionTitle}>Pricing is not available for this location yet.</Text><Text style={styles.meta}>Spottr fails closed until an approved regional pricing version and eligible public business location exist.</Text></View> : <View style={styles.unavailable}><Text style={styles.sectionTitle}>Campaign status only</Text><Text style={styles.meta}>Native apps show active campaign reporting and controls only through approved merchant channels.</Text></View>}
    {notice ? <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.notice, notice.tone === 'success' && styles.noticeSuccess]}><Text style={notice.tone === 'success' ? styles.noticeSuccessText : styles.noticeError}>{notice.text}</Text></View> : null}
    <View style={styles.campaignSection}><Text style={styles.sectionTitle}>Campaigns</Text>{loading ? <ActivityIndicator color={palette.accentDeep} /> : visibleCampaigns.length ? visibleCampaigns.map((campaign) => <CampaignRow campaign={campaign} key={campaign.id} onTransition={transition} saving={saving === campaign.id} />) : <View style={styles.empty}><Text style={styles.emptyTitle}>No campaigns yet</Text><Text style={styles.meta}>Drafts and approved campaigns will appear here with separate sponsored performance.</Text></View>}</View>
  </PageShell></ScrollView></FocusAwareScreen>;
}

function CampaignRow({ campaign, onTransition, saving }: { campaign: SponsoredCampaign; onTransition: (campaign: SponsoredCampaign, action: 'submit' | 'end') => Promise<void>; saving: boolean }) {
  const canEnd = ['draft', 'submitted', 'active', 'paused'].includes(campaign.state);
  return <View style={styles.campaign}>
    <View style={styles.campaignTop}><View><Text style={styles.campaignTitle}>{money(campaign.lifetimeBudgetMinor)} · 30 days</Text><Text style={styles.meta}>{new Date(campaign.startsAt).toLocaleDateString()}–{new Date(campaign.endsAt).toLocaleDateString()}</Text></View><View style={[styles.status, campaign.state === 'active' && styles.statusActive]}><Text style={[styles.statusText, campaign.state === 'active' && styles.statusActiveText]}>{campaign.state}</Text></View></View>
    <View style={styles.metrics}><Metric label="Impressions" value={campaign.impressions} /><Metric label="Opens" value={campaign.opens} /><Metric label="Directions" value={campaign.directions} /><Metric label="Menu views" value={campaign.menuViews} /></View>
    <Text style={styles.spend}>Sponsored spend {money(Math.max(0, campaign.billedMinor - campaign.creditedMinor))} · organic rank unaffected</Text>
    {campaign.state === 'draft' || canEnd ? <View style={styles.actions}>{campaign.state === 'draft' ? <Pressable accessibilityRole="button" disabled={saving} onPress={() => void onTransition(campaign, 'submit')} style={styles.submit}><Text style={styles.submitText}>Submit for review</Text></Pressable> : null}{canEnd ? <Pressable accessibilityRole="button" disabled={saving} onPress={() => void onTransition(campaign, 'end')} style={styles.end}><Text style={styles.endText}>End</Text></Pressable> : null}</View> : null}
  </View>;
}

function Metric({ label, value }: { label: string; value: number }) { return <View style={styles.metric}><Text style={styles.metricValue}>{value.toLocaleString()}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 }, content: { padding: spacing.lg, paddingBottom: 120 }, topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, iconButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: 99, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, topbarTitle: { color: palette.ink, fontSize: 12, fontWeight: '900' }, spacer: { width: 42 }, heading: { gap: 7, marginVertical: spacing.xxxl }, eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, fontWeight: '900', letterSpacing: 1 }, title: { color: palette.ink, fontSize: 31, fontWeight: '900', letterSpacing: -1 }, subtitle: { color: palette.muted, fontSize: 10, lineHeight: 17, maxWidth: 620 }, businesses: { flexDirection: 'row', gap: spacing.sm }, choice: { borderColor: palette.line, borderRadius: 99, borderWidth: 1, justifyContent: 'center', minHeight: 40, paddingHorizontal: 15 }, choiceActive: { backgroundColor: palette.dark, borderColor: palette.dark }, choiceText: { color: palette.ink, fontSize: 9, fontWeight: '900' }, choiceTextActive: { color: '#FFFFFF' }, composer: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.md, paddingVertical: spacing.xxl }, quoteLine: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' }, sectionTitle: { color: palette.ink, fontSize: 16, fontWeight: '900' }, minimum: { color: palette.accentDeep, fontSize: 13, fontWeight: '900' }, meta: { color: palette.muted, fontSize: 9, lineHeight: 15 }, fields: { flexDirection: 'row', gap: spacing.md }, field: { flex: 1 }, label: { color: palette.ink, fontSize: 9, fontWeight: '900', marginBottom: 6 }, input: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 11, minHeight: 46, padding: 12 }, radiusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, radius: { borderColor: palette.line, borderRadius: 99, borderWidth: 1, justifyContent: 'center', minHeight: 40, paddingHorizontal: 15 }, radiusActive: { backgroundColor: palette.accentSoft, borderColor: palette.accentDeep }, radiusText: { color: palette.muted, fontSize: 9, fontWeight: '900' }, radiusTextActive: { color: palette.accentDeep }, disclosure: { alignItems: 'flex-start', backgroundColor: palette.surface, borderRadius: radii.md, flexDirection: 'row', gap: spacing.sm, padding: spacing.md }, disclosureText: { color: palette.muted, flex: 1, fontSize: 9, lineHeight: 15 }, primary: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 99, justifyContent: 'center', minHeight: 50, paddingHorizontal: spacing.xl }, primaryText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' }, disabled: { opacity: 0.5 }, unavailable: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: 5, paddingVertical: spacing.xxl }, campaignSection: { gap: spacing.md, paddingTop: spacing.xxl }, campaign: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.md, paddingVertical: spacing.lg }, campaignTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, campaignTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' }, status: { backgroundColor: palette.accentSoft, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5 }, statusActive: { backgroundColor: palette.successSoft }, statusText: { color: palette.accentDeep, fontSize: 8, fontWeight: '900', textTransform: 'uppercase' }, statusActiveText: { color: palette.success }, metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg }, metric: { minWidth: 72 }, metricValue: { color: palette.ink, fontSize: 15, fontWeight: '900' }, metricLabel: { color: palette.muted, fontSize: 8 }, spend: { color: palette.muted, fontSize: 8 }, actions: { flexDirection: 'row', gap: spacing.sm }, submit: { backgroundColor: palette.ink, borderRadius: 99, justifyContent: 'center', minHeight: 42, paddingHorizontal: 16 }, submitText: { color: '#FFFFFF', fontSize: 9, fontWeight: '900' }, end: { borderColor: palette.line, borderRadius: 99, borderWidth: 1, justifyContent: 'center', minHeight: 42, paddingHorizontal: 16 }, endText: { color: palette.ink, fontSize: 9, fontWeight: '900' }, empty: { gap: 5, paddingVertical: spacing.xl }, emptyTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' }, notice: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginTop: spacing.md, padding: spacing.md }, noticeSuccess: { backgroundColor: palette.successSoft }, noticeError: { color: palette.accentDeep, fontSize: 9, lineHeight: 15 }, noticeSuccessText: { color: palette.success, fontSize: 9, fontWeight: '800' }, gate: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl }, gateTitle: { color: palette.ink, fontSize: 22, fontWeight: '900' }, gateBody: { color: palette.muted, fontSize: 10, lineHeight: 16, maxWidth: 420, textAlign: 'center' },
});
