import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { PageShell } from '@/components/page-shell';
import { SectionHeading } from '@/components/section-heading';
import { palette, radii, spacing } from '@/constants/theme';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { AccountRole } from '@/types/marketplace';

type SettingsRowProps = {
  icon: keyof typeof FontAwesome6.glyphMap;
  title: string;
  detail: string;
  danger?: boolean;
};

function SettingsRow({ icon, title, detail, danger = false }: SettingsRowProps) {
  return (
    <Pressable style={styles.settingsRow}>
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
  const { account, followedIds, setRole } = useMarketplaceStore();
  const [locationPersonalization, setLocationPersonalization] = useState(true);
  const [productEmails, setProductEmails] = useState(false);
  const [quietHours, setQuietHours] = useState(true);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell narrow>
        <View style={styles.topbar}>
          <BrandMark />
          <View style={styles.demoBadge}>
            <View style={styles.demoDot} />
            <Text style={styles.demoText}>Secure preview</Text>
          </View>
        </View>

        <View style={styles.profileHeader}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>MR</Text>
          </View>
          <View style={styles.profileCopy}>
            <Text style={styles.displayName}>{account.displayName}</Text>
            <Text style={styles.username}>@{account.username}</Text>
          </View>
          <Link href="/auth" asChild>
            <Pressable style={styles.editButton}>
              <Text style={styles.editButtonText}>Account</Text>
            </Pressable>
          </Link>
        </View>

        <View style={styles.profileStats}>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatValue}>{followedIds.length}</Text>
            <Text style={styles.profileStatLabel}>Following</Text>
          </View>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatValue}>12</Text>
            <Text style={styles.profileStatLabel}>Reviews</Text>
          </View>
          <View style={styles.profileStat}>
            <Text style={styles.profileStatValue}>4</Text>
            <Text style={styles.profileStatLabel}>Lists</Text>
          </View>
        </View>

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

        <View style={styles.section}>
          <SectionHeading eyebrow="Preferences" title="Discovery & alerts" />
          <View style={styles.settingGroup}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleCopy}>
                <Text style={styles.toggleTitle}>Nearby personalization</Text>
                <Text style={styles.toggleDetail}>Use location only while the app is open. Search history is not stored.</Text>
              </View>
              <Switch
                onValueChange={setLocationPersonalization}
                thumbColor="#FFFFFF"
                trackColor={{ false: palette.line, true: palette.success }}
                value={locationPersonalization}
              />
            </View>
            <View style={styles.toggleRow}>
              <View style={styles.toggleCopy}>
                <Text style={styles.toggleTitle}>Quiet hours</Text>
                <Text style={styles.toggleDetail}>Hold non-urgent alerts from 10:00 PM to 8:00 AM.</Text>
              </View>
              <Switch
                onValueChange={setQuietHours}
                thumbColor="#FFFFFF"
                trackColor={{ false: palette.line, true: palette.success }}
                value={quietHours}
              />
            </View>
            <View style={styles.toggleRow}>
              <View style={styles.toggleCopy}>
                <Text style={styles.toggleTitle}>Product emails</Text>
                <Text style={styles.toggleDetail}>Occasional launches and neighborhood guides.</Text>
              </View>
              <Switch
                onValueChange={setProductEmails}
                thumbColor="#FFFFFF"
                trackColor={{ false: palette.line, true: palette.success }}
                value={productEmails}
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeading eyebrow="Settings" title="Account & privacy" />
          <View style={styles.settingGroup}>
            <SettingsRow
              detail="Email, password, username, and passkeys"
              icon="user-shield"
              title="Sign-in & security"
            />
            <SettingsRow
              detail="Precise location is never saved to your profile"
              icon="location-dot"
              title="Location privacy"
            />
            <SettingsRow
              detail="Blocked accounts and content reports"
              icon="shield-heart"
              title="Safety controls"
            />
            <SettingsRow
              detail="Download a copy of your Spottr data"
              icon="download"
              title="Export my data"
            />
            <SettingsRow
              danger
              detail="Required in-app deletion removes your account and private data"
              icon="trash-can"
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

        <Link href="/auth" asChild>
          <Pressable style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Open sign-in & account demo</Text>
            <FontAwesome6 color="#FFFFFF" name="arrow-right" size={13} />
          </Pressable>
        </Link>

        <Text style={styles.version}>Spottr preview · Version 0.1</Text>
      </PageShell>
    </ScrollView>
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
  toggleRow: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  toggleCopy: {
    flex: 1,
    gap: 4,
  },
  toggleTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  toggleDetail: {
    color: palette.muted,
    fontSize: 10,
    lineHeight: 15,
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
  primaryButton: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    marginTop: spacing.xl,
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  version: {
    color: palette.mutedLight,
    fontSize: 10,
    marginTop: spacing.xl,
    textAlign: 'center',
  },
});
