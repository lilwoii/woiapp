import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  approveBusinessSubmission,
  loadPendingBusinessSubmissions,
  loadPendingMobileSubmission,
  returnBusinessSubmission,
  validateMobileReviewSelection,
  type PendingBusinessSubmission,
  type PendingMobileSubmission,
} from '@/lib/business-submission-moderation';

type Notice = { tone: 'error' | 'success'; text: string };

const kindLabels: Record<PendingBusinessSubmission['kind'], string> = {
  food_truck: 'Food truck',
  restaurant: 'Restaurant',
  pop_up: 'Pop-up',
  cafe_bakery: 'Café & bakery',
  home_kitchen: 'Neighborhood kitchen',
};

export default function BusinessSubmissionModerationScreen() {
  const auth = useAuth();
  const workspaceKey = auth.status === 'authenticated'
    ? `${auth.account?.id ?? 'missing'}:${auth.securityStatus}:${auth.assuranceLevel}:${auth.mfaEnrolled}`
    : auth.status;
  return <BusinessSubmissionWorkspace key={workspaceKey} />;
}

function BusinessSubmissionWorkspace() {
  const auth = useAuth();
  const accountId = auth.status === 'authenticated' ? auth.account?.id : undefined;
  const [items, setItems] = useState<PendingBusinessSubmission[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<PendingBusinessSubmission | null>(null);
  const [mobileDetail, setMobileDetail] = useState<PendingMobileSubmission | null>(null);
  const [approvedLocationIds, setApprovedLocationIds] = useState<string[]>([]);
  const [approvedStopIds, setApprovedStopIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'return' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const queueGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const decisionGeneration = useRef(0);
  const mounted = useRef(true);

  const canLoad =
    auth.status === 'authenticated' &&
    Boolean(accountId) &&
    auth.securityStatus === 'ready' &&
    auth.mfaEnrolled &&
    auth.assuranceLevel === 'aal2';

  useEffect(() => () => {
    mounted.current = false;
    queueGeneration.current += 1;
    detailGeneration.current += 1;
    decisionGeneration.current += 1;
  }, []);

  const loadQueue = useCallback(async (offset = 0) => {
    if (!canLoad || !accountId) return;
    const generation = ++queueGeneration.current;
    if (offset) setLoadingMore(true);
    else setLoading(true);
    setNotice(null);
    const result = await loadPendingBusinessSubmissions(accountId, offset);
    if (!mounted.current || generation !== queueGeneration.current) return;
    setLoading(false);
    setLoadingMore(false);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      return;
    }
    setItems((current) => offset
      ? [
          ...new Map(
            [...current, ...result.data.items].map((item) => [item.businessId, item]),
          ).values(),
        ]
      : result.data.items
    );
    setHasMore(result.data.hasMore);
  }, [accountId, canLoad]);

  useEffect(() => {
    if (!canLoad) return;
    const timer = setTimeout(() => void loadQueue(), 0);
    return () => clearTimeout(timer);
  }, [canLoad, loadQueue]);

  const openSubmission = async (submission: PendingBusinessSubmission) => {
    if (!accountId || busy) return;
    const generation = ++detailGeneration.current;
    setSelected(submission);
    setMobileDetail(null);
    setApprovedLocationIds([]);
    setApprovedStopIds([]);
    setReason('');
    setNotice(null);
    const mobile = submission.kind === 'food_truck' || submission.kind === 'pop_up';
    if (!mobile) {
      setLoadingDetail(false);
      return;
    }
    setLoadingDetail(true);
    const result = await loadPendingMobileSubmission(accountId, submission.businessId);
    if (!mounted.current || generation !== detailGeneration.current) return;
    setLoadingDetail(false);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      return;
    }
    setMobileDetail(result.data);
    setApprovedLocationIds(
      result.data.locations.filter((location) => location.isPrimary).map((location) => location.id),
    );
  };

  const closeSubmission = () => {
    detailGeneration.current += 1;
    setSelected(null);
    setMobileDetail(null);
    setApprovedLocationIds([]);
    setApprovedStopIds([]);
    setReason('');
    setLoadingDetail(false);
    setNotice(null);
  };

  const toggleLocation = (locationId: string) => {
    if (!mobileDetail) return;
    const location = mobileDetail.locations.find((candidate) => candidate.id === locationId);
    if (!location || location.isPrimary) return;
    if (approvedLocationIds.includes(locationId)) {
      setApprovedLocationIds((current) => current.filter((id) => id !== locationId));
      setApprovedStopIds((current) => current.filter((stopId) => {
        const stop = mobileDetail.draftStops.find((candidate) => candidate.id === stopId);
        return stop?.locationId !== locationId;
      }));
      return;
    }
    setApprovedLocationIds((current) => [...current, locationId]);
  };

  const toggleStop = (stopId: string) => {
    if (!mobileDetail) return;
    const stop = mobileDetail.draftStops.find((candidate) => candidate.id === stopId);
    if (!stop || !approvedLocationIds.includes(stop.locationId)) return;
    setApprovedStopIds((current) => current.includes(stopId)
      ? current.filter((id) => id !== stopId)
      : [...current, stopId]
    );
  };

  const readiness = useMemo(() => selected ? [
    { label: 'Approved logo', ready: selected.logoReady },
    { label: 'Email & phone', ready: Boolean(selected.contact.email && selected.contact.phone) },
    { label: 'Seven-day hours', ready: selected.weeklyDayCount === 7 },
    { label: 'Payment method', ready: selected.payments.length > 0 },
    { label: 'Published menu', ready: selected.publishedMenuItemCount > 0 },
    { label: 'Primary location', ready: selected.locationCount > 0 },
  ] : [], [selected]);
  const baseReady = readiness.every((item) => item.ready);
  const mobileSelection = mobileDetail
    ? validateMobileReviewSelection(mobileDetail, approvedLocationIds, approvedStopIds)
    : null;
  const reasonReady = reason.trim().length >= 3;
  const approvalReady = Boolean(
    selected &&
    baseReady &&
    reasonReady &&
    !loadingDetail &&
    (!(selected.kind === 'food_truck' || selected.kind === 'pop_up') || mobileSelection?.ok)
  );

  const decide = async (decision: 'approve' | 'return') => {
    if (!selected || !accountId || busy) return;
    const generation = ++decisionGeneration.current;
    setBusy(decision);
    setNotice(null);
    const result = decision === 'approve'
      ? await approveBusinessSubmission(
          accountId,
          selected,
          reason,
          mobileDetail
            ? { detail: mobileDetail, approvedLocationIds, approvedStopIds }
            : undefined,
        )
      : await returnBusinessSubmission(accountId, selected, reason);
    if (!mounted.current || generation !== decisionGeneration.current) return;
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      if (result.code === 'CONFLICT') {
        closeSubmission();
        await loadQueue();
      }
      return;
    }
    setItems((current) => current.filter((item) => item.businessId !== selected.businessId));
    setSelected(null);
    setMobileDetail(null);
    setApprovedLocationIds([]);
    setApprovedStopIds([]);
    setReason('');
    setNotice({
      tone: 'success',
      text: decision === 'approve'
        ? 'Business published with an audited approval receipt.'
        : 'Submission returned to the owner for changes.',
    });
  };

  if (!canLoad) {
    return (
      <FocusAwareScreen>
        <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
          <PageShell narrow>
            <View style={styles.topbar}><BrandMark /></View>
            <View style={styles.gate}>
              <View style={styles.gateIcon}><FontAwesome6 color={palette.accentDeep} name="location-check" size={23} /></View>
              <Text accessibilityRole="header" style={styles.gateTitle}>Protected business approvals</Text>
              <Text style={styles.gateBody}>Sign in with an authorized administrator account and verify a current authenticator code. The server makes the final access decision.</Text>
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
        <PageShell>
          <View style={styles.topbar}>
            <BrandMark />
            <Pressable accessibilityLabel="Close business approvals" accessibilityRole="button" onPress={() => router.back()} style={styles.closeButton}>
              <FontAwesome6 color={palette.ink} name="xmark" size={14} />
            </Pressable>
          </View>
          <View style={styles.intro}>
            <Text style={styles.eyebrow}>Launch operations</Text>
            <Text accessibilityRole="header" style={styles.title}>Publish only what was reviewed.</Text>
            <Text style={styles.subtitle}>Confirm the listing essentials, then choose the exact public pins and initial service stops for mobile vendors. Additional pins are private by default.</Text>
          </View>

          {notice ? (
            <View accessibilityLiveRegion="polite" accessibilityRole={notice.tone === 'error' ? 'alert' : undefined} style={[styles.notice, notice.tone === 'success' && styles.noticeSuccess]}>
              <Text style={[styles.noticeText, notice.tone === 'success' && styles.noticeSuccessText]}>{notice.text}</Text>
            </View>
          ) : null}

          {selected ? (
            <View style={styles.reviewWorkspace}>
              <View style={styles.reviewHeader}>
                <View style={styles.reviewTitleGroup}>
                  <Text style={styles.itemKind}>{kindLabels[selected.kind]}</Text>
                  <Text accessibilityRole="header" style={styles.reviewTitle}>{selected.businessName}</Text>
                  <Text style={styles.reviewMeta}>Submitted {new Date(selected.submittedAt).toLocaleString()} · {selected.timezone}</Text>
                </View>
                <Pressable accessibilityRole="button" disabled={Boolean(busy)} onPress={closeSubmission} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Back to queue</Text>
                </Pressable>
              </View>

              <View accessibilityLabel="Publication readiness" style={styles.readinessRow}>
                {readiness.map((item) => (
                  <View key={item.label} style={styles.readinessItem}>
                    <FontAwesome6 color={item.ready ? palette.success : palette.warning} name={item.ready ? 'circle-check' : 'triangle-exclamation'} size={11} />
                    <Text style={styles.readinessText}>{item.label}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.factColumns}>
                <View style={styles.factSection}>
                  <Text style={styles.sectionLabel}>Submission</Text>
                  <Text style={styles.description}>{selected.description || 'No public description supplied.'}</Text>
                  <Text style={styles.factText}>Cuisine: {selected.cuisineLabels.join(', ') || 'Not supplied'}</Text>
                  <Text style={styles.factText}>Price level: {'$'.repeat(selected.priceLevel)}</Text>
                  <Text style={styles.factText}>Payments: {selected.payments.join(', ') || 'None'}</Text>
                  <Text style={styles.factText}>Menu items ready: {selected.publishedMenuItemCount}</Text>
                </View>
                <View style={styles.factSection}>
                  <Text style={styles.sectionLabel}>Protected contact</Text>
                  <Text selectable style={styles.factText}>{selected.contact.legalName || 'Legal name not supplied'}</Text>
                  <Text selectable style={styles.factText}>{selected.contact.email || 'Email missing'}</Text>
                  <Text selectable style={styles.factText}>{selected.contact.phone || 'Phone missing'}</Text>
                  <Text selectable style={styles.factText}>{selected.contact.websiteUrl || 'Website not supplied'}</Text>
                  <Text style={styles.privateNote}>Restricted to this administrator view. Never copied into public discovery.</Text>
                </View>
              </View>

              {(selected.kind === 'food_truck' || selected.kind === 'pop_up') ? (
                loadingDetail ? (
                  <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.loadingText}>Loading exact submitted pins…</Text></View>
                ) : mobileDetail ? (
                  <View style={styles.mobileReview}>
                    <View style={styles.sectionIntro}>
                      <Text accessibilityRole="header" style={styles.sectionTitle}>Public pins</Text>
                      <Text style={styles.sectionCopy}>The primary pin is required. Every additional pin stays private unless you explicitly approve it.</Text>
                    </View>
                    <View style={styles.selectionList}>
                      {mobileDetail.locations.map((location) => {
                        const checked = approvedLocationIds.includes(location.id);
                        return (
                          <Pressable
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked, disabled: location.isPrimary }}
                            disabled={location.isPrimary || Boolean(busy)}
                            key={location.id}
                            onPress={() => toggleLocation(location.id)}
                            style={[styles.selectionRow, checked && styles.selectionRowChecked]}>
                            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                              {checked ? <FontAwesome6 color="#FFFFFF" name="check" size={9} /> : null}
                            </View>
                            <View style={styles.selectionCopy}>
                              <Text style={styles.selectionTitle}>{location.label}{location.isPrimary ? ' · Primary' : ''}</Text>
                              <Text style={styles.selectionMeta}>{[location.addressLine, location.city, location.region, location.postalCode].filter(Boolean).join(', ')}</Text>
                              <Text style={styles.coordinateText}>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)} · {location.publicAddress ? 'Public address' : 'Approximate public area'}</Text>
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>

                    <View style={styles.sectionIntro}>
                      <Text accessibilityRole="header" style={styles.sectionTitle}>Initial service stops</Text>
                      <Text style={styles.sectionCopy}>No stop is selected automatically. Approve a stop only after its location and time window are verified.</Text>
                    </View>
                    {!mobileDetail.draftStops.length ? <Text style={styles.emptyInline}>No initial stops were submitted.</Text> : (
                      <View style={styles.selectionList}>
                        {mobileDetail.draftStops.map((stop) => {
                          const location = mobileDetail.locations.find((candidate) => candidate.id === stop.locationId);
                          const enabled = approvedLocationIds.includes(stop.locationId);
                          const checked = approvedStopIds.includes(stop.id);
                          return (
                            <Pressable
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked, disabled: !enabled || Boolean(busy) }}
                              disabled={!enabled || Boolean(busy)}
                              key={stop.id}
                              onPress={() => toggleStop(stop.id)}
                              style={[styles.selectionRow, checked && styles.selectionRowChecked, !enabled && styles.disabled]}>
                              <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                                {checked ? <FontAwesome6 color="#FFFFFF" name="check" size={9} /> : null}
                              </View>
                              <View style={styles.selectionCopy}>
                                <Text style={styles.selectionTitle}>{location?.label ?? 'Submitted location'}</Text>
                                <Text style={styles.selectionMeta}>{new Date(stop.startsAt).toLocaleString()} – {new Date(stop.endsAt).toLocaleString()}</Text>
                                {!enabled ? <Text style={styles.warningText}>Approve this location before selecting its stop.</Text> : null}
                              </View>
                            </Pressable>
                          );
                        })}
                      </View>
                    )}
                    {mobileSelection && !mobileSelection.ok ? <Text accessibilityRole="alert" style={styles.warningText}>{mobileSelection.reason}</Text> : null}
                  </View>
                ) : (
                  <Text accessibilityRole="alert" style={styles.warningText}>Exact mobile submission details are unavailable. Reload before deciding.</Text>
                )
              ) : null}

              <View style={styles.decisionPanel}>
                <Text style={styles.sectionLabel}>Audit reason</Text>
                <TextInput
                  accessibilityLabel="Business review audit reason"
                  editable={!busy}
                  maxLength={1000}
                  multiline
                  onChangeText={setReason}
                  placeholder="What was verified, or what the owner must change"
                  placeholderTextColor={palette.mutedLight}
                  style={styles.reasonInput}
                  textAlignVertical="top"
                  value={reason}
                />
                {!baseReady ? <Text style={styles.warningText}>Publication is blocked until every readiness item is complete. Return the submission with clear instructions.</Text> : null}
                <View style={styles.decisionActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ busy: busy === 'return', disabled: Boolean(busy) || !reasonReady }}
                    disabled={Boolean(busy) || !reasonReady}
                    onPress={() => void decide('return')}
                    style={[styles.returnButton, (!reasonReady || Boolean(busy)) && styles.disabled]}>
                    {busy === 'return' ? <ActivityIndicator color={palette.accentDeep} size="small" /> : null}
                    <Text style={styles.returnButtonText}>Return for changes</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ busy: busy === 'approve', disabled: Boolean(busy) || !approvalReady }}
                    disabled={Boolean(busy) || !approvalReady}
                    onPress={() => void decide('approve')}
                    style={[styles.approveButton, (!approvalReady || Boolean(busy)) && styles.disabled]}>
                    {busy === 'approve' ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
                    <Text style={styles.approveButtonText}>Approve &amp; publish</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : loading ? (
            <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.loadingText}>Loading oldest submissions first…</Text></View>
          ) : !items.length ? (
            <View style={styles.empty}>
              <FontAwesome6 color={palette.success} name="circle-check" size={22} />
              <Text accessibilityRole="header" style={styles.emptyTitle}>Submission queue clear</Text>
              <Text style={styles.emptyBody}>No business listing is waiting for administrator review.</Text>
            </View>
          ) : (
            <View style={styles.queue}>
              {items.map((item) => {
                const readyCount = [
                  item.logoReady,
                  Boolean(item.contact.email && item.contact.phone),
                  item.weeklyDayCount === 7,
                  item.payments.length > 0,
                  item.publishedMenuItemCount > 0,
                  item.locationCount > 0,
                ].filter(Boolean).length;
                return (
                  <View key={item.businessId} style={styles.queueRow}>
                    <View style={styles.queueCopy}>
                      <Text style={styles.itemKind}>{kindLabels[item.kind]}</Text>
                      <Text style={styles.queueTitle}>{item.businessName}</Text>
                      <Text style={styles.queueMeta}>{readyCount}/6 readiness checks · {item.locationCount} submitted location{item.locationCount === 1 ? '' : 's'} · {new Date(item.submittedAt).toLocaleString()}</Text>
                    </View>
                    <Pressable accessibilityLabel={`Review ${item.businessName}`} accessibilityRole="button" onPress={() => void openSubmission(item)} style={styles.reviewButton}>
                      <Text style={styles.reviewButtonText}>Review</Text>
                      <FontAwesome6 color={palette.ink} name="arrow-right" size={10} />
                    </Pressable>
                  </View>
                );
              })}
              {hasMore ? (
                <Pressable accessibilityRole="button" accessibilityState={{ busy: loadingMore }} disabled={loadingMore} onPress={() => void loadQueue(items.length)} style={styles.loadMoreButton}>
                  {loadingMore ? <ActivityIndicator color={palette.ink} size="small" /> : null}
                  <Text style={styles.loadMoreText}>Load more submissions</Text>
                </Pressable>
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
  content: { paddingBottom: 100, paddingHorizontal: spacing.lg },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: spacing.md },
  closeButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
  intro: { gap: spacing.sm, maxWidth: 720, paddingBottom: spacing.xl, paddingTop: 48 },
  eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: palette.ink, fontSize: 34, fontWeight: '900', letterSpacing: -1.3, lineHeight: 39 },
  subtitle: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  notice: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginBottom: spacing.lg, padding: spacing.md },
  noticeSuccess: { backgroundColor: palette.successSoft },
  noticeText: { color: palette.accentDeep, fontSize: 11, lineHeight: 17 },
  noticeSuccessText: { color: palette.success },
  queue: { borderBottomColor: palette.line, borderBottomWidth: 1 },
  queueRow: { alignItems: 'center', borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.lg, justifyContent: 'space-between', minHeight: 112, paddingVertical: spacing.lg },
  queueCopy: { flex: 1, gap: 4 },
  itemKind: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  queueTitle: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  queueMeta: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  reviewButton: { alignItems: 'center', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 44, paddingHorizontal: 16 },
  reviewButtonText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  loadMoreButton: { alignItems: 'center', alignSelf: 'center', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', marginVertical: spacing.xl, minHeight: 46, paddingHorizontal: 18 },
  loadMoreText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 120 },
  loadingText: { color: palette.muted, fontSize: 11 },
  empty: { alignItems: 'center', borderBottomColor: palette.line, borderTopColor: palette.line, borderBottomWidth: 1, borderTopWidth: 1, gap: spacing.sm, paddingVertical: 64 },
  emptyTitle: { color: palette.ink, fontSize: 19, fontWeight: '900' },
  emptyBody: { color: palette.muted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  reviewWorkspace: { borderTopColor: palette.line, borderTopWidth: 1, gap: spacing.xl, paddingTop: spacing.xl },
  reviewHeader: { alignItems: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, justifyContent: 'space-between' },
  reviewTitleGroup: { flex: 1, gap: 4, minWidth: 250 },
  reviewTitle: { color: palette.ink, fontSize: 28, fontWeight: '900', letterSpacing: -0.9 },
  reviewMeta: { color: palette.muted, fontSize: 10 },
  secondaryButton: { borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 15 },
  secondaryButtonText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  readinessRow: { borderBottomColor: palette.line, borderTopColor: palette.line, borderBottomWidth: 1, borderTopWidth: 1, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingVertical: spacing.md },
  readinessItem: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 30 },
  readinessText: { color: palette.ink, fontSize: 9, fontWeight: '800' },
  factColumns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xl },
  factSection: { flex: 1, gap: 7, minWidth: 260 },
  sectionLabel: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase' },
  description: { color: palette.ink, fontSize: 13, lineHeight: 20 },
  factText: { color: palette.ink, fontSize: 11, lineHeight: 17 },
  privateNote: { color: palette.muted, fontSize: 9, fontStyle: 'italic', lineHeight: 14, marginTop: 4 },
  mobileReview: { gap: spacing.lg },
  sectionIntro: { gap: 5 },
  sectionTitle: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  sectionCopy: { color: palette.muted, fontSize: 10, lineHeight: 16, maxWidth: 680 },
  selectionList: { borderBottomColor: palette.line, borderBottomWidth: 1 },
  selectionRow: { alignItems: 'flex-start', borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.md, minHeight: 82, paddingVertical: spacing.md },
  selectionRowChecked: { backgroundColor: palette.accentSoft },
  checkbox: { alignItems: 'center', borderColor: palette.line, borderRadius: 7, borderWidth: 1, height: 22, justifyContent: 'center', marginLeft: spacing.sm, marginTop: 2, width: 22 },
  checkboxChecked: { backgroundColor: palette.accentDeep, borderColor: palette.accentDeep },
  selectionCopy: { flex: 1, gap: 3, paddingRight: spacing.sm },
  selectionTitle: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  selectionMeta: { color: palette.ink, fontSize: 10, lineHeight: 15 },
  coordinateText: { color: palette.muted, fontFamily: 'SpaceMono', fontSize: 8, lineHeight: 13 },
  emptyInline: { color: palette.muted, fontSize: 10, fontStyle: 'italic' },
  warningText: { color: palette.warning, fontSize: 9, fontWeight: '800', lineHeight: 14 },
  decisionPanel: { backgroundColor: palette.surface, borderRadius: radii.lg, gap: spacing.md, padding: spacing.lg },
  reasonInput: { borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 11, lineHeight: 17, minHeight: 100, padding: spacing.md },
  decisionActions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'flex-end' },
  returnButton: { alignItems: 'center', borderColor: palette.accentDeep, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 46, paddingHorizontal: 17 },
  returnButtonText: { color: palette.accentDeep, fontSize: 10, fontWeight: '900' },
  approveButton: { alignItems: 'center', backgroundColor: palette.success, borderRadius: radii.pill, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 46, paddingHorizontal: 18 },
  approveButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  disabled: { opacity: 0.48 },
  gate: { alignItems: 'center', gap: spacing.md, paddingVertical: 92 },
  gateIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 999, height: 60, justifyContent: 'center', width: 60 },
  gateTitle: { color: palette.ink, fontSize: 23, fontWeight: '900', textAlign: 'center' },
  gateBody: { color: palette.muted, fontSize: 12, lineHeight: 19, maxWidth: 480, textAlign: 'center' },
  primaryButton: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: radii.pill, justifyContent: 'center', minHeight: 48, paddingHorizontal: 20 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
});
