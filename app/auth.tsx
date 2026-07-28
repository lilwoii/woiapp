import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
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
import { validateUsername } from '@/lib/moderation';
import { AccountRole } from '@/types/marketplace';

type Mode = 'signup' | 'signin';

const existingUsernames = ['maya.rose', 'miraeats', 'alexonfoot', 'westsidebites'];

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize = 'none',
  hint,
  error,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none' | 'words';
  hint?: string;
  error?: string | null;
}) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHeader}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <TextInput
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.mutedLight}
        secureTextEntry={secureTextEntry}
        style={[styles.input, error ? styles.inputError : null]}
        value={value}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signup');
  const [role, setRole] = useState<AccountRole>('customer');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const usernameError = useMemo(
    () => (mode === 'signup' && username ? validateUsername(username, existingUsernames) : null),
    [mode, username]
  );

  const emailError =
    submitted && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Enter a valid email address.' : null;
  const passwordError =
    submitted && password.length < 12 ? 'Use at least 12 characters for a stronger password.' : null;
  const displayNameError = submitted && mode === 'signup' && !displayName.trim() ? 'Add your display name.' : null;

  const submit = () => {
    setSubmitted(true);

    if (mode === 'signup') {
      const usernameValidation = validateUsername(username, existingUsernames);
      if (
        usernameValidation ||
        !displayName.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        password.length < 12 ||
        !accepted
      ) {
        if (!accepted) Alert.alert('Terms required', 'Review and accept the Terms and Privacy Policy to continue.');
        return;
      }

      Alert.alert(
        'Secure account flow ready',
        role === 'business'
          ? 'Email verification comes first, then business setup and ownership checks.'
          : 'Email verification comes first. The password is never stored in the app.'
      );

      if (role === 'business') {
        router.replace('/business-onboarding');
      } else {
        router.back();
      }
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !password) return;
    Alert.alert('Signed-in preview', 'Production sign-in uses secure Supabase sessions and verified email.');
    router.back();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={24}
      style={styles.keyboard}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable accessibilityLabel="Go back" onPress={() => router.back()} style={styles.backButton}>
              <FontAwesome6 color={palette.ink} name="arrow-left" size={14} />
            </Pressable>
            <BrandMark />
            <View style={styles.backSpacer} />
          </View>

          <View style={styles.authCard}>
            <View style={styles.intro}>
              <Text style={styles.eyebrow}>One account, both sides</Text>
              <Text style={styles.title}>{mode === 'signup' ? 'Join your local food map.' : 'Welcome back.'}</Text>
              <Text style={styles.subtitle}>
                {mode === 'signup'
                  ? 'Follow places, review visits, or manage a verified business from the same secure account.'
                  : 'Sign in with the email connected to your Spottr account.'}
              </Text>
            </View>

            <View style={styles.modeSwitch}>
              {(
                [
                  ['signup', 'Create account'],
                  ['signin', 'Sign in'],
                ] as [Mode, string][]
              ).map(([id, label]) => (
                <Pressable
                  key={id}
                  onPress={() => {
                    setMode(id);
                    setSubmitted(false);
                  }}
                  style={[styles.modeOption, mode === id && styles.modeOptionActive]}>
                  <Text style={[styles.modeText, mode === id && styles.modeTextActive]}>{label}</Text>
                </Pressable>
              ))}
            </View>

            {mode === 'signup' ? (
              <>
                <View style={styles.roleSection}>
                  <Text style={styles.label}>I’m joining as</Text>
                  <View style={styles.roleRow}>
                    {(
                      [
                        ['customer', 'Customer', 'heart', 'Discover and review'],
                        ['business', 'Business', 'store', 'Add or claim a listing'],
                      ] as [AccountRole, string, keyof typeof FontAwesome6.glyphMap, string][]
                    ).map(([id, label, icon, detail]) => {
                      const active = role === id;
                      return (
                        <Pressable
                          key={id}
                          onPress={() => setRole(id)}
                          style={[styles.roleOption, active && styles.roleOptionActive]}>
                          <View style={[styles.roleIcon, active && styles.roleIconActive]}>
                            <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={icon} size={14} solid={active} />
                          </View>
                          <View style={styles.roleCopy}>
                            <Text style={[styles.roleTitle, active && styles.roleTitleActive]}>{label}</Text>
                            <Text style={[styles.roleDetail, active && styles.roleDetailActive]}>{detail}</Text>
                          </View>
                          {active ? <FontAwesome6 color={palette.mint} name="circle-check" size={13} solid /> : null}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <Field
                  autoCapitalize="words"
                  error={displayNameError}
                  label="Display name"
                  onChangeText={setDisplayName}
                  placeholder="How your name appears"
                  value={displayName}
                />
                <Field
                  error={submitted || username ? usernameError : null}
                  hint="1–24 characters · unique"
                  label="Username"
                  onChangeText={setUsername}
                  placeholder="yourname"
                  value={username}
                />
              </>
            ) : null}

            <Field
              error={emailError}
              keyboardType="email-address"
              label="Email"
              onChangeText={setEmail}
              placeholder="you@example.com"
              value={email}
            />
            <Field
              error={passwordError}
              hint={mode === 'signup' ? '12+ characters' : undefined}
              label="Password"
              onChangeText={setPassword}
              placeholder={mode === 'signup' ? 'Create a strong password' : 'Enter your password'}
              secureTextEntry
              value={password}
            />

            {mode === 'signin' ? (
              <Pressable style={styles.forgotButton}>
                <Text style={styles.forgotText}>Forgot password?</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => setAccepted((current) => !current)} style={styles.termsRow}>
                <View style={[styles.checkbox, accepted && styles.checkboxActive]}>
                  {accepted ? <FontAwesome6 color="#FFFFFF" name="check" size={10} /> : null}
                </View>
                <Text style={styles.termsText}>
                  I agree to the Terms, Privacy Policy, community rules, and accurate business information requirements.
                </Text>
              </Pressable>
            )}

            <Pressable onPress={submit} style={styles.submitButton}>
              <Text style={styles.submitText}>{mode === 'signup' ? 'Create secure account' : 'Sign in'}</Text>
              <FontAwesome6 color="#FFFFFF" name="arrow-right" size={13} />
            </Pressable>

            <View style={styles.securityNote}>
              <FontAwesome6 color={palette.success} name="shield-halved" size={15} />
              <Text style={styles.securityText}>
                Passwords are handled by the authentication provider, never stored in app tables. Business access requires
                verified ownership and stronger sign-in protection.
              </Text>
            </View>
          </View>
        </PageShell>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: 60,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  backSpacer: {
    width: 40,
  },
  authCard: {
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
  intro: {
    gap: spacing.sm,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 37,
    fontWeight: '900',
    letterSpacing: -1.7,
    lineHeight: 40,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  modeSwitch: {
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    flexDirection: 'row',
    padding: 4,
  },
  modeOption: {
    alignItems: 'center',
    borderRadius: radii.pill,
    flex: 1,
    paddingVertical: 10,
  },
  modeOptionActive: {
    backgroundColor: palette.card,
  },
  modeText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '900',
  },
  modeTextActive: {
    color: palette.ink,
  },
  roleSection: {
    gap: spacing.sm,
  },
  roleRow: {
    gap: spacing.sm,
  },
  roleOption: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  roleOptionActive: {
    backgroundColor: palette.dark,
    borderColor: palette.dark,
  },
  roleIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: 999,
    height: 35,
    justifyContent: 'center',
    width: 35,
  },
  roleIconActive: {
    backgroundColor: palette.accent,
  },
  roleCopy: {
    flex: 1,
    gap: 3,
  },
  roleTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  roleTitleActive: {
    color: '#FFFFFF',
  },
  roleDetail: {
    color: palette.muted,
    fontSize: 9,
  },
  roleDetailActive: {
    color: palette.darkMuted,
  },
  field: {
    gap: 7,
  },
  fieldHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  label: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  hint: {
    color: palette.muted,
    fontSize: 9,
  },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  inputError: {
    borderColor: palette.accent,
  },
  error: {
    color: palette.accentDeep,
    fontSize: 9,
    fontWeight: '700',
  },
  forgotButton: {
    alignSelf: 'flex-end',
  },
  forgotText: {
    color: palette.accentDeep,
    fontSize: 10,
    fontWeight: '900',
  },
  termsRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
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
  checkboxActive: {
    backgroundColor: palette.success,
    borderColor: palette.success,
  },
  termsText: {
    color: palette.muted,
    flex: 1,
    fontSize: 10,
    lineHeight: 16,
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    paddingVertical: 14,
  },
  submitText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  securityNote: {
    alignItems: 'flex-start',
    backgroundColor: palette.successSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  securityText: {
    color: palette.success,
    flex: 1,
    fontSize: 9,
    lineHeight: 15,
  },
});
