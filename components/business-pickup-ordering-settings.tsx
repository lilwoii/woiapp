import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { palette, radii, spacing } from '@/constants/theme';
import {
  BusinessPickupOrderingPreferences,
  loadBusinessPickupOrderingPreferences,
  saveBusinessPickupOrderingPreferences,
} from '@/lib/business-pickup-ordering';

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
    <BusinessPickupOrderingSettingsScope
      businessId={businessId}
      expectedUserId={expectedUserId}
      key={`${businessId}:${expectedUserId}`}
      state={state}
      verification={verification}
    />
  );
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
    if (preferences.merchantOptedIn) return 'OPTED IN';
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
            Restaurants and food trucks can record a pay-in-person launch preference.
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
                Saving an opt-in does not activate customer checkout. Spottr must separately
                enable the ordering release; this screen cannot enable payment processing.
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
                return (
                  <View
                    accessibilityLabel={`${option.label}. ${
                      option.configurationAllowed
                        ? selected
                          ? 'Accepted when pickup ordering launches.'
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
                          {option.configurationAllowed
                            ? selected
                              ? 'SELECTED'
                              : 'AVAILABLE'
                            : 'UNAVAILABLE'}
                        </Text>
                      </View>
                      <Text style={styles.optionDetail}>
                        {option.configurationAllowed
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
