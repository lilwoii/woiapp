import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import {
  archivePickupSite,
  loadBusinessMarketplace,
  setBusinessMeetingRoutes,
  setBusinessMarketplaceChat,
  setNeighborhoodResidencePickup,
  submitPickupSite,
  type ManagedPickupSite,
  type MarketplaceControls,
  type MeetingPlaceSuggestion,
  type NeighborhoodPickupSettings,
  type PickupSiteDraft,
} from '@/lib/business-marketplace';
import { confirmAction } from '@/lib/platform-dialog';

const blankDraft: PickupSiteDraft = { label: '', kind: 'public_meeting_place', addressLine: '', city: '', region: '', postalCode: '', latitude: '', longitude: '' };
type Notice = { tone: 'error' | 'success'; text: string };

export default function BusinessMarketplaceScreen() {
  const auth = useAuth();
  const params = useLocalSearchParams<{ businessId?: string | string[] }>();
  const businessId = Array.isArray(params.businessId) ? params.businessId[0] ?? '' : params.businessId ?? '';
  const [controls, setControls] = useState<MarketplaceControls | null>(null);
  const [sites, setSites] = useState<ManagedPickupSite[]>([]);
  const [neighborhoodSettings, setNeighborhoodSettings] = useState<NeighborhoodPickupSettings | null>(null);
  const [meetingSuggestions, setMeetingSuggestions] = useState<MeetingPlaceSuggestion[]>([]);
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([]);
  const [draft, setDraft] = useState<PickupSiteDraft>(blankDraft);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const secureSession = auth.status === 'authenticated' && auth.securityStatus === 'ready' && auth.mfaEnrolled && auth.assuranceLevel === 'aal2';

  const load = useCallback(async () => {
    if (!secureSession || !businessId) return;
    setLoading(true); setNotice(null);
    const result = await loadBusinessMarketplace(businessId);
    setLoading(false);
    if (!result.ok) { setControls(null); setSites([]); setMeetingSuggestions([]); setNotice({ tone: 'error', text: result.reason }); return; }
    setControls(result.data.controls); setSites(result.data.sites);
    setNeighborhoodSettings(result.data.neighborhoodSettings);
    setMeetingSuggestions(result.data.meetingSuggestions);
    setSelectedRoutes(result.data.meetingSuggestions.filter((entry) => entry.selectedOrdinal !== null).sort((a, b) => (a.selectedOrdinal ?? 9) - (b.selectedOrdinal ?? 9)).map((entry) => entry.publicId));
  }, [businessId, secureSession]);

  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  const update = <K extends keyof PickupSiteDraft>(key: K, value: PickupSiteDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const toggleChat = async (enabled: boolean) => {
    if (!controls || busy) return;
    setBusy('chat'); setNotice(null);
    const result = await setBusinessMarketplaceChat(controls.businessId, enabled);
    setBusy(null);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); return; }
    setControls({ ...controls, chatEnabled: result.data });
    setNotice({ tone: 'success', text: result.data ? 'Customer chat is available.' : 'Customer chat is paused for this pop-up.' });
  };

  const fillCurrentCoordinates = async () => {
    if (busy) return;
    setBusy('location'); setNotice(null);
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) { setBusy(null); setNotice({ tone: 'error', text: 'Allow foreground location access to fill coordinates. You can enter them manually instead.' }); return; }
    try {
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setDraft((value) => ({ ...value, latitude: current.coords.latitude.toFixed(6), longitude: current.coords.longitude.toFixed(6) }));
    } catch { setNotice({ tone: 'error', text: 'A precise position could not be read. Enter coordinates manually.' }); }
    setBusy(null);
  };

  const submit = async () => {
    if (!controls || busy) return;
    setBusy('submit'); setNotice(null);
    const result = await submitPickupSite(controls.businessId, draft);
    setBusy(null);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); return; }
    setDraft(blankDraft); setNotice({ tone: 'success', text: 'Pickup site submitted for safety review. Its exact address remains private.' }); await load();
  };

  const archive = async (site: ManagedPickupSite) => {
    if (busy || !(await confirmAction({ title: 'Archive pickup site?', message: 'This removes the site from future pickup choices and destroys any active exact-location disclosure tied to it.', confirmLabel: 'Archive site', destructive: true }))) return;
    setBusy(site.publicId); setNotice(null);
    const result = await archivePickupSite(site); setBusy(null);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); if (result.code === 'CONFLICT') await load(); return; }
    setSites((current) => current.filter((candidate) => candidate.publicId !== site.publicId));
    setNotice({ tone: 'success', text: 'Pickup site archived and active exact-location disclosures destroyed.' });
  };

  const toggleRoute = (publicId: string) => setSelectedRoutes((current) => current.includes(publicId)
    ? current.filter((id) => id !== publicId)
    : current.length < 3 ? [...current, publicId] : current);

  const saveRoutes = async () => {
    if (!controls || busy) return;
    setBusy('routes'); setNotice(null);
    const result = await setBusinessMeetingRoutes(controls.businessId, selectedRoutes);
    setBusy(null);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); return; }
    setNotice({ tone: 'success', text: `${result.data} public meetup routes saved. Customers see these places without seeing distance from your service location.` });
    await load();
  };

  const toggleResidence = async (enabled: boolean) => {
    if (!controls || !neighborhoodSettings || busy) return;
    if (enabled && !(await confirmAction({
      title: 'Enable residence pickup?',
      message: 'Public shopping centers are recommended. Your address stays out of the listing and chat, but a customer who accepts the caution can receive it in an expiring pickup card after you confirm that request. You are responsible for local law, personal safety, and site suitability.',
      confirmLabel: 'Enable carefully',
    }))) return;
    setBusy('residence'); setNotice(null);
    const result = await setNeighborhoodResidencePickup(controls.businessId, enabled);
    setBusy(null);
    if (!result.ok) { setNotice({ tone: 'error', text: result.reason }); return; }
    setNeighborhoodSettings({ ...neighborhoodSettings, residencePickupEnabled: result.data });
    setNotice({ tone: 'success', text: result.data ? 'Residence pickup is available as the last, caution-marked choice.' : 'Residence pickup disabled. Active residence details were revoked.' });
  };

  if (!secureSession) return (
    <FocusAwareScreen><ScrollView contentContainerStyle={styles.content} style={styles.screen}><PageShell narrow>
      <View style={styles.topbar}><BrandMark /></View><View style={styles.gate}><FontAwesome6 color={palette.accentDeep} name="shield-halved" size={24} />
        <Text accessibilityRole="header" style={styles.gateTitle}>Private pickup controls</Text><Text style={styles.copy}>Sign in as an owner or manager and verify a current authenticator code before viewing exact pickup details.</Text>
        <Pressable accessibilityRole="button" onPress={() => router.push(auth.status === 'anonymous' ? '/auth' : '/security')} style={styles.primary}><Text style={styles.primaryText}>{auth.status === 'anonymous' ? 'Sign in' : 'Verify security'}</Text></Pressable>
      </View></PageShell></ScrollView></FocusAwareScreen>
  );

  return (
    <FocusAwareScreen><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" style={styles.screen}><PageShell narrow>
      <View style={styles.topbar}><BrandMark /><Pressable accessibilityLabel="Close marketplace controls" accessibilityRole="button" onPress={() => router.back()} style={styles.close}><FontAwesome6 color={palette.ink} name="xmark" size={14} /></Pressable></View>
      <View style={styles.intro}><Text style={styles.eyebrow}>Pickup preferences</Text><Text accessibilityRole="header" style={styles.title}>Clear choices. Private details.</Text><Text style={styles.copy}>Neighborhood Kitchen never publishes a home address. Choose fixed public meetup routes; residence pickup stays optional and caution-marked.</Text></View>
      {notice ? <View accessibilityLiveRegion="polite" accessibilityRole={notice.tone === 'error' ? 'alert' : undefined} style={[styles.notice, notice.tone === 'success' && styles.noticeGood]}><Text style={[styles.noticeText, notice.tone === 'success' && styles.noticeGoodText]}>{notice.text}</Text></View> : null}
      {loading ? <View style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.copy}>Loading protected controls…</Text></View> : controls ? <>
        <View style={styles.section}><View style={styles.sectionHeading}><View style={styles.headingCopy}><Text style={styles.kicker}>01 · Customer contact</Text><Text style={styles.sectionTitle}>{controls.businessName}</Text><Text style={styles.copy}>{controls.chatRequired ? 'Private chat is required for Neighborhood Kitchen listings.' : 'Choose whether customers can start private chat with this pop-up.'}</Text></View><Switch accessibilityLabel="Customer chat enabled" disabled={!controls.canToggleChat || busy === 'chat'} onValueChange={(value) => void toggleChat(value)} trackColor={{ false: palette.line, true: palette.mint }} thumbColor={controls.chatEnabled ? palette.success : palette.mutedLight} value={controls.chatEnabled} /></View>
          <View style={styles.statusLine}><View style={[styles.dot, controls.chatEnabled && styles.dotGood]} /><Text style={styles.statusText}>{controls.chatEnabled ? 'Chat available' : 'Chat paused'}</Text></View>
        </View>
        {controls.businessKind === 'home_kitchen' ? <>
          <View style={styles.section}><Text style={styles.kicker}>02 · Public routes</Text><Text style={styles.sectionTitle}>Choose 2–3 meetup places</Text><Text style={styles.copy}>Suggestions come from a licensed, current place feed near your private service location. Customers see public addresses, never their distance or direction from you.</Text>
            {!meetingSuggestions.length ? <Text style={styles.empty}>No current provider-sourced shopping centers are available nearby. Public meetup selection stays unavailable until the feed is populated.</Text> : meetingSuggestions.map((place) => { const selected = selectedRoutes.includes(place.publicId); return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: !selected && selectedRoutes.length >= 3 }} disabled={!selected && selectedRoutes.length >= 3} key={place.publicId} onPress={() => toggleRoute(place.publicId)} style={[styles.site, selected && styles.siteSelected]}><View style={styles.siteTop}><View style={styles.headingCopy}><Text style={styles.siteTitle}>{place.label}</Text><Text style={styles.address}>{place.addressLine} · {place.city}, {place.region} {place.postalCode ?? ''}</Text><Text style={styles.coordinates}>{place.distanceMeters < 1000 ? `${Math.round(place.distanceMeters)} m` : `${(place.distanceMeters / 1000).toFixed(1)} km`} from your private service pin · seller view only</Text></View><FontAwesome6 color={selected ? palette.success : palette.mutedLight} name={selected ? 'circle-check' : 'circle'} size={16} /></View></Pressable>; })}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: selectedRoutes.length < 2 || Boolean(busy) }} disabled={selectedRoutes.length < 2 || Boolean(busy)} onPress={() => void saveRoutes()} style={[styles.primary, (selectedRoutes.length < 2 || Boolean(busy)) && styles.disabled]}>{busy === 'routes' ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}<Text style={styles.primaryText}>Save {selectedRoutes.length} routes</Text></Pressable>
          </View>
          <View style={styles.section}><View style={styles.sectionHeading}><View style={styles.headingCopy}><Text style={styles.kicker}>03 · Optional residence</Text><Text style={styles.sectionTitle}>Residence pickup</Text><Text style={styles.copy}>Public centers are recommended. If enabled, your address appears only in an expiring card after the customer accepts a caution and you confirm that request.</Text></View><Switch accessibilityLabel="Residence pickup enabled" disabled={!neighborhoodSettings?.serviceLocationReady || Boolean(busy)} onValueChange={(value) => void toggleResidence(value)} trackColor={{ false: palette.line, true: palette.warningSoft }} thumbColor={neighborhoodSettings?.residencePickupEnabled ? palette.warning : palette.mutedLight} value={neighborhoodSettings?.residencePickupEnabled ?? false} /></View>
            {!neighborhoodSettings?.serviceLocationReady ? <Text style={styles.empty}>Complete the private primary service address before residence pickup can be enabled.</Text> : <Text style={styles.statusText}>{neighborhoodSettings.residencePickupEnabled ? 'Enabled as the final, caution-marked customer choice.' : 'Off by default.'}</Text>}
          </View>
        </> : <>
        <View style={styles.section}><Text style={styles.kicker}>02 · Approved places</Text><Text style={styles.sectionTitle}>Pickup sites</Text><Text style={styles.copy}>Only public meeting places and commercial sites are allowed. Exact details below are visible only to verified owners, managers, and authorized reviewers.</Text>
          {!sites.length ? <Text style={styles.empty}>No pickup sites submitted yet.</Text> : sites.map((site) => <View key={site.publicId} style={styles.site}><View style={styles.siteTop}><View style={styles.headingCopy}><Text style={styles.siteTitle}>{site.label}</Text><Text style={styles.address}>{site.addressLine} · {site.city}, {site.region} {site.postalCode ?? ''}</Text></View><Text style={[styles.badge, site.state === 'approved' && styles.badgeGood]}>{site.state}</Text></View><Text style={styles.coordinates}>{site.latitude.toFixed(5)}, {site.longitude.toFixed(5)}</Text><Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => void archive(site)} style={styles.textButton}>{busy === site.publicId ? <ActivityIndicator color={palette.accentDeep} size="small" /> : null}<Text style={styles.textButtonLabel}>Archive safely</Text></Pressable></View>)}
        </View>
        <View style={styles.section}><Text style={styles.kicker}>03 · Submit a place</Text><Text style={styles.sectionTitle}>Add a safe handoff point</Text><Text style={styles.copy}>Do not enter a residence. Spottr staff must confirm the location is non-residential before it can be offered in chat.</Text>
          <View style={styles.choiceRow}>{(['public_meeting_place', 'commercial_site'] as const).map((kind) => <Pressable key={kind} accessibilityRole="radio" accessibilityState={{ checked: draft.kind === kind }} onPress={() => update('kind', kind)} style={[styles.choice, draft.kind === kind && styles.choiceActive]}><Text style={[styles.choiceText, draft.kind === kind && styles.choiceTextActive]}>{kind === 'public_meeting_place' ? 'Public meeting place' : 'Commercial site'}</Text></Pressable>)}</View>
          <Field label="Public label" value={draft.label} onChangeText={(value) => update('label', value)} placeholder="Central Market entrance" maxLength={120} />
          <Field label="Exact street address · private" value={draft.addressLine} onChangeText={(value) => update('addressLine', value)} placeholder="123 Market Street" maxLength={300} />
          <View style={styles.fieldRow}><View style={styles.flex}><Field label="City" value={draft.city} onChangeText={(value) => update('city', value)} placeholder="Austin" maxLength={120} /></View><View style={styles.flex}><Field label="State / region" value={draft.region} onChangeText={(value) => update('region', value)} placeholder="TX" maxLength={80} /></View></View>
          <Field label="Postal code" value={draft.postalCode} onChangeText={(value) => update('postalCode', value)} placeholder="78701" maxLength={24} />
          <View style={styles.fieldRow}><View style={styles.flex}><Field label="Latitude" value={draft.latitude} onChangeText={(value) => update('latitude', value)} placeholder="30.267200" keyboardType="numbers-and-punctuation" /></View><View style={styles.flex}><Field label="Longitude" value={draft.longitude} onChangeText={(value) => update('longitude', value)} placeholder="-97.743100" keyboardType="numbers-and-punctuation" /></View></View>
          <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={() => void fillCurrentCoordinates()} style={styles.secondary}><FontAwesome6 color={palette.ink} name="location-crosshairs" size={13} /><Text style={styles.secondaryText}>{busy === 'location' ? 'Reading location…' : 'Use my current coordinates'}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ busy: busy === 'submit', disabled: Boolean(busy) }} disabled={Boolean(busy)} onPress={() => void submit()} style={[styles.primary, Boolean(busy) && styles.disabled]}>{busy === 'submit' ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}<Text style={styles.primaryText}>Submit for safety review</Text></Pressable>
        </View>
        </>}
      </> : null}
    </PageShell></ScrollView></FocusAwareScreen>
  );
}

function Field(props: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; maxLength?: number; keyboardType?: 'default' | 'numbers-and-punctuation' }) {
  return <View style={styles.field}><Text style={styles.label}>{props.label}</Text><TextInput accessibilityLabel={props.label} autoCapitalize="words" keyboardType={props.keyboardType} maxLength={props.maxLength} onChangeText={props.onChangeText} placeholder={props.placeholder} placeholderTextColor={palette.mutedLight} style={styles.input} value={props.value} /></View>;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 }, content: { paddingBottom: 88, paddingHorizontal: spacing.lg }, topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: spacing.md }, close: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
  intro: { gap: spacing.sm, paddingBottom: spacing.xl, paddingTop: 48 }, eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }, title: { color: palette.ink, fontSize: 32, fontWeight: '900', letterSpacing: -1.2, lineHeight: 38 }, copy: { color: palette.muted, fontSize: 13, lineHeight: 20, maxWidth: 620 },
  notice: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginBottom: spacing.lg, padding: spacing.md }, noticeGood: { backgroundColor: palette.successSoft }, noticeText: { color: palette.accentDeep, fontSize: 12, lineHeight: 18 }, noticeGoodText: { color: palette.success }, loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: 48 }, gate: { alignItems: 'flex-start', gap: spacing.md, paddingVertical: 64 }, gateTitle: { color: palette.ink, fontSize: 26, fontWeight: '900' },
  section: { borderTopColor: palette.line, borderTopWidth: 1, gap: spacing.md, paddingVertical: spacing.xxl }, sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.lg, justifyContent: 'space-between' }, headingCopy: { flex: 1, gap: 5 }, kicker: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, letterSpacing: .8, textTransform: 'uppercase' }, sectionTitle: { color: palette.ink, fontSize: 21, fontWeight: '900', letterSpacing: -.4 },
  statusLine: { alignItems: 'center', flexDirection: 'row', gap: 8 }, dot: { backgroundColor: palette.mutedLight, borderRadius: 99, height: 7, width: 7 }, dotGood: { backgroundColor: palette.success }, statusText: { color: palette.muted, fontSize: 11, fontWeight: '700' }, empty: { color: palette.muted, fontSize: 12, paddingVertical: spacing.lg },
  site: { borderTopColor: palette.line, borderTopWidth: 1, gap: 8, paddingVertical: spacing.lg }, siteTop: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' }, siteTitle: { color: palette.ink, fontSize: 15, fontWeight: '900' }, address: { color: palette.muted, fontSize: 12, lineHeight: 18 }, coordinates: { color: palette.mutedLight, fontFamily: 'SpaceMono', fontSize: 9 }, badge: { backgroundColor: palette.warningSoft, borderRadius: 99, color: palette.warning, fontSize: 9, fontWeight: '900', overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 6, textTransform: 'uppercase' }, badgeGood: { backgroundColor: palette.successSoft, color: palette.success },
  siteSelected: { backgroundColor: palette.successSoft, borderRadius: radii.md, borderTopColor: palette.successSoft, paddingHorizontal: spacing.md },
  textButton: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 7, minHeight: 44 }, textButtonLabel: { color: palette.accentDeep, fontSize: 11, fontWeight: '900' }, choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, choice: { borderColor: palette.line, borderRadius: 99, borderWidth: 1, minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md }, choiceActive: { backgroundColor: palette.ink, borderColor: palette.ink }, choiceText: { color: palette.ink, fontSize: 11, fontWeight: '800' }, choiceTextActive: { color: palette.surface },
  field: { gap: 7 }, label: { color: palette.ink, fontSize: 11, fontWeight: '800' }, input: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.sm, borderWidth: 1, color: palette.ink, fontSize: 14, minHeight: 48, paddingHorizontal: spacing.md }, fieldRow: { flexDirection: 'row', gap: spacing.sm }, flex: { flex: 1 }, primary: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: palette.accentDeep, borderRadius: 99, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 48, paddingHorizontal: spacing.xl }, primaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' }, secondary: { alignItems: 'center', alignSelf: 'flex-start', borderColor: palette.line, borderRadius: 99, borderWidth: 1, flexDirection: 'row', gap: 8, minHeight: 44, paddingHorizontal: spacing.md }, secondaryText: { color: palette.ink, fontSize: 11, fontWeight: '800' }, disabled: { opacity: .55 },
});
