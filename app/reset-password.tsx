import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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
import { validatePassword } from '@/lib/moderation';

export default function ResetPasswordScreen() {
  const auth = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const submit = async () => {
    setMessage(null);
    const passwordError = validatePassword(password);
    if (passwordError) {
      setMessage({ type: 'error', text: passwordError });
      return;
    }
    if (password !== confirmation) {
      setMessage({ type: 'error', text: 'The passwords do not match.' });
      return;
    }

    const result = await auth.updatePassword(password);
    if (!result.ok) {
      setMessage({ type: 'error', text: result.reason });
      return;
    }
    setMessage({ type: 'success', text: result.message ?? 'Password updated.' });
  };

  const recoveryUnavailable =
    auth.isConfigured && auth.status !== 'loading' && !auth.recoveryReady && message?.type !== 'success';

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable
              accessibilityLabel="Close password reset"
              accessibilityRole="button"
              onPress={() => router.replace('/auth')}
              style={styles.backButton}>
              <FontAwesome6 color={palette.ink} name="xmark" size={15} />
            </Pressable>
            <BrandMark />
            <View style={styles.spacer} />
          </View>

          <View style={styles.panel}>
            {auth.status === 'loading' ? (
              <View accessibilityLiveRegion="polite" style={styles.statePanel}>
                <ActivityIndicator color={palette.accentDeep} />
                <Text style={styles.subtitle}>Checking your recovery link…</Text>
              </View>
            ) : recoveryUnavailable ? (
              <View style={styles.intro}>
                <Text style={styles.eyebrow}>Recovery link required</Text>
                <Text accessibilityRole="header" style={styles.title}>
                  This link is invalid or expired.
                </Text>
                <Text style={styles.subtitle}>
                  Request a new password-recovery email, then open the latest link on this device.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.replace('/auth')}
                  style={styles.button}>
                  <Text style={styles.buttonText}>Request a new link</Text>
                  <FontAwesome6 color="#FFFFFF" name="arrow-right" size={13} />
                </Pressable>
              </View>
            ) : (
              <>
            <View style={styles.intro}>
              <Text style={styles.eyebrow}>Account recovery</Text>
              <Text accessibilityRole="header" style={styles.title}>
                Choose a new password.
              </Text>
              <Text style={styles.subtitle}>
                Use at least 12 characters and avoid passwords you use elsewhere.
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>New password</Text>
              <TextInput
                accessibilityLabel="New password"
                autoComplete="new-password"
                onChangeText={setPassword}
                placeholder="12 or more characters"
                placeholderTextColor={palette.mutedLight}
                secureTextEntry={!visible}
                style={styles.input}
                value={password}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Confirm new password</Text>
              <TextInput
                accessibilityLabel="Confirm new password"
                autoComplete="new-password"
                onChangeText={setConfirmation}
                placeholder="Repeat your new password"
                placeholderTextColor={palette.mutedLight}
                secureTextEntry={!visible}
                style={styles.input}
                value={confirmation}
              />
            </View>
            <Pressable
              accessibilityRole="checkbox"
              aria-checked={visible}
              accessibilityState={{ checked: visible }}
              onPress={() => setVisible((current) => !current)}
              style={styles.showRow}>
              <FontAwesome6 color={palette.muted} name={visible ? 'eye-slash' : 'eye'} size={13} />
              <Text style={styles.showText}>{visible ? 'Hide passwords' : 'Show passwords'}</Text>
            </Pressable>

            {message ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={[styles.message, message.type === 'success' && styles.messageSuccess]}>
                <Text style={[styles.messageText, message.type === 'success' && styles.messageTextSuccess]}>
                  {message.text}
                </Text>
              </View>
            ) : null}

            {message?.type === 'success' ? (
              <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.button}>
                <Text style={styles.buttonText}>Continue to Spottr</Text>
                <FontAwesome6 color="#FFFFFF" name="arrow-right" size={13} />
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={auth.isBusy}
                onPress={submit}
                style={[styles.button, auth.isBusy && styles.buttonDisabled]}>
                {auth.isBusy ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <>
                    <Text style={styles.buttonText}>Update password</Text>
                    <FontAwesome6 color="#FFFFFF" name="lock" size={13} />
                  </>
                )}
              </Pressable>
            )}
              </>
            )}
          </View>
        </PageShell>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 64 },
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
  spacer: { width: 48 },
  panel: {
    alignSelf: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    marginTop: spacing.xxxl,
    maxWidth: 620,
    padding: spacing.xl,
    width: '100%',
  },
  intro: { gap: spacing.sm },
  statePanel: {
    alignItems: 'center',
    gap: spacing.md,
    justifyContent: 'center',
    minHeight: 220,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: { color: palette.ink, fontSize: 36, fontWeight: '900', letterSpacing: -1.5, lineHeight: 40 },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  field: { gap: spacing.sm },
  label: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 14,
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  showRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  showText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  message: { backgroundColor: palette.accentSoft, borderRadius: radii.md, padding: spacing.md },
  messageSuccess: { backgroundColor: palette.successSoft },
  messageText: { color: palette.accentDeep, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  messageTextSuccess: { color: palette.success },
  button: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 52,
  },
  buttonDisabled: { opacity: 0.58 },
  buttonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
});
