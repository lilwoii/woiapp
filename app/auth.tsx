import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { validatePassword, validateUsername } from '@/lib/moderation';
import { AccountRole } from '@/types/marketplace';

type Mode = 'signup' | 'signin';

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
  accessibilityHint,
  autoComplete,
  onToggleSecure,
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
  accessibilityHint?: string;
  autoComplete?: 'email' | 'name' | 'new-password' | 'current-password' | 'username';
  onToggleSecure?: () => void;
}) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHeader}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View style={styles.inputWrap}>
        <TextInput
          accessibilityHint={accessibilityHint}
          accessibilityLabel={label}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          autoCorrect={false}
          keyboardType={keyboardType}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={palette.mutedLight}
          secureTextEntry={secureTextEntry}
          style={[styles.input, onToggleSecure && styles.inputWithAction, error ? styles.inputError : null]}
          value={value}
        />
        {onToggleSecure ? (
          <Pressable
            accessibilityLabel={secureTextEntry ? 'Show password' : 'Hide password'}
            accessibilityRole="button"
            onPress={onToggleSecure}
            style={styles.inputAction}>
            <FontAwesome6 color={palette.muted} name={secureTextEntry ? 'eye' : 'eye-slash'} size={14} />
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export default function AuthScreen() {
  const auth = useAuth();
  const { error_description: callbackError, next, verified } = useLocalSearchParams<{
    error_description?: string;
    next?: string;
    verified?: string;
  }>();
  const checkUsername = auth.checkUsername;
  const handledVerification = useRef(false);
  const [mode, setMode] = useState<Mode>('signup');
  const [role, setRole] = useState<AccountRole>('customer');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [formMessage, setFormMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null
  );
  const [usernameAvailability, setUsernameAvailability] = useState<
    'idle' | 'checking' | 'available' | 'unavailable'
  >('idle');

  const usernameError = useMemo(
    () => (mode === 'signup' && username ? validateUsername(username, []) : null),
    [mode, username]
  );

  const emailError =
    submitted && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Enter a valid email address.' : null;
  const passwordError =
    submitted && mode === 'signup'
      ? password
        ? validatePassword(password)
        : 'Enter your password.'
      : submitted && !password
        ? 'Enter your password.'
        : null;
  const displayNameError = submitted && mode === 'signup' && !displayName.trim() ? 'Add your display name.' : null;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (typeof callbackError === 'string' && callbackError) {
      timer = setTimeout(() => {
        setFormMessage({
          type: 'error',
          text: 'This verification link is invalid or expired. Sign in or request a new email.',
        });
      }, 0);
    } else if (verified === '1' && !handledVerification.current && auth.status === 'authenticated') {
      handledVerification.current = true;
      router.replace(next === 'business-onboarding' ? '/business-onboarding' : '/');
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [auth.status, callbackError, next, verified]);

  useEffect(() => {
    let active = true;
    const invalid = mode !== 'signup' || !username || Boolean(validateUsername(username, []));
    const timer = setTimeout(() => {
      if (invalid) {
        setUsernameAvailability('idle');
        return;
      }
      setUsernameAvailability('checking');
      void checkUsername(username).then((result) => {
        if (!active) return;
        setUsernameAvailability(
          result.ok && result.data?.available ? 'available' : result.ok ? 'unavailable' : 'idle'
        );
      });
    }, invalid ? 0 : 450);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [checkUsername, mode, username]);

  const submit = async () => {
    setSubmitted(true);
    setFormMessage(null);

    if (mode === 'signup') {
      const usernameValidation = validateUsername(username, []);
      if (
        usernameValidation ||
        !displayName.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        validatePassword(password) ||
        !accepted
      ) {
        if (!accepted) {
          setFormMessage({
            type: 'error',
            text: 'Review and accept the Terms and Privacy Policy to continue.',
          });
        }
        return;
      }

      const result = await auth.signUp({
        acceptedTerms: accepted,
        displayName,
        email,
        password,
        role,
        username,
      });
      if (!result.ok) {
        setFormMessage({ type: 'error', text: result.reason });
        return;
      }

      const text = result.message ?? 'Your Spottr account is ready.';
      setFormMessage({ type: 'success', text });
      if (!result.data?.requiresEmailVerification) {
        router.replace(role === 'business' ? '/business-onboarding' : '/');
      }
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !password) return;
    const result = await auth.signIn(email, password);
    if (!result.ok) {
      setFormMessage({ type: 'error', text: result.reason });
      return;
    }
    router.replace(result.data?.requiresMfa ? '/security' : '/');
  };

  const recoverPassword = async () => {
    setSubmitted(true);
    setFormMessage(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFormMessage({ type: 'error', text: 'Enter your email first.' });
      return;
    }
    const result = await auth.requestPasswordReset(email);
    setFormMessage({
      type: result.ok ? 'success' : 'error',
      text: result.ok
        ? result.message ?? 'If that account exists, a recovery link is on the way.'
        : result.reason,
    });
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

          <View style={styles.authCard}>
            <View style={styles.intro}>
              <Text style={styles.eyebrow}>One account, both sides</Text>
              <Text accessibilityRole="header" style={styles.title}>{mode === 'signup' ? 'Join your local food map.' : 'Welcome back.'}</Text>
              <Text style={styles.subtitle}>
                {mode === 'signup'
                  ? 'Follow places, review visits, or manage a verified business from the same secure account.'
                  : 'Sign in with the email connected to your Spottr account.'}
              </Text>
            </View>

            {!auth.isConfigured ? (
              <View accessibilityRole="alert" style={styles.configurationNotice}>
                <FontAwesome6 color={palette.accentDeep} name="circle-info" size={14} />
                <Text style={styles.configurationNoticeText}>
                  Account services are not configured. This build accepts no credentials until the secured backend is connected.
                </Text>
              </View>
            ) : null}

            <View accessibilityRole="tablist" style={styles.modeSwitch}>
              {(
                [
                  ['signup', 'Create account'],
                  ['signin', 'Sign in'],
                ] as [Mode, string][]
              ).map(([id, label]) => (
                <Pressable
                  accessibilityRole="tab"
                  aria-selected={mode === id}
                  accessibilityState={{ selected: mode === id }}
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
                  <View
                    accessibilityLabel="Account type"
                    accessibilityRole="radiogroup"
                    style={styles.roleRow}>
                    {(
                      [
                        ['customer', 'Customer', 'heart', 'Discover and review'],
                        ['business', 'Business', 'store', 'Add or claim a listing'],
                      ] as [AccountRole, string, keyof typeof FontAwesome6.glyphMap, string][]
                    ).map(([id, label, icon, detail]) => {
                      const active = role === id;
                      return (
                        <Pressable
                          accessibilityRole="radio"
                          aria-checked={active}
                          accessibilityState={{ checked: active }}
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
                  autoComplete="name"
                  error={displayNameError}
                  label="Display name"
                  onChangeText={setDisplayName}
                  placeholder="How your name appears"
                  value={displayName}
                />
                <Field
                  autoComplete="username"
                  error={submitted || username ? usernameError : null}
                  hint={
                    usernameAvailability === 'checking'
                      ? 'Checking availability…'
                      : usernameAvailability === 'available'
                        ? 'Available'
                        : usernameAvailability === 'unavailable'
                          ? 'Already taken'
                          : '1–24 characters · unique'
                  }
                  label="Username"
                  onChangeText={setUsername}
                  placeholder="yourname"
                  value={username}
                />
              </>
            ) : null}

            <Field
              autoComplete="email"
              error={emailError}
              keyboardType="email-address"
              label="Email"
              onChangeText={setEmail}
              placeholder="you@example.com"
              value={email}
            />
            <Field
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              error={passwordError}
              hint={mode === 'signup' ? '12+ characters' : undefined}
              label="Password"
              onChangeText={setPassword}
              placeholder={mode === 'signup' ? 'Create a strong password' : 'Enter your password'}
              onToggleSecure={() => setPasswordVisible((current) => !current)}
              secureTextEntry={!passwordVisible}
              value={password}
            />

            {mode === 'signin' ? (
              <Pressable
                accessibilityRole="button"
                disabled={auth.isBusy}
                onPress={recoverPassword}
                style={styles.forgotButton}>
                <Text style={styles.forgotText}>Forgot password?</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="checkbox"
                aria-checked={accepted}
                accessibilityState={{ checked: accepted }}
                onPress={() => setAccepted((current) => !current)}
                style={styles.termsRow}>
                <View style={[styles.checkbox, accepted && styles.checkboxActive]}>
                  {accepted ? <FontAwesome6 color="#FFFFFF" name="check" size={10} /> : null}
                </View>
                <Text style={styles.termsText}>
                  I agree to the Terms, Privacy Policy, community rules, and accurate business information requirements.
                </Text>
              </Pressable>
            )}

            {mode === 'signup' ? (
              <View style={styles.legalLinks}>
                <Pressable
                  accessibilityRole="link"
                  onPress={() => router.push({ pathname: '/legal', params: { document: 'terms' } })}
                  style={styles.legalLink}>
                  <Text style={styles.legalLinkText}>Terms</Text>
                </Pressable>
                <Text style={styles.legalLinkDot}>·</Text>
                <Pressable
                  accessibilityRole="link"
                  onPress={() => router.push({ pathname: '/legal', params: { document: 'privacy' } })}
                  style={styles.legalLink}>
                  <Text style={styles.legalLinkText}>Privacy</Text>
                </Pressable>
                <Text style={styles.legalLinkDot}>·</Text>
                <Pressable
                  accessibilityRole="link"
                  onPress={() => router.push({ pathname: '/legal', params: { document: 'community' } })}
                  style={styles.legalLink}>
                  <Text style={styles.legalLinkText}>Community rules</Text>
                </Pressable>
              </View>
            ) : null}

            {formMessage ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={[styles.formMessage, formMessage.type === 'success' && styles.formMessageSuccess]}>
                <FontAwesome6
                  color={formMessage.type === 'success' ? palette.success : palette.accentDeep}
                  name={formMessage.type === 'success' ? 'circle-check' : 'triangle-exclamation'}
                  size={13}
                  solid
                />
                <Text
                  style={[
                    styles.formMessageText,
                    formMessage.type === 'success' && styles.formMessageTextSuccess,
                  ]}>
                  {formMessage.text}
                </Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={auth.isBusy}
              onPress={submit}
              style={({ pressed }) => [
                styles.submitButton,
                pressed && styles.submitButtonPressed,
                auth.isBusy && styles.submitButtonDisabled,
              ]}>
              {auth.isBusy ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <>
                  <Text style={styles.submitText}>{mode === 'signup' ? 'Create secure account' : 'Sign in'}</Text>
                  <FontAwesome6 color="#FFFFFF" name="arrow-right" size={13} />
                </>
              )}
            </Pressable>

            <View style={styles.securityNote}>
              <FontAwesome6 color={palette.success} name="shield-halved" size={15} />
              <Text style={styles.securityText}>
                Passwords are handled by the authentication provider, never stored in app tables. Business access requires
                verified ownership and authenticator protection.
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
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backSpacer: {
    width: 44,
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
  configurationNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  configurationNoticeText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 16,
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
    justifyContent: 'center',
    minHeight: 44,
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
  inputWrap: {
    position: 'relative',
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
  inputWithAction: {
    paddingRight: 54,
  },
  inputAction: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 5,
    top: 3,
    width: 44,
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
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 4,
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
  legalLinks: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  legalLink: {
    justifyContent: 'center',
    minHeight: 44,
  },
  legalLinkText: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '900',
  },
  legalLinkDot: {
    color: palette.mutedLight,
  },
  formMessage: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  formMessageSuccess: {
    backgroundColor: palette.successSoft,
  },
  formMessageText: {
    color: palette.accentDeep,
    flex: 1,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 16,
  },
  formMessageTextSuccess: {
    color: palette.success,
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
  submitButtonPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.995 }],
  },
  submitButtonDisabled: {
    opacity: 0.62,
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
