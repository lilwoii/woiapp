import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { palette, radii, spacing } from '@/constants/theme';
import {
  BusinessPickupOrderingPreferences,
  loadBusinessPickupOrderingPreferences,
  saveBusinessPickupOrderingPreferences,
} from '@/lib/business-pickup-ordering';
import { featureFlags } from '@/lib/features';
import {
  loadMerchantPaymentStatus,
  setMerchantPrepaidAcceptance,
  startMerchantPaymentOnboarding,
  type MerchantPaymentStatus,
} from '@/lib/prepaid-pickup';

type Props = {
  businessId: string;
  expectedUserId: string;
  state: 'draft' | 'pending' | 'published' | 'suspended' | 'archived';
  verification: 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';
};

type Feedback = { tone: 'error' | 'success'; text: string };

export function BusinessPickupOrderingSettings({
  businessId,
  expectedUserId,
  state,
  verification,
}: Props) {
  return (
    <>
      <BusinessPickupOrderingSettingsScope
      businessId={businessId}
      expectedUserId={expectedUserId}
      key={`${businessId}:${expectedUserId}`}
      state={state}
      verification={verification}
      />
      {featureFlags.prepaidPickup ? <MerchantPaymentPanel businessId={businessId} expectedUserId={expectedUserId} /> : null}
    </>
  );
}

function MerchantPaymentPanel({ businessId, expectedUserId }: Pick<Props, 'businessId' | 'expectedUserId'>) {
  const [status, setStatus] = useState<MerchantPaymentStatus | null>(null);
  const [country, setCountry] = useState('US');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    const result = await loadMerchantPaymentStatus(businessId, expectedUserId);
    setBusy(false);
    if (!result.ok) { setFeedback({ tone: 'error', text: result.reason }); return; }
    setStatus(result.data);
    if (result.data.country) setCountry(result.data.country);
    setFeedback(null);
  }, [businessId, expectedUserId]);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const start = async () => {
    if (!/^[A-Z]{2}$/.test(country) || busy) return;
    setBusy(true); setFeedback(null);
    const result = await startMerchantPaymentOnboarding(businessId, country, expectedUserId);
    setBusy(false);
    if (!result.ok) { setFeedback({ tone: 'error', text: result.reason }); return; }
    await Linking.openURL(result.data.onboardingUrl);
    setFeedback({ tone: 'success', text: 'Return here after completing secure onboarding, then refresh status.' });
  };
  const toggle = async () => {
    if (!status || busy) return;
    setBusy(true); setFeedback(null);
    const result = await setMerchantPrepaidAcceptance(businessId, !status.acceptPrepaid, expectedUserId);
    setBusy(false);
    if (!result.ok) { setFeedback({ tone: 'error', text: result.reason }); return; }
    setStatus(result.data);
    setFeedback({ tone: 'success', text: result.data.acceptPrepaid ? 'Secure card and wallet checkout is on.' : 'Secure card and wallet checkout is off.' });
  };
  const ready = Boolean(status?.detailsSubmitted && status.chargesEnabled && status.payoutsEnabled);

  return <View style={styles.section}>
    <View style={styles.heading}>
      <View style={[styles.icon, ready && styles.iconEnabled]}><FontAwesome6 color={ready ? palette.success : palette.accentDeep} name="credit-card" size={14} /></View>
      <View style={styles.headingCopy}><Text accessibilityRole="header" style={styles.title}>Card and wallet checkout</Text><Text style={styles.detail}>Provider-hosted identity, tax, payment, and payout controls. Spottr never sees card details.</Text></View>
      <Text style={[styles.state, ready && styles.stateEnabled]}>{status?.acceptPrepaid ? 'ACTIVE' : ready ? 'READY' : status?.onboardingStarted ? 'ACTION NEEDED' : 'SETUP'}</Text>
    </View>
    <View style={styles.body}>
      <View style={styles.launchNotice}><FontAwesome6 color={palette.warning} name="shield-halved" size={12} /><Text style={styles.launchNoticeText}>Only restaurants and food trucks with completed identity, charge, payout, tax, webhook, and refund readiness can accept prepaid orders.</Text></View>
      {!status?.onboardingStarted ? <View style={styles.countryRow}><View style={styles.flex}><Text style={styles.optionTitle}>Legal business country</Text><Text style={styles.optionDetail}>Two-letter country code; this cannot be casually changed after provider onboarding.</Text></View><TextInput accessibilityLabel="Legal business country code" autoCapitalize="characters" maxLength={2} onChangeText={(value) => setCountry(value.replace(/[^A-Za-z]/g, '').toUpperCase())} style={styles.countryInput} value={country} /></View> : null}
      {status?.onboardingStarted ? <View style={styles.readinessGrid}>
        <Readiness label="Identity details" ready={status.detailsSubmitted} />
        <Readiness label="Card charges" ready={status.chargesEnabled} />
        <Readiness label="Payouts" ready={status.payoutsEnabled} />
        <Readiness label="Open requirements" ready={status.requirementsDueCount === 0} value={String(status.requirementsDueCount)} />
      </View> : null}
      {feedback ? <View accessibilityLiveRegion="polite" style={[styles.feedback, feedback.tone === 'success' && styles.feedbackSuccess]}><Text style={[styles.feedbackText, feedback.tone === 'success' && styles.feedbackTextSuccess]}>{feedback.text}</Text></View> : null}
      <View style={styles.buttonRow}>
        <Pressable accessibilityRole="button" accessibilityState={{ busy }} disabled={busy || (!status?.onboardingStarted && !/^[A-Z]{2}$/.test(country))} onPress={() => void start()} style={[styles.saveButton, busy && styles.disabled]}>{busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : <FontAwesome6 color="#FFFFFF" name="arrow-up-right-from-square" size={11} />}<Text style={styles.saveButtonText}>{status?.onboardingStarted ? 'Continue secure setup' : 'Start secure setup'}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void refresh()} style={styles.secondaryButton}><FontAwesome6 color={palette.ink} name="rotate" size={11} /><Text style={styles.secondaryButtonText}>Refresh</Text></Pressable>
        {ready ? <Pressable accessibilityRole="switch" accessibilityState={{ checked: Boolean(status?.acceptPrepaid), disabled: busy }} disabled={busy} onPress={() => void toggle()} style={[styles.secondaryButton, status?.acceptPrepaid && styles.acceptButton]}><Text style={[styles.secondaryButtonText, status?.acceptPrepaid && styles.acceptButtonText]}>{status?.acceptPrepaid ? 'Accepting prepaid' : 'Enable prepaid'}</Text></Pressable> : null}
      </View>
    </View>
  </View>;
}

function Readiness({ label, ready, value }: { label: string; ready: boolean; value?: string }) {
  return <View style={styles.readinessItem}><FontAwesome6 color={ready ? palette.success : palette.warning} name={ready ? 'circle-check' : 'circle-exclamation'} size={11} /><Text style={styles.readinessText}>{label}{value ? ` · ${value}` : ''}</Text></View>;
}

function BusinessPickupOrderingSettingsScope({
  businessId,
  expectedUserId,
  state,
  verification,
}: Props) {
  const [preferences, setPreferences] =
    useState<BusinessPickupOrderingPreferences | null>(null);
  const [draftOptIn, setDraftOptIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadBusinessPickupOrderingPreferences(businessId, expectedUserId).then(
      (result) => {
        if (!active) return;
        setLoading(false);
        if (!result.ok) {
          setPreferences(null);
          setFeedback({ tone: 'error', text: result.reason });
          return;
        }
        setPreferences(result.data);
        setDraftOptIn(result.data.merchantOptedIn);
      }
    );
    return () => {
      active = false;
    };
  }, [businessId, expectedUserId]);

  const listingReady = state === 'published' && verification === 'verified';
  const dirty = Boolean(preferences) && draftOptIn !== preferences?.merchantOptedIn;
  const canSave =
    Boolean(preferences?.eligibleKind) &&
    dirty &&
    !loading &&
    !saving &&
    (!draftOptIn || listingReady);
  const preferenceControlDisabled =
    saving ||
    !preferences ||
    !preferences.eligibleKind ||
    (!listingReady && !draftOptIn);
  const stateLabel = useMemo(() => {
    if (loading) return 'CHECKING';
    if (!preferences) return 'UNAVAILABLE';
    if (!preferences?.eligibleKind) return 'INELIGIBLE';
    if (preferences.customerOrderingEnabled) return 'ACTIVE';
    if (preferences.merchantOptedIn) return 'READY';
    return 'OPTIONAL';
  }, [loading, preferences]);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setFeedback(null);
    const result = await saveBusinessPickupOrderingPreferences(
      businessId,
      draftOptIn,
      expectedUserId
    );
    if (!mounted.current) return;
    setSaving(false);
    if (!result.ok) {
      setFeedback({ tone: 'error', text: result.reason });
      return;
    }
    setPreferences(result.data);
    setDraftOptIn(result.data.merchantOptedIn);
    setFeedback({
      tone: 'success',
      text: result.message ?? 'Pickup preference saved.',
    });
  };

  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <View
          style={[
            styles.icon,
            preferences?.merchantOptedIn && styles.iconEnabled,
          ]}>
          <FontAwesome6
            color={preferences?.merchantOptedIn ? palette.success : palette.accentDeep}
            name={preferences?.merchantOptedIn ? 'check' : 'bag-shopping'}
            size={14}
          />
        </View>
        <View style={styles.headingCopy}>
          <Text accessibilityRole="header" style={styles.title}>
            Pickup ordering
          </Text>
          <Text style={styles.detail}>
            Accept secure pickup requests while collecting payment in person.
          </Text>
        </View>
        <Text
          style={[
            styles.state,
            preferences?.merchantOptedIn && styles.stateEnabled,
          ]}>
          {stateLabel}
        </Text>
      </View>

      <View style={styles.body}>
        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={palette.accentDeep} size="small" />
            <Text accessibilityLiveRegion="polite" style={styles.loadingText}>
              Checking server-owned pickup settings…
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.launchNotice}>
              <FontAwesome6 color={palette.warning} name="shield-halved" size={12} />
              <Text style={styles.launchNoticeText}>
                {preferences?.customerOrderingEnabled
                  ? 'Pickup requests are active. Spottr never handles the customer payment in this mode.'
                  : 'Saving an opt-in does not activate customer checkout. Your choice is separate from Spottr’s protected runtime switch, and this screen cannot enable payment processing.'}
              </Text>
            </View>

            <Pressable
              accessibilityLabel="Opt in to pay-in-person pickup ordering"
              accessibilityRole="checkbox"
              accessibilityState={{
                checked: draftOptIn,
                disabled: preferenceControlDisabled,
              }}
              disabled={preferenceControlDisabled}
              onPress={() => {
                setDraftOptIn((current) => !current);
                setFeedback(null);
              }}
              style={({ pressed }) => [
                styles.optInRow,
                pressed && styles.pressed,
                preferenceControlDisabled && styles.disabled,
              ]}>
              <View style={[styles.checkbox, draftOptIn && styles.checkboxSelected]}>
                {draftOptIn ? (
                  <FontAwesome6 color="#FFFFFF" name="check" size={10} />
                ) : null}
              </View>
              <View style={styles.optInCopy}>
                <Text style={styles.optInLabel}>Opt in to pickup ordering</Text>
                <Text style={styles.optInDetail}>
                  {listingReady
                    ? 'Pay in person is the only accepted option in this launch slice.'
                    : 'Publish and verify this listing before opting in.'}
                </Text>
              </View>
            </Pressable>

            <View style={styles.optionHeader}>
              <Text style={styles.optionHeaderTitle}>Accepted checkout methods</Text>
              <Text style={styles.optionHeaderState}>SERVER CONTROLLED</Text>
            </View>
            <View accessibilityRole="list" style={styles.optionList}>
              {(preferences?.paymentOptions ?? []).map((option) => {
                const selected = option.kind === 'pay_in_person' && draftOptIn;
                const managedBelow = featureFlags.prepaidPickup && option.kind !== 'pay_in_person';
                return (
                  <View
                    accessibilityLabel={`${option.label}. ${
                      managedBelow
                        ? 'Configure secure provider onboarding and acceptance below.'
                        : option.configurationAllowed
                        ? selected
                          ? preferences?.customerOrderingEnabled
                            ? 'Accepted for active pickup requests.'
                            : 'Ready when the protected pickup runtime is enabled.'
                          : 'Available to configure.'
                        : option.unavailableReason
                    }`}
                    accessibilityRole="summary"
                    key={option.kind}
                    style={styles.optionRow}>
                    <View
                      style={[
                        styles.optionMark,
                        selected && styles.optionMarkSelected,
                        !option.configurationAllowed && styles.optionMarkUnavailable,
                      ]}>
                      <FontAwesome6
                        color={
                          selected
                            ? '#FFFFFF'
                            : option.configurationAllowed
                              ? palette.accentDeep
                              : palette.muted
                        }
                        name={
                          selected
                            ? 'check'
                            : option.kind === 'apple_pay'
                              ? 'apple'
                              : option.kind === 'card'
                                ? 'credit-card'
                                : 'store'
                        }
                        size={11}
                      />
                    </View>
                    <View style={styles.optionCopy}>
                      <View style={styles.optionTitleRow}>
                        <Text style={styles.optionTitle}>{option.label}</Text>
                        <Text
                          style={[
                            styles.optionStatus,
                            option.configurationAllowed && styles.optionStatusAvailable,
                          ]}>
                          {managedBelow
                            ? 'SEPARATE SETUP'
                            : option.configurationAllowed
                            ? selected
                              ? 'SELECTED'
                              : 'AVAILABLE'
                            : 'UNAVAILABLE'}
                        </Text>
                      </View>
                      <Text style={styles.optionDetail}>
                        {managedBelow
                          ? 'Complete the secure payment account panel below. Wallet availability is determined by the customer device and provider.'
                          : option.configurationAllowed
                          ? 'The customer pays the business at pickup. Spottr creates no charge.'
                          : option.unavailableReason}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>

            {feedback ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={[
                  styles.feedback,
                  feedback.tone === 'success' && styles.feedbackSuccess,
                ]}>
                <FontAwesome6
                  color={
                    feedback.tone === 'success' ? palette.success : palette.accentDeep
                  }
                  name={
                    feedback.tone === 'success'
                      ? 'circle-check'
                      : 'triangle-exclamation'
                  }
                  size={12}
                />
                <Text
                  style={[
                    styles.feedbackText,
                    feedback.tone === 'success' && styles.feedbackTextSuccess,
                  ]}>
                  {feedback.text}
                </Text>
              </View>
            ) : null}

            <Pressable
              accessibilityLabel="Save pickup-ordering preference"
              accessibilityRole="button"
              accessibilityState={{ busy: saving, disabled: !canSave }}
              disabled={!canSave}
              onPress={() => void save()}
              style={({ pressed }) => [
                styles.saveButton,
                pressed && canSave && styles.saveButtonPressed,
                !canSave && styles.disabled,
              ]}>
              {saving ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <FontAwesome6 color="#FFFFFF" name="floppy-disk" size={12} />
              )}
              <Text style={styles.saveButtonText}>
                {saving ? 'Saving…' : 'Save pickup preference'}
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    paddingVertical: spacing.xxl,
  },
  heading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  iconEnabled: { backgroundColor: palette.successSoft },
  headingCopy: { flex: 1, gap: 3 },
  title: { color: palette.ink, fontSize: 18, fontWeight: '900', letterSpacing: -0.4 },
  detail: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  state: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 8,
    letterSpacing: 0.6,
  },
  stateEnabled: { color: palette.success },
  body: { gap: spacing.lg, marginLeft: 52, marginTop: spacing.lg },
  flex: { flex: 1 },
  countryRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  countryInput: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.sm, borderWidth: 1, color: palette.ink, fontFamily: 'SpaceMono', fontSize: 14, fontWeight: '800', paddingHorizontal: 12, paddingVertical: 10, textAlign: 'center', width: 64 },
  readinessGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  readinessItem: { alignItems: 'center', backgroundColor: palette.bg, borderRadius: radii.pill, flexDirection: 'row', gap: 7, paddingHorizontal: 10, paddingVertical: 8 },
  readinessText: { color: palette.ink, fontSize: 10, fontWeight: '800' },
  buttonRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  secondaryButton: { alignItems: 'center', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 7, minHeight: 46, paddingHorizontal: spacing.md },
  secondaryButtonText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  acceptButton: { backgroundColor: palette.successSoft, borderColor: palette.success },
  acceptButtonText: { color: palette.success },
  loadingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  loadingText: { color: palette.muted, fontSize: 11 },
  launchNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  launchNoticeText: { color: palette.warning, flex: 1, fontSize: 10, lineHeight: 16 },
  optInRow: {
    alignItems: 'flex-start',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 54,
    paddingBottom: spacing.md,
  },
  checkbox: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 6,
    borderWidth: 1,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  checkboxSelected: { backgroundColor: palette.success, borderColor: palette.success },
  optInCopy: { flex: 1, gap: 3 },
  optInLabel: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  optInDetail: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  optionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  optionHeaderTitle: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  optionHeaderState: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 7,
    letterSpacing: 0.4,
  },
  optionList: { gap: 0 },
  optionRow: {
    alignItems: 'flex-start',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  optionMark: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  optionMarkSelected: { backgroundColor: palette.success },
  optionMarkUnavailable: { backgroundColor: palette.bg },
  optionCopy: { flex: 1, gap: 5 },
  optionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  optionTitle: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  optionStatus: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 7,
    letterSpacing: 0.4,
  },
  optionStatusAvailable: { color: palette.success },
  optionDetail: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  feedback: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  feedbackSuccess: { backgroundColor: palette.successSoft },
  feedbackText: { color: palette.accentDeep, flex: 1, fontSize: 10, lineHeight: 16 },
  feedbackTextSuccess: { color: palette.success },
  saveButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 8,
    minHeight: 46,
    paddingHorizontal: spacing.lg,
  },
  saveButtonPressed: { backgroundColor: palette.dark },
  saveButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.45 },
});
