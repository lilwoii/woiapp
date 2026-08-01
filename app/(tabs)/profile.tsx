import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { SectionHeading } from '@/components/section-heading';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { confirmAction, showMessage } from '@/lib/platform-dialog';
import { AccountRole } from '@/types/marketplace';

type SettingsRowProps = {
  icon: keyof typeof FontAwesome6.glyphMap;
  title: string;
  detail: string;
  danger?: boolean;
  onPress: () => void;
};

function SettingsRow({ icon, title, detail, danger = false, onPress }: SettingsRowProps) {
  return (
    <Pressable
      accessibilityLabel={`${title}. ${detail}`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.settingsRow}>
      <View style={[styles.settingsIcon, danger && styles.dangerIcon]}>
        <FontAwesome6 color={danger ? palette.accentDeep : palette.ink} name={icon} size={14} />
      </View>
      <View style={styles.settingsCopy}>
        <Text style={[styles.settingsTitle, danger && styles.dangerText]}>{title}</Text>
        <Text style={styles.settingsDetail}>{detail}</Text>
      </View>
      <FontAwesome6 color={palette.mutedLight} name="chevron-right" size={11} />
    </Pressable>
  );
}

export default function ProfileScreen() {
  const auth = useAuth();
  const { account, followedIds, setRole } = useMarketplaceStore();
  const [accountMessage, setAccountMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null
  );
  const signedIn = auth.status === 'authenticated';
  const preview = auth.status === 'preview';
  const initials = account.displayName
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toLocaleUpperCase('en-US');

  const openSupport = async () => {
    const value = process.env.EXPO_PUBLIC_SUPPORT_URL;
    try {
      const url = new URL(value ?? '');
      if (url.protocol !== 'https:') throw new Error('invalid support URL');
      await Linking.openURL(url.toString());
    } catch {
      showMessage(
        'Support is not configured',
        'The production support destination has not been connected in this preview.'
      );
    }
  };

  const deleteAccount = async () => {
    if (!signedIn) {
      router.push('/auth');
      return;
    }
    if (auth.assuranceLevel !== 'aal2') {
      setAccountMessage({
        type: 'error',
        text: 'Verify an authenticator code in Security before deleting your account.',
      });
      router.push('/security');
      return;
    }
    const confirmed = await confirmAction({
      title: 'Delete your Spottr account?',
      message:
        'This immediately removes your profile, reviews, follows, uploads, and private account data. A business with no other owner is archived. This cannot be undone.',
      confirmLabel: 'Delete account',
      destructive: true,
    });
    if (!confirmed) return;
    const result = await auth.deleteAccount();
    setAccountMessage({
      type: result.ok ? 'success' : 'error',
      text: result.ok ? result.message ?? 'Deletion request accepted.' : result.reason,
    });
  };

  const toggleSession = async () => {
    setAccountMessage(null);
    if (!signedIn) {
      router.push('/auth');
      return;
    }
    const result = await auth.signOut();
    if (!result.ok) setAccountMessage({ type: 'error', text: result.reason });
  };

  return (
    <FocusAwareScreen>
      <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell narrow>
        <View style={styles.topbar}>
          <BrandMark />
          <View style={styles.demoBadge}>
            <View style={styles.demoDot} />
            <Text style={styles.demoText}>
              {signedIn ? 'Verified session' : preview ? 'Secure preview' : 'Guest'}
            </Text>
          </View>
        </View>

        <View style={styles.profileHeader}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials || 'S'}</Text>
          </View>
          <View style={styles.profileCopy}>
            <Text style={styles.displayName}>{account.displayName}</Text>
            <Text style={styles.username}>@{account.username}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(signedIn ? '/security' : '/auth')}
            style={styles.editButton}>
            <Text style={styles.editButtonText}>{signedIn ? 'Security' : 'Sign in'}</Text>
          </Pressable>
        </View>

        <View style={styles.profileStats}>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatValue}>{followedIds.length}</Text>
            <Text style={styles.profileStatLabel}>Following</Text>
          </View>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatValue}>{account.emailVerified ? 'Yes' : '—'}</Text>
            <Text style={styles.profileStatLabel}>Email verified</Text>
          </View>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatValue}>{account.role === 'business' ? 'Business' : 'Customer'}</Text>
            <Text style={styles.profileStatLabel}>Access</Text>
          </View>
        </View>

        {preview ? (
          <View style={styles.rolePanel}>
          <SectionHeading
            detail="Customer and business tools stay in one account."
            eyebrow="Account mode"
            title="How are you using Spottr?"
          />
          <View style={styles.roleSwitch}>
            {(
              [
                ['customer', 'Customer', 'heart'],
                ['business', 'Business', 'store'],
              ] as [AccountRole, string, keyof typeof FontAwesome6.glyphMap][]
            ).map(([role, label, icon]) => {
              const active = account.role === role;
              return (
                <Pressable
                  key={role}
                  onPress={() => setRole(role)}
                  style={[styles.roleOption, active && styles.roleOptionActive]}>
                  <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={icon} size={14} solid={active} />
                  <Text style={[styles.roleText, active && styles.roleTextActive]}>{label}</Text>
                  {active ? <FontAwesome6 color={palette.mint} name="circle-check" size={13} solid /> : null}
                </Pressable>
              );
            })}
          </View>
          </View>
        ) : (
          <View style={styles.rolePanel}>
            <SectionHeading
              detail="Business privileges come only from verified memberships."
              eyebrow="Account access"
              title={account.role === 'business' ? 'Business tools enabled' : 'Customer account'}
            />
            {account.role !== 'business' ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/business-onboarding')}
                style={styles.claimButton}>
                <FontAwesome6 color={palette.ink} name="store" size={13} />
                <Text style={styles.claimButtonText}>Add or claim a business</Text>
              </Pressable>
            ) : null}
          </View>
        )}

        <View style={styles.section}>
          <SectionHeading eyebrow="Settings" title="Account & privacy" />
          <View style={styles.settingGroup}>
            <SettingsRow
              detail="Email verification, password recovery, and sessions"
              icon="user-shield"
              onPress={() => router.push(signedIn ? '/security' : '/auth')}
              title="Sign-in & security"
            />
            <SettingsRow
              detail="Choose alerts for businesses you follow"
              icon="bell"
              onPress={() => router.push('/saved')}
              title="Following alerts"
            />
            <SettingsRow
              detail="How precise location is processed for nearby results"
              icon="location-dot"
              onPress={() => router.push('/privacy')}
              title="Location privacy"
            />
            <SettingsRow
              detail="Blocked accounts and content reports"
              icon="shield-heart"
              onPress={() => router.push('/safety')}
              title="Safety controls"
            />
            <SettingsRow
              detail="Terms, privacy policy, and community rules"
              icon="file-shield"
              onPress={() =>
                router.push({ pathname: '/legal', params: { document: 'terms' } })
              }
              title="Policies"
            />
            <SettingsRow
              detail="Open the staffed Spottr support destination"
              icon="life-ring"
              onPress={() => void openSupport()}
              title="Help & support"
            />
            <SettingsRow
              detail="Download a copy of your Spottr data"
              icon="download"
              onPress={() => router.push('/account-data')}
              title="Export my data"
            />
            <SettingsRow
              danger
              detail="Required in-app deletion removes your account and private data"
              icon="trash-can"
              onPress={() => void deleteAccount()}
              title="Delete account"
            />
          </View>
        </View>

        <View style={styles.safetyPanel}>
          <View style={styles.safetyIcon}>
            <FontAwesome6 color={palette.success} name="shield-halved" size={19} />
          </View>
          <View style={styles.safetyCopy}>
            <Text style={styles.safetyTitle}>Built for trust at scale</Text>
            <Text style={styles.safetyBody}>
              Business changes require verified roles. Reviews use account identity, rate limits, reporting, and moderation.
              Public home-kitchen locations stay approximate and appear only where legally enabled.
            </Text>
          </View>
        </View>

        {accountMessage ? (
          <View
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={[styles.accountMessage, accountMessage.type === 'success' && styles.accountMessageSuccess]}>
            <Text
              style={[
                styles.accountMessageText,
                accountMessage.type === 'success' && styles.accountMessageTextSuccess,
              ]}>
              {accountMessage.text}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          disabled={auth.isBusy}
          onPress={() => void toggleSession()}
          style={[styles.primaryButton, auth.isBusy && styles.primaryButtonDisabled]}>
          {auth.isBusy ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <>
              <Text style={styles.primaryButtonText}>{signedIn ? 'Sign out' : 'Sign in or create an account'}</Text>
              <FontAwesome6 color="#FFFFFF" name={signedIn ? 'arrow-right-from-bracket' : 'arrow-right'} size={13} />
            </>
          )}
        </Pressable>

        <Text style={styles.version}>Spottr · Version 0.2</Text>
      </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    paddingBottom: 132,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  demoBadge: {
    alignItems: 'center',
    backgroundColor: palette.successSoft,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  demoDot: {
    backgroundColor: palette.success,
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  demoText: {
    color: palette.success,
    fontSize: 10,
    fontWeight: '900',
  },
  profileHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xxxl,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: palette.dark,
    borderRadius: 999,
    height: 68,
    justifyContent: 'center',
    width: 68,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
  },
  profileCopy: {
    flex: 1,
    gap: 4,
  },
  displayName: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.6,
  },
  username: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  editButton: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  editButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  profileStats: {
    borderBottomColor: palette.line,
    borderTopColor: palette.line,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    flexDirection: 'row',
    marginTop: spacing.xl,
  },
  profileStat: {
    flex: 1,
    gap: 4,
    paddingVertical: spacing.lg,
  },
  profileStatValue: {
    color: palette.ink,
    fontSize: 22,
    fontWeight: '900',
  },
  profileStatLabel: {
    color: palette.muted,
    fontSize: 10,
  },
  rolePanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    marginTop: spacing.xxl,
    padding: spacing.lg,
  },
  roleSwitch: {
    gap: spacing.sm,
  },
  claimButton: {
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
  claimButtonText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
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
  roleText: {
    color: palette.ink,
    flex: 1,
    fontSize: 13,
    fontWeight: '900',
  },
  roleTextActive: {
    color: '#FFFFFF',
  },
  section: {
    gap: spacing.lg,
    marginTop: spacing.xxxl,
  },
  settingGroup: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  settingsRow: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  settingsIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  dangerIcon: {
    backgroundColor: palette.accentSoft,
  },
  settingsCopy: {
    flex: 1,
    gap: 3,
  },
  settingsTitle: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  dangerText: {
    color: palette.accentDeep,
  },
  settingsDetail: {
    color: palette.muted,
    fontSize: 10,
    lineHeight: 15,
  },
  safetyPanel: {
    alignItems: 'flex-start',
    backgroundColor: palette.successSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xxxl,
    padding: spacing.lg,
  },
  safetyIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  safetyCopy: {
    flex: 1,
    gap: 5,
  },
  safetyTitle: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  safetyBody: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  accountMessage: {
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    marginTop: spacing.xl,
    padding: spacing.md,
  },
  accountMessageSuccess: {
    backgroundColor: palette.successSoft,
  },
  accountMessageText: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  accountMessageTextSuccess: {
    color: palette.success,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    marginTop: spacing.xl,
    minHeight: 52,
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  primaryButtonDisabled: {
    opacity: 0.58,
  },
  version: {
    color: palette.mutedLight,
    fontSize: 10,
    marginTop: spacing.xl,
    textAlign: 'center',
  },
});
