import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { InfoScreen, InfoSection } from '@/components/info-screen';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { saveAccountExport } from '@/lib/account-export-file';
import { requestAccountExport } from '@/lib/marketplace-api';

export default function AccountDataScreen() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const requestExport = async () => {
    if (auth.status !== 'authenticated') {
      router.push('/auth');
      return;
    }
    if (auth.assuranceLevel !== 'aal2') {
      setMessage({
        type: 'error',
        text: 'Verify an authenticator code in Security before exporting private account data.',
      });
      router.push('/security');
      return;
    }

    setBusy(true);
    setMessage(null);
    const result = await requestAccountExport();
    setBusy(false);
    if (!result.ok) {
      setMessage({ type: 'error', text: result.reason });
      return;
    }
    const content = result.data?.content;
    const fileName = result.data?.fileName ?? 'spottr-account-export.json';
    if (!content) {
      setMessage({ type: 'success', text: result.message ?? 'Your export is ready.' });
      return;
    }
    try {
      await saveAccountExport(content, fileName);
      setMessage({ type: 'success', text: result.message ?? 'Your export is ready.' });
    } catch {
      setMessage({
        type: 'error',
        text: 'The export was created, but this device could not open its save or share sheet.',
      });
    }
  };

  return (
    <InfoScreen
      eyebrow="Account data"
      summary="Request a portable copy of the information associated with your verified Spottr account."
      title="Your data, available to you.">
      <InfoSection icon="file-arrow-down" title="What the export contains">
        Your profile, follows, notification settings, reviews, reports, business memberships, claims, blocked profiles,
        media records, your marketplace conversations, messages you authored, pickup requests, and pickup sites you
        submitted or own.
      </InfoSection>
      <InfoSection icon="lock" title="Secure delivery">
        Live exports require a current authenticator-protected session. Spottr creates the JSON directly for your
        signed-in account and never includes authentication credentials.
      </InfoSection>
      <View style={styles.actionArea}>
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
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={requestExport}
          style={[styles.button, busy && styles.buttonDisabled]}>
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Text style={styles.buttonText}>
                {auth.assuranceLevel === 'aal2' ? 'Create my export' : 'Verify & export'}
              </Text>
              <FontAwesome6 color="#FFFFFF" name="download" size={13} />
            </>
          )}
        </Pressable>
      </View>
    </InfoScreen>
  );
}

const styles = StyleSheet.create({
  actionArea: { gap: spacing.md, padding: spacing.lg },
  message: { backgroundColor: palette.accentSoft, borderRadius: radii.md, padding: spacing.md },
  messageSuccess: { backgroundColor: palette.successSoft },
  messageText: { color: palette.accentDeep, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  messageTextSuccess: { color: palette.success },
  button: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  buttonDisabled: { opacity: 0.58 },
  buttonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
});
