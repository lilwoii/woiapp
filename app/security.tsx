import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
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
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import {
  beginTotpEnrollment,
  getMfaOverview,
  MfaOverview,
  removeTotp,
  TotpEnrollment,
  verifyTotp,
} from '@/lib/account-security';
import { confirmAction } from '@/lib/platform-dialog';

type Feedback = { type: 'error' | 'success'; text: string } | null;

export default function SecurityScreen() {
  const auth = useAuth();
  const [overview, setOverview] = useState<MfaOverview | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let cancelled = false;
    const expectedUserId = auth.account?.id;
    const timer = setTimeout(() => {
      if (auth.status !== 'authenticated' || !expectedUserId) {
        setOverview(null);
        setBusy(false);
        return;
      }
      setBusy(true);
      void getMfaOverview(expectedUserId).then((result) => {
        if (cancelled) return;
        setBusy(false);
        if (!result.ok) {
          setFeedback({ type: 'error', text: result.reason });
          return;
        }
        setOverview(result.data ?? null);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [auth.account?.id, auth.status]);

  const beginEnrollment = async () => {
    setBusy(true);
    setFeedback(null);
    const result = await beginTotpEnrollment();
    setBusy(false);
    if (!result.ok || !result.data) {
      setFeedback({ type: 'error', text: result.ok ? 'Enrollment could not start.' : result.reason });
      return;
    }
    setEnrollment(result.data);
    setCode('');
  };

  const verify = async () => {
    const factorId = enrollment?.factorId ?? overview?.factorId;
    if (!factorId) {
      setFeedback({ type: 'error', text: 'Start authenticator setup again.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result = await verifyTotp(factorId, code);
    setBusy(false);
    if (!result.ok) {
      setFeedback({ type: 'error', text: result.reason });
      return;
    }
    setEnrollment(null);
    setOverview(result.data ?? null);
    setCode('');
    await auth.refreshSecurity();
    setFeedback({ type: 'success', text: result.message ?? 'Authenticator protection is active.' });
  };

  const remove = async () => {
    if (!overview?.factorId) return;
    const confirmed = await confirmAction({
      title: 'Remove authenticator protection?',
      message:
        auth.account?.role === 'business'
          ? 'Business tools will remain locked until another authenticator is verified.'
          : 'Your account will return to password-only sign-in.',
      confirmLabel: 'Remove authenticator',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setFeedback(null);
    const result = await removeTotp(overview.factorId);
    setBusy(false);
    if (!result.ok) {
      setFeedback({ type: 'error', text: result.reason });
      return;
    }
    setOverview(result.data ?? null);
    await auth.refreshSecurity();
    setFeedback({ type: 'success', text: result.message ?? 'Authenticator removed.' });
  };

  const recoverPassword = async () => {
    if (!auth.account?.email) return;
    setBusy(true);
    setFeedback(null);
    const result = await auth.requestPasswordReset(auth.account.email);
    setBusy(false);
    setFeedback({
      type: result.ok ? 'success' : 'error',
      text: result.ok ? result.message ?? 'Recovery email sent.' : result.reason,
    });
  };

  const signOutEverywhere = async () => {
    const confirmed = await confirmAction({
      title: 'Sign out every device?',
      message: 'Every active Spottr session, including this one, will need to sign in again.',
      confirmLabel: 'Sign out all devices',
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    const result = await auth.signOutAllSessions();
    setBusy(false);
    if (!result.ok) {
      setFeedback({ type: 'error', text: result.reason });
      return;
    }
    if (result.data?.signedOutCurrentSession) {
      router.replace('/auth');
      return;
    }
    setFeedback({
      type: 'success',
      text: result.message ?? 'The prior account sessions were revoked.',
    });
  };

  const openAuthenticator = async () => {
    if (!enrollment?.uri) return;
    try {
      await Linking.openURL(enrollment.uri);
    } catch {
      setFeedback({
        type: 'error',
        text: 'No authenticator app opened. Add the setup key manually instead.',
      });
    }
  };

  const signedOut = auth.status === 'anonymous' || auth.status === 'error';
  const unconfigured = auth.status === 'unconfigured';
  const needsChallenge = Boolean(overview?.enrolled && overview.currentLevel !== 'aal2');
  const businessNeedsEnrollment =
    auth.account?.role === 'business' && !overview?.enrolled && !enrollment;

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <PageShell narrow>
        <View style={styles.topbar}>
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}>
            <FontAwesome6 color={palette.ink} name="arrow-left" size={14} />
          </Pressable>
          <BrandMark />
          <View style={styles.backSpacer} />
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Sign-in & security</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Protect the account behind your places.
          </Text>
          <Text style={styles.subtitle}>
            Authenticator codes add a second proof at sign-in. Spottr requires this protection for
            business management.
          </Text>
        </View>

        {signedOut || unconfigured ? (
          <View style={styles.panel}>
            <View style={styles.statusIcon}>
              <FontAwesome6 color={palette.accentDeep} name="shield-halved" size={20} />
            </View>
            <Text style={styles.panelTitle}>
              {unconfigured ? 'Security setup needs live Spottr services.' : 'Sign in to continue.'}
            </Text>
            <Text style={styles.panelBody}>
              {unconfigured
                ? 'This build accepts no credentials and creates no account until the secured backend is configured.'
                : 'Your security settings are available only after a verified sign-in.'}
            </Text>
            {!unconfigured ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.replace('/auth')}
                style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Sign in</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <>
            {businessNeedsEnrollment ? (
              <View accessibilityRole="alert" style={styles.requiredBanner}>
                <FontAwesome6 color={palette.accentDeep} name="triangle-exclamation" size={15} />
                <Text style={styles.requiredText}>
                  Authenticator setup is required before business tools unlock.
                </Text>
              </View>
            ) : null}

            <View style={styles.panel}>
              <View style={styles.panelHeading}>
                <View
                  style={[
                    styles.statusIcon,
                    overview?.enrolled && overview.currentLevel === 'aal2' && styles.statusIconSafe,
                  ]}>
                  <FontAwesome6
                    color={
                      overview?.enrolled && overview.currentLevel === 'aal2'
                        ? palette.success
                        : palette.accentDeep
                    }
                    name="mobile-screen-button"
                    size={20}
                  />
                </View>
                <View style={styles.panelHeadingCopy}>
                  <Text style={styles.panelTitle}>Authenticator app</Text>
                  <Text style={styles.panelBody}>
                    {overview?.enrolled
                      ? overview.currentLevel === 'aal2'
                        ? 'Verified for this session'
                        : 'Connected · enter a current code'
                      : enrollment
                        ? 'Finish setup with a six-digit code'
                        : 'Not connected'}
                  </Text>
                </View>
              </View>

              {enrollment ? (
                <View style={styles.setupBlock}>
                  <Text style={styles.stepTitle}>1. Add Spottr to your authenticator</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void openAuthenticator()}
                    style={styles.secondaryButton}>
                    <FontAwesome6 color={palette.ink} name="arrow-up-right-from-square" size={12} />
                    <Text style={styles.secondaryButtonText}>Open authenticator app</Text>
                  </Pressable>
                  <Text style={styles.keyLabel}>Manual setup key</Text>
                  <Text selectable style={styles.secret}>
                    {enrollment.secret}
                  </Text>
                  <Text style={styles.keyHint}>
                    Keep this key private. Spottr support will never ask for it.
                  </Text>
                  <Text style={styles.stepTitle}>2. Verify the current code</Text>
                </View>
              ) : null}

              {needsChallenge || enrollment ? (
                <View style={styles.codeRow}>
                  <TextInput
                    accessibilityLabel="Six-digit authenticator code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    onChangeText={(value) => setCode(value.replace(/\D/g, ''))}
                    placeholder="000000"
                    placeholderTextColor={palette.mutedLight}
                    style={styles.codeInput}
                    value={code}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || code.length !== 6}
                    onPress={() => void verify()}
                    style={[styles.primaryButton, styles.verifyButton, (busy || code.length !== 6) && styles.disabled]}>
                    {busy ? (
                      <ActivityIndicator color="#FFFFFF" size="small" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Verify</Text>
                    )}
                  </Pressable>
                </View>
              ) : overview?.enrolled ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void remove()}
                  style={styles.textButton}>
                  <Text style={styles.dangerText}>Remove authenticator</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void beginEnrollment()}
                  style={[styles.primaryButton, busy && styles.disabled]}>
                  {busy ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Connect authenticator</Text>
                      <FontAwesome6 color="#FFFFFF" name="arrow-right" size={12} />
                    </>
                  )}
                </Pressable>
              )}
            </View>

            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Password & sessions</Text>
              <Text style={styles.panelBody}>
                Password changes use a time-limited email link and revoke other active sessions.
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void recoverPassword()}
                style={styles.secondaryButton}>
                <FontAwesome6 color={palette.ink} name="key" size={12} />
                <Text style={styles.secondaryButtonText}>Change password by email</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void signOutEverywhere()}
                style={styles.textButton}>
                <Text style={styles.dangerText}>Sign out all devices</Text>
              </Pressable>
            </View>
          </>
        )}

        {feedback ? (
          <View
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={[styles.feedback, feedback.type === 'success' && styles.feedbackSuccess]}>
            <Text
              style={[
                styles.feedbackText,
                feedback.type === 'success' && styles.feedbackTextSuccess,
              ]}>
              {feedback.text}
            </Text>
          </View>
        ) : null}
      </PageShell>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 72 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  backButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  backSpacer: { width: 48 },
  hero: { gap: spacing.sm, marginTop: spacing.xxxl },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: -1.6,
    lineHeight: 42,
    maxWidth: 620,
  },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 22, maxWidth: 620 },
  panel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.md,
    marginTop: spacing.xl,
    padding: spacing.xl,
  },
  panelHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  panelHeadingCopy: { flex: 1, gap: 3 },
  statusIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  statusIconSafe: { backgroundColor: palette.successSoft },
  panelTitle: { color: palette.ink, fontSize: 17, fontWeight: '900' },
  panelBody: { color: palette.muted, fontSize: 12, lineHeight: 19 },
  requiredBanner: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
    padding: spacing.md,
  },
  requiredText: { color: palette.accentDeep, flex: 1, fontSize: 12, fontWeight: '800' },
  setupBlock: { gap: spacing.sm },
  stepTitle: { color: palette.ink, fontSize: 12, fontWeight: '900', marginTop: spacing.sm },
  keyLabel: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 10,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  secret: {
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontFamily: 'SpaceMono',
    fontSize: 12,
    lineHeight: 20,
    padding: spacing.md,
  },
  keyHint: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  codeRow: { alignItems: 'stretch', flexDirection: 'row', gap: spacing.sm },
  codeInput: {
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    flex: 1,
    fontFamily: 'SpaceMono',
    fontSize: 20,
    letterSpacing: 6,
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  verifyButton: { minWidth: 110 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  secondaryButtonText: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  textButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  dangerText: { color: palette.accentDeep, fontSize: 12, fontWeight: '900' },
  disabled: { opacity: 0.52 },
  feedback: {
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  feedbackSuccess: { backgroundColor: palette.successSoft },
  feedbackText: { color: palette.accentDeep, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  feedbackTextSuccess: { color: palette.success },
});
