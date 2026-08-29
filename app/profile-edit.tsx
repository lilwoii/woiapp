import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { featureFlags } from '@/lib/features';
import { checkProfessionalText } from '@/lib/moderation';
import { loadOwnSocialProfile, updateOwnSocialProfile, uploadProfileBanner, type SocialProfileWorkspace } from '@/lib/social-profile';
import type { PublicProfileLink } from '@/types/social';

type Notice = { tone: 'error' | 'success'; text: string } | null;

export default function ProfileEditScreen() {
  const auth = useAuth();
  const accountId = auth.account?.id;
  const [workspace, setWorkspace] = useState<SocialProfileWorkspace | null>(null);
  const [bio, setBio] = useState('');
  const [links, setLinks] = useState<PublicProfileLink[]>([]);
  const [showFavorites, setShowFavorites] = useState(true);
  const [showFollowing, setShowFollowing] = useState(true);
  const [allowBusinessInvitations, setAllowBusinessInvitations] = useState(false);
  const [selectedBannerId, setSelectedBannerId] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let current = true;
    if (!accountId || auth.status !== 'authenticated') return () => { current = false; };
    void loadOwnSocialProfile(accountId).then((result) => {
      if (!current) return;
      if (!result.ok || !result.data) {
        setNotice({ tone: 'error', text: result.ok ? 'Profile unavailable.' : result.reason });
        return;
      }
      setWorkspace(result.data);
      setBio(result.data.bio);
      setLinks(result.data.links);
      setShowFavorites(result.data.showFavorites);
      setShowFollowing(result.data.showFollowing);
      setAllowBusinessInvitations(result.data.allowBusinessInvitations);
    });
    return () => { current = false; };
  }, [accountId, auth.status]);

  const changeLink = (index: number, field: keyof PublicProfileLink, value: string) => {
    setLinks((current) => current.map((link, offset) => offset === index ? { ...link, [field]: value } : link));
  };

  const chooseBanner = async () => {
    if (!accountId || !workspace?.bannerUnlocked || uploading) return;
    if (!featureFlags.mediaUploads) {
      setNotice({
        tone: 'error',
        text: 'New profile images are not available in this release. Previously approved banners can still be selected.',
      });
      return;
    }
    setNotice(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice({ tone: 'error', text: 'Photo access is required to choose a profile banner.' });
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [3, 1],
      quality: 0.9,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const image = picked.assets[0];
    const ratio = image.width / image.height;
    if (image.width < 900 || image.height < 300 || ratio < 1.8 || ratio > 5) {
      setNotice({ tone: 'error', text: 'Choose a wide image at least 900 × 300 pixels.' });
      return;
    }
    setUploading(true);
    const result = await uploadProfileBanner({ uri: image.uri, mimeType: image.mimeType, fileSize: image.fileSize }, accountId);
    setUploading(false);
    setNotice({
      tone: result.ok ? 'success' : 'error',
      text: result.ok
        ? 'Banner uploaded securely. It will appear here after automated scanning and moderation; return to select it.'
        : result.reason,
    });
  };

  const save = async () => {
    if (!accountId || saving) return;
    setNotice(null);
    if (bio.trim()) {
      const professional = checkProfessionalText(bio, 240);
      if (!professional.ok) {
        setNotice({ tone: 'error', text: professional.reason });
        return;
      }
    }
    const normalizedLinks = links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.label || link.url);
    if (normalizedLinks.some((link) => !link.label || !/^https:\/\/[A-Za-z0-9]/.test(link.url))) {
      setNotice({ tone: 'error', text: 'Each profile link needs a short label and a complete HTTPS address.' });
      return;
    }
    setSaving(true);
    const result = await updateOwnSocialProfile({
      bio,
      links: normalizedLinks,
      showFavorites,
      showFollowing,
      allowBusinessInvitations,
      ...(selectedBannerId !== undefined ? { bannerAssetId: selectedBannerId } : {}),
    }, accountId);
    setSaving(false);
    setNotice({ tone: result.ok ? 'success' : 'error', text: result.ok ? result.message ?? 'Profile updated.' : result.reason });
    if (result.ok) {
      setSelectedBannerId(undefined);
      setWorkspace((current) => current ? { ...current, allowBusinessInvitations } : current);
    }
  };

  if (auth.status !== 'authenticated') {
    return (
      <FocusAwareScreen>
        <View role="main" style={styles.centered}>
          <Text accessibilityRole="header" style={styles.title}>Sign in to edit your profile</Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/auth')} style={styles.primary}><Text style={styles.primaryText}>Sign in</Text></Pressable>
        </View>
      </FocusAwareScreen>
    );
  }
  if (auth.assuranceLevel !== 'aal2') {
    return (
      <FocusAwareScreen>
        <View role="main" style={styles.centered}>
          <View style={styles.lockIcon}><FontAwesome6 color={palette.accentDeep} name="shield-halved" size={20} /></View>
          <Text accessibilityRole="header" style={styles.title}>Security check required</Text>
          <Text style={styles.centerBody}>Verify your authenticator code before changing public profile details.</Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/security')} style={styles.primary}><Text style={styles.primaryText}>Open Security</Text></Pressable>
        </View>
      </FocusAwareScreen>
    );
  }

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}><FontAwesome6 color={palette.ink} name="arrow-left" size={13} /></Pressable>
            <Text style={styles.topbarTitle}>Public profile</Text><View style={styles.topbarSpacer} />
          </View>
          <View style={styles.hero}><Text accessibilityRole="header" style={styles.heroTitle}>Make your food story yours.</Text><Text style={styles.heroBody}>Your username remains unique. Only the profile details shown here become public.</Text></View>

          {!workspace && !notice ? <View style={styles.loading}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.help}>Loading secure profile settings…</Text></View> : null}

          {workspace ? (
            <>
              <View style={styles.section}>
                <Text style={styles.label}>Bio</Text>
                <TextInput accessibilityLabel="Profile bio" maxLength={240} multiline onChangeText={setBio} placeholder="Share what you love to discover…" placeholderTextColor={palette.mutedLight} style={styles.bioInput} value={bio} />
                <Text style={styles.counter}>{bio.length}/240</Text>
              </View>

              <View style={styles.section}>
                <View style={styles.sectionHeading}><View><Text style={styles.label}>Links</Text><Text style={styles.help}>Up to three verified HTTPS destinations.</Text></View>{links.length < 3 ? <Pressable accessibilityRole="button" onPress={() => setLinks((current) => [...current, { label: '', url: 'https://' }])}><Text style={styles.addLink}>+ Add link</Text></Pressable> : null}</View>
                {links.map((link, index) => (
                  <View key={index} style={styles.linkEditor}>
                    <TextInput accessibilityLabel={`Link ${index + 1} label`} maxLength={40} onChangeText={(value) => changeLink(index, 'label', value)} placeholder="Instagram" placeholderTextColor={palette.mutedLight} style={styles.linkLabelInput} value={link.label} />
                    <TextInput accessibilityLabel={`Link ${index + 1} address`} autoCapitalize="none" keyboardType="url" maxLength={500} onChangeText={(value) => changeLink(index, 'url', value)} placeholder="https://…" placeholderTextColor={palette.mutedLight} style={styles.linkUrlInput} value={link.url} />
                    <Pressable accessibilityLabel={`Remove link ${index + 1}`} accessibilityRole="button" onPress={() => setLinks((current) => current.filter((_, offset) => offset !== index))} style={styles.removeLink}><FontAwesome6 color={palette.muted} name="xmark" size={11} /></Pressable>
                  </View>
                ))}
              </View>

              <View style={styles.section}>
                <Text style={styles.label}>Profile banner</Text>
                <Text style={styles.help}>{workspace.bannerUnlocked ? featureFlags.mediaUploads ? 'Unlocked. Wide images are scanned before they can be selected.' : 'Unlocked. New uploads stay off until the safety pipeline is approved; previously approved banners remain selectable.' : `${workspace.approvedReviewCount}/10 approved reviews — unlocks at 10.`}</Text>
                {workspace.bannerUrl && selectedBannerId === undefined ? <Image source={{ uri: workspace.bannerUrl }} style={styles.bannerPreview} /> : null}
                {workspace.approvedBanners.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.bannerChoices}>{workspace.approvedBanners.map((candidate) => { const selected = selectedBannerId === candidate.assetId; return <Pressable accessibilityLabel="Select approved profile banner" accessibilityRole="button" accessibilityState={{ selected }} key={candidate.assetId} onPress={() => setSelectedBannerId(candidate.assetId)} style={[styles.bannerChoice, selected && styles.bannerChoiceActive]}><Image source={{ uri: candidate.url }} style={styles.bannerChoiceImage} /></Pressable>; })}</View></ScrollView> : null}
                <View style={styles.bannerActions}>
                  <Pressable accessibilityRole="button" accessibilityState={{ disabled: !workspace.bannerUnlocked || !featureFlags.mediaUploads, busy: uploading }} disabled={!workspace.bannerUnlocked || !featureFlags.mediaUploads || uploading} onPress={() => void chooseBanner()} style={[styles.secondary, (!workspace.bannerUnlocked || !featureFlags.mediaUploads) && styles.disabled]}>{uploading ? <ActivityIndicator color={palette.ink} size="small" /> : <Text style={styles.secondaryText}>{featureFlags.mediaUploads ? 'Upload new' : 'Upload gated'}</Text>}</Pressable>
                  {(workspace.bannerUrl || selectedBannerId) ? <Pressable accessibilityRole="button" onPress={() => setSelectedBannerId(null)} style={styles.secondary}><Text style={styles.secondaryText}>Remove</Text></Pressable> : null}
                </View>
              </View>

              <View style={styles.section}>
                <Text style={styles.label}>Visible collections</Text>
                <View style={styles.visibilityGroup}>
                  <View style={styles.visibilityRow}><View style={styles.visibilityCopy}><Text style={styles.visibilityTitle}>Favorites</Text><Text style={styles.help}>Let people browse businesses you follow.</Text></View><Switch accessibilityLabel="Show favorites" onValueChange={setShowFavorites} trackColor={{ false: palette.line, true: palette.mint }} thumbColor={showFavorites ? palette.success : '#FFFFFF'} value={showFavorites} /></View>
                  <View style={styles.visibilityRow}><View style={styles.visibilityCopy}><Text style={styles.visibilityTitle}>Following</Text><Text style={styles.help}>Let people browse members you follow.</Text></View><Switch accessibilityLabel="Show following" onValueChange={setShowFollowing} trackColor={{ false: palette.line, true: palette.mint }} thumbColor={showFollowing ? palette.success : '#FFFFFF'} value={showFollowing} /></View>
                  <View style={styles.visibilityRow}><View style={styles.visibilityCopy}><Text style={styles.visibilityTitle}>Business invitations</Text><Text style={styles.help}>Allow verified businesses to privately invite you after 10 approved reviews. An invitation can never require a review.</Text></View><Switch accessibilityLabel="Allow verified business invitations" onValueChange={setAllowBusinessInvitations} trackColor={{ false: palette.line, true: palette.mint }} thumbColor={allowBusinessInvitations ? palette.success : '#FFFFFF'} value={allowBusinessInvitations} /></View>
                </View>
              </View>
            </>
          ) : null}

          {notice ? <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.notice, notice.tone === 'success' && styles.noticeSuccess]}><Text style={[styles.noticeText, notice.tone === 'success' && styles.noticeTextSuccess]}>{notice.text}</Text></View> : null}
          {workspace ? <Pressable accessibilityRole="button" accessibilityState={{ busy: saving }} disabled={saving} onPress={() => void save()} style={[styles.primary, saving && styles.disabled]}>{saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Save public profile</Text>}</Pressable> : null}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 }, content: { paddingBottom: 120, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  centered: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl }, centerBody: { color: palette.muted, fontSize: 11, lineHeight: 17, maxWidth: 420, textAlign: 'center' }, lockIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: 24, height: 48, justifyContent: 'center', width: 48 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, iconButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, topbarTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' }, topbarSpacer: { width: 42 },
  hero: { marginTop: spacing.xxxl }, heroTitle: { color: palette.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1 }, heroBody: { color: palette.muted, fontSize: 11, lineHeight: 18, marginTop: spacing.sm }, loading: { alignItems: 'center', gap: spacing.sm, marginTop: spacing.xxxl },
  section: { gap: spacing.sm, marginTop: spacing.xxl }, sectionHeading: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between' }, label: { color: palette.ink, fontSize: 13, fontWeight: '900' }, help: { color: palette.muted, fontSize: 9, lineHeight: 14 },
  bioInput: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, color: palette.ink, fontSize: 12, minHeight: 112, padding: spacing.md, textAlignVertical: 'top' }, counter: { color: palette.mutedLight, fontSize: 9, textAlign: 'right' },
  addLink: { color: palette.accentDeep, fontSize: 10, fontWeight: '900' }, linkEditor: { alignItems: 'center', flexDirection: 'row', gap: 7 }, linkLabelInput: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 10, padding: 12, width: 105 }, linkUrlInput: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, flex: 1, fontSize: 10, padding: 12 }, removeLink: { alignItems: 'center', height: 40, justifyContent: 'center', width: 28 },
  bannerPreview: { borderRadius: radii.lg, height: 126, width: '100%' }, bannerChoices: { flexDirection: 'row', gap: spacing.sm }, bannerChoice: { borderColor: 'transparent', borderRadius: radii.md, borderWidth: 2, overflow: 'hidden', padding: 2 }, bannerChoiceActive: { borderColor: palette.accentDeep }, bannerChoiceImage: { borderRadius: radii.sm, height: 72, width: 150 }, bannerActions: { flexDirection: 'row', gap: spacing.sm },
  visibilityGroup: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, overflow: 'hidden' }, visibilityRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.md, minHeight: 72, padding: spacing.md }, visibilityCopy: { flex: 1, gap: 3 }, visibilityTitle: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  primary: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: radii.pill, justifyContent: 'center', marginTop: spacing.xl, minHeight: 52, paddingHorizontal: spacing.xl }, primaryText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' }, secondary: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center', minHeight: 42, minWidth: 100, paddingHorizontal: spacing.md }, secondaryText: { color: palette.ink, fontSize: 10, fontWeight: '900' }, disabled: { opacity: 0.55 },
  notice: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginTop: spacing.xl, padding: spacing.md }, noticeSuccess: { backgroundColor: palette.successSoft }, noticeText: { color: palette.accentDeep, fontSize: 10, fontWeight: '700', lineHeight: 16 }, noticeTextSuccess: { color: palette.success }, title: { color: palette.ink, fontSize: 22, fontWeight: '900', textAlign: 'center' },
});
