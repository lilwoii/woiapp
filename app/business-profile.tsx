import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import {
  type BusinessLogoSelection,
  type BusinessProfileValues,
  type BusinessProfileWorkspace,
  cuisineLabelsFromText,
  loadBusinessProfileWorkspace,
  proposedBusinessProfileValues,
  saveBusinessProfile,
  stageBusinessProfileLogo,
  withdrawBusinessProfileRevision,
} from '@/lib/business-profile';
import { featureFlags } from '@/lib/features';
import { confirmAction } from '@/lib/platform-dialog';

type Notice = { tone: 'error' | 'success'; text: string };

const fieldAccessibility = { accessibilityLabelledBy: undefined };

export default function BusinessProfileScreen() {
  const params = useLocalSearchParams<{ businessId?: string | string[] }>();
  const businessId = Array.isArray(params.businessId)
    ? params.businessId[0]
    : params.businessId;
  const [workspace, setWorkspace] = useState<BusinessProfileWorkspace | null>(null);
  const [values, setValues] = useState<BusinessProfileValues | null>(null);
  const [cuisineText, setCuisineText] = useState('');
  const [logoSelection, setLogoSelection] = useState<BusinessLogoSelection | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    if (!businessId) {
      setNotice({ tone: 'error', text: 'This business profile link is incomplete.' });
      setLoading(false);
      return;
    }
    setLoading(true);
    setNotice(null);
    const result = await loadBusinessProfileWorkspace(businessId);
    setLoading(false);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      return;
    }
    const proposed = proposedBusinessProfileValues(result.data);
    setWorkspace(result.data);
    setValues(proposed);
    setCuisineText(proposed.cuisines.join(', '));
    setLogoPreview(result.data.currentLogoUrl);
    setLogoSelection(null);
  }, [businessId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const update = <K extends keyof BusinessProfileValues>(
    key: K,
    value: BusinessProfileValues[K]
  ) => setValues((current) => (current ? { ...current, [key]: value } : current));

  const pickLogo = async () => {
    if (!featureFlags.mediaUploads) {
      setNotice({
        tone: 'error',
        text: 'Logo changes stay unavailable until private scanning and safe re-encoding are connected.',
      });
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice({ tone: 'error', text: 'Allow photo access to choose a business logo.' });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ['images'],
      quality: 0.9,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return;
    setLogoSelection({
      uri: asset.uri,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
      width: asset.width,
      height: asset.height,
    });
    setLogoPreview(asset.uri);
    setNotice(null);
  };

  const save = async () => {
    if (!businessId || !workspace || !values || saving) return;
    setSaving(true);
    setNotice(null);
    let nextValues = values;
    try {
      nextValues = { ...values, cuisines: cuisineLabelsFromText(cuisineText) };
    } catch (error) {
      setSaving(false);
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Check the cuisine labels and try again.',
      });
      return;
    }

    if (logoSelection) {
      const logoResult = await stageBusinessProfileLogo(
        businessId,
        workspace.state,
        logoSelection
      );
      if (!logoResult.ok) {
        setSaving(false);
        setNotice({ tone: 'error', text: logoResult.reason });
        return;
      }
      nextValues = { ...nextValues, logoAssetId: logoResult.data.assetId };
    }

    const result = await saveBusinessProfile(businessId, workspace.state, nextValues);
    setSaving(false);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      return;
    }
    setNotice({ tone: 'success', text: result.message ?? 'Business profile saved.' });
    await load();
  };

  const withdraw = async () => {
    const revision = workspace?.pendingRevision;
    if (!revision || withdrawing) return;
    const confirmed = await confirmAction({
      title: 'Withdraw pending changes?',
      message: 'The live listing will stay unchanged. You can submit a new revision afterward.',
      confirmLabel: 'Withdraw changes',
      destructive: true,
    });
    if (!confirmed) return;
    setWithdrawing(true);
    setNotice(null);
    const result = await withdrawBusinessProfileRevision(revision.revisionId);
    setWithdrawing(false);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      return;
    }
    setNotice({ tone: 'success', text: result.message ?? 'Pending changes withdrawn.' });
    await load();
  };

  return (
    <FocusAwareScreen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.screen}>
          <PageShell narrow>
            <View style={styles.topbar}>
              <BrandMark />
              <Pressable
                accessibilityLabel="Close business profile"
                accessibilityRole="button"
                onPress={() => router.back()}
                style={styles.closeButton}>
                <FontAwesome6 color={palette.ink} name="xmark" size={15} />
              </Pressable>
            </View>

            <View style={styles.intro}>
              <Text style={styles.eyebrow}>Business identity</Text>
              <Text accessibilityRole="header" style={styles.title}>Keep every public detail trustworthy.</Text>
              <Text style={styles.subtitle}>
                Drafts save privately. Published listing changes stay off the live directory until reviewed.
              </Text>
            </View>

            {loading ? (
              <View accessibilityLiveRegion="polite" style={styles.loading}>
                <ActivityIndicator color={palette.accentDeep} />
                <Text style={styles.loadingText}>Loading protected business details…</Text>
              </View>
            ) : null}

            {notice ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole={notice.tone === 'error' ? 'alert' : undefined}
                style={[styles.notice, notice.tone === 'success' && styles.noticeSuccess]}>
                <FontAwesome6
                  color={notice.tone === 'success' ? palette.success : palette.accentDeep}
                  name={notice.tone === 'success' ? 'circle-check' : 'triangle-exclamation'}
                  size={13}
                />
                <Text style={[styles.noticeText, notice.tone === 'success' && styles.noticeTextSuccess]}>{notice.text}</Text>
              </View>
            ) : null}

            {workspace?.pendingRevision ? (
              <View style={styles.pendingBar}>
                <View style={styles.pendingCopy}>
                  <Text style={styles.pendingTitle}>Changes awaiting review</Text>
                  <Text style={styles.pendingDetail}>
                    Editing this form updates your proposal; the current listing remains live.
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ busy: withdrawing, disabled: withdrawing }}
                  disabled={withdrawing}
                  onPress={() => void withdraw()}
                  style={styles.withdrawButton}>
                  {withdrawing ? <ActivityIndicator color={palette.accentDeep} size="small" /> : null}
                  <Text style={styles.withdrawText}>Withdraw</Text>
                </Pressable>
              </View>
            ) : null}

            {workspace && values ? (
              <View style={styles.form}>
                <View style={styles.identityRow}>
                  <View style={styles.logoFrame}>
                    {logoPreview ? (
                      <Image accessibilityIgnoresInvertColors source={{ uri: logoPreview }} style={styles.logo} />
                    ) : (
                      <FontAwesome6 color={palette.mutedLight} name="store" size={25} />
                    )}
                  </View>
                  <View style={styles.logoCopy}>
                    <Text style={styles.label}>Business logo</Text>
                    <Text style={styles.help}>Square JPEG, PNG, or WebP · 512–2048 px · under 5 MB.</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !featureFlags.mediaUploads }}
                      disabled={!featureFlags.mediaUploads}
                      onPress={() => void pickLogo()}
                      style={[styles.secondaryButton, !featureFlags.mediaUploads && styles.disabled]}>
                      <FontAwesome6 color={palette.ink} name="image" size={11} />
                      <Text style={styles.secondaryButtonText}>{featureFlags.mediaUploads ? 'Choose logo' : 'Upload gated'}</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Public profile</Text>
                  <View style={styles.field}>
                    <Text style={styles.label}>Business name</Text>
                    <TextInput {...fieldAccessibility} accessibilityLabel="Business name" maxLength={100} onChangeText={(text) => update('name', text)} style={styles.input} value={values.name} />
                  </View>
                  <View style={styles.field}>
                    <View style={styles.labelRow}><Text style={styles.label}>Description</Text><Text style={styles.counter}>{values.description.length}/2000</Text></View>
                    <TextInput accessibilityLabel="Business description" maxLength={2000} multiline onChangeText={(text) => update('description', text)} style={[styles.input, styles.textarea]} textAlignVertical="top" value={values.description} />
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>Cuisines</Text>
                    <TextInput accessibilityLabel="Cuisines separated by commas" autoCapitalize="words" maxLength={730} onChangeText={setCuisineText} placeholder="Mexican, Chinese, Desserts" placeholderTextColor={palette.mutedLight} style={styles.input} value={cuisineText} />
                    <Text style={styles.help}>Up to 12 professional labels, separated by commas.</Text>
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>Price level</Text>
                    <View accessibilityRole="radiogroup" style={styles.priceRow}>
                      {([1, 2, 3, 4] as const).map((level) => (
                        <Pressable accessibilityLabel={`${level} dollar price level`} accessibilityRole="radio" aria-checked={values.priceLevel === level} accessibilityState={{ checked: values.priceLevel === level }} key={level} onPress={() => update('priceLevel', level)} style={[styles.priceButton, values.priceLevel === level && styles.priceButtonActive]}>
                          <Text style={[styles.priceText, values.priceLevel === level && styles.priceTextActive]}>{'$'.repeat(level)}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>IANA time zone</Text>
                    <TextInput accessibilityLabel="Business time zone" autoCapitalize="none" autoCorrect={false} maxLength={80} onChangeText={(text) => update('timezone', text)} placeholder="America/Los_Angeles" placeholderTextColor={palette.mutedLight} style={styles.input} value={values.timezone} />
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Private contact and public visibility</Text>
                  <Text style={styles.sectionDetail}>Email stays private. Phone and website appear only when you explicitly enable them.</Text>
                  <View style={styles.field}>
                    <Text style={styles.label}>Business email</Text>
                    <TextInput accessibilityLabel="Private business email" autoCapitalize="none" autoComplete="email" keyboardType="email-address" maxLength={320} onChangeText={(text) => update('businessEmail', text)} style={styles.input} value={values.businessEmail} />
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>Business phone</Text>
                    <TextInput accessibilityLabel="Business phone" autoComplete="tel" keyboardType="phone-pad" maxLength={40} onChangeText={(text) => update('businessPhone', text)} style={styles.input} value={values.businessPhone} />
                  </View>
                  <View style={styles.switchRow}>
                    <View style={styles.switchCopy}><Text style={styles.switchTitle}>Show phone publicly</Text><Text style={styles.help}>Customers can call from the listing.</Text></View>
                    <Switch accessibilityLabel="Show phone publicly" onValueChange={(value) => update('showPhonePublic', value)} trackColor={{ false: palette.line, true: palette.accent }} value={values.showPhonePublic} />
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>HTTPS website</Text>
                    <TextInput accessibilityLabel="Business website" autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={2048} onChangeText={(text) => update('websiteUrl', text)} placeholder="https://example.com" placeholderTextColor={palette.mutedLight} style={styles.input} value={values.websiteUrl} />
                  </View>
                  <View style={styles.switchRow}>
                    <View style={styles.switchCopy}><Text style={styles.switchTitle}>Show website publicly</Text><Text style={styles.help}>Only complete HTTPS addresses are accepted.</Text></View>
                    <Switch accessibilityLabel="Show website publicly" onValueChange={(value) => update('showWebsitePublic', value)} trackColor={{ false: palette.line, true: palette.accent }} value={values.showWebsitePublic} />
                  </View>
                </View>

                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ busy: saving, disabled: saving }}
                  disabled={saving}
                  onPress={() => void save()}
                  style={[styles.saveButton, saving && styles.disabled]}>
                  {saving ? <ActivityIndicator color="#FFFFFF" size="small" /> : <FontAwesome6 color="#FFFFFF" name="shield-halved" size={12} />}
                  <Text style={styles.saveText}>{workspace.state === 'published' ? 'Submit changes for review' : 'Save private draft'}</Text>
                </Pressable>
              </View>
            ) : !loading ? (
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.retryButton}><Text style={styles.retryText}>Try again</Text></Pressable>
            ) : null}
          </PageShell>
        </ScrollView>
      </KeyboardAvoidingView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 88 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: spacing.md },
  closeButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
  intro: { gap: spacing.sm, paddingBottom: spacing.xl, paddingTop: 48 },
  eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: palette.ink, fontSize: 32, fontWeight: '900', letterSpacing: -1.2, lineHeight: 37 },
  subtitle: { color: palette.muted, fontSize: 13, lineHeight: 20, maxWidth: 570 },
  loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 72 },
  loadingText: { color: palette.muted, fontSize: 12 },
  notice: { alignItems: 'flex-start', backgroundColor: palette.accentSoft, borderRadius: radii.md, flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, padding: spacing.md },
  noticeSuccess: { backgroundColor: palette.successSoft },
  noticeText: { color: palette.accentDeep, flex: 1, fontSize: 11, lineHeight: 17 },
  noticeTextSuccess: { color: palette.success },
  pendingBar: { alignItems: 'center', backgroundColor: palette.warningSoft, borderRadius: radii.lg, flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between', marginBottom: spacing.lg, padding: spacing.md },
  pendingCopy: { flex: 1, gap: 4 },
  pendingTitle: { color: palette.warning, fontSize: 12, fontWeight: '900' },
  pendingDetail: { color: palette.muted, fontSize: 10, lineHeight: 15 },
  withdrawButton: { alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.sm },
  withdrawText: { color: palette.accentDeep, fontSize: 10, fontWeight: '900' },
  form: { gap: spacing.xl },
  identityRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.lg, paddingBottom: spacing.xl },
  logoFrame: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.xl, borderWidth: 1, height: 112, justifyContent: 'center', overflow: 'hidden', width: 112 },
  logo: { height: '100%', width: '100%' },
  logoCopy: { flex: 1, gap: 7 },
  section: { borderBottomColor: palette.line, borderBottomWidth: 1, gap: spacing.lg, paddingBottom: spacing.xl },
  sectionTitle: { color: palette.ink, fontSize: 17, fontWeight: '900' },
  sectionDetail: { color: palette.muted, fontSize: 10, lineHeight: 16, marginTop: -spacing.sm },
  field: { gap: 7 },
  labelRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  counter: { color: palette.muted, fontFamily: 'SpaceMono', fontSize: 9 },
  help: { color: palette.muted, fontSize: 9, lineHeight: 14 },
  input: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 13, minHeight: 48, paddingHorizontal: spacing.md, paddingVertical: 12 },
  textarea: { minHeight: 124 },
  priceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  priceButton: { alignItems: 'center', borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, justifyContent: 'center', minHeight: 46, minWidth: 58, paddingHorizontal: 10 },
  priceButtonActive: { backgroundColor: palette.ink, borderColor: palette.ink },
  priceText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  priceTextActive: { color: '#FFFFFF' },
  switchRow: { alignItems: 'center', borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between', paddingTop: spacing.md },
  switchCopy: { flex: 1, gap: 3 },
  switchTitle: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  secondaryButton: { alignItems: 'center', alignSelf: 'flex-start', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 7, minHeight: 44, paddingHorizontal: 13 },
  secondaryButtonText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  saveButton: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: palette.accentDeep, borderRadius: radii.pill, flexDirection: 'row', gap: 9, justifyContent: 'center', minHeight: 50, paddingHorizontal: 20 },
  saveText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  disabled: { opacity: 0.55 },
  retryButton: { alignItems: 'center', alignSelf: 'flex-start', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, justifyContent: 'center', minHeight: 46, paddingHorizontal: 18 },
  retryText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
});
