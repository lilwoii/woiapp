import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
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
import { submitContentReport } from '@/lib/marketplace-api';
import { checkProfessionalText } from '@/lib/moderation';

const reasons = [
  ['spam', 'Spam or misleading'],
  ['harassment', 'Harassment or hateful content'],
  ['unsafe', 'Unsafe or illegal activity'],
  ['privacy', 'Personal or private information'],
  ['other', 'Something else'],
] as const;

type TargetType = 'business' | 'review' | 'response' | 'update' | 'media' | 'user';

export default function ReportScreen() {
  const params = useLocalSearchParams<{ targetId?: string; targetType?: TargetType }>();
  const [reason, setReason] = useState<(typeof reasons)[number][0]>('spam');
  const [detail, setDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const validTarget = useMemo(
    () =>
      Boolean(
        params.targetId &&
          params.targetType &&
          ['business', 'review', 'response', 'update', 'media', 'user'].includes(params.targetType)
      ),
    [params.targetId, params.targetType]
  );

  const submit = async () => {
    if (!validTarget || !params.targetId || !params.targetType) {
      setMessage({ type: 'error', text: 'This content can no longer be reported.' });
      return;
    }

    if (detail.trim()) {
      const moderation = checkProfessionalText(detail, 500);
      if (!moderation.ok) {
        setMessage({ type: 'error', text: moderation.reason });
        return;
      }
    }

    setSubmitting(true);
    setMessage(null);
    const result = await submitContentReport({
      targetId: params.targetId,
      targetType: params.targetType,
      reason,
      detail,
    });
    setSubmitting(false);
    setMessage({
      type: result.ok ? 'success' : 'error',
      text: result.ok ? result.message ?? 'Report received.' : result.reason,
    });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
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
            <View style={styles.spacer} />
          </View>

          <View style={styles.panel}>
            <View style={styles.intro}>
              <Text accessibilityRole="header" style={styles.title}>
                Report content
              </Text>
              <Text style={styles.subtitle}>
                Choose the closest reason. Reports are confidential and reviewed under Spottr’s safety rules.
              </Text>
            </View>

            <View accessibilityLabel="Report reason" accessibilityRole="radiogroup" style={styles.reasonList}>
              {reasons.map(([id, label]) => {
                const selected = reason === id;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    aria-checked={selected}
                    accessibilityState={{ checked: selected }}
                    key={id}
                    onPress={() => setReason(id)}
                    style={[styles.reason, selected && styles.reasonSelected]}>
                    <View style={[styles.radio, selected && styles.radioSelected]}>
                      {selected ? <View style={styles.radioDot} /> : null}
                    </View>
                    <Text style={[styles.reasonText, selected && styles.reasonTextSelected]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.field}>
              <View style={styles.fieldHeader}>
                <Text style={styles.label}>Details</Text>
                <Text style={styles.counter}>{detail.length}/500</Text>
              </View>
              <TextInput
                accessibilityLabel="Optional report details"
                maxLength={500}
                multiline
                onChangeText={setDetail}
                placeholder="Optional context for the safety reviewer"
                placeholderTextColor={palette.mutedLight}
                style={styles.input}
                textAlignVertical="top"
                value={detail}
              />
            </View>

            {message ? (
              <View
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={[styles.message, message.type === 'success' && styles.messageSuccess]}>
                <FontAwesome6
                  color={message.type === 'success' ? palette.success : palette.accentDeep}
                  name={message.type === 'success' ? 'circle-check' : 'triangle-exclamation'}
                  size={13}
                  solid
                />
                <Text style={[styles.messageText, message.type === 'success' && styles.messageTextSuccess]}>
                  {message.text}
                </Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={submitting || message?.type === 'success'}
              onPress={submit}
              style={[
                styles.submitButton,
                (submitting || message?.type === 'success') && styles.submitButtonDisabled,
              ]}>
              {submitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.submitText}>Submit report</Text>
                  <FontAwesome6 color="#FFFFFF" name="flag" size={12} />
                </>
              )}
            </Pressable>

            <Text style={styles.emergency}>
              Spottr is not an emergency service. If someone is in immediate danger, contact local emergency services.
            </Text>
          </View>
        </PageShell>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 60 },
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
    gap: spacing.xl,
    marginTop: spacing.xxxl,
    maxWidth: 620,
    padding: spacing.xl,
    width: '100%',
  },
  intro: { gap: spacing.sm },
  title: {
    color: palette.ink,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1.4,
    lineHeight: 38,
  },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  reasonList: { gap: spacing.sm },
  reason: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  reasonSelected: { backgroundColor: palette.dark, borderColor: palette.dark },
  radio: {
    alignItems: 'center',
    borderColor: palette.mutedLight,
    borderRadius: 999,
    borderWidth: 2,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  radioSelected: { borderColor: palette.mint },
  radioDot: { backgroundColor: palette.mint, borderRadius: 999, height: 8, width: 8 },
  reasonText: { color: palette.ink, flex: 1, fontSize: 13, fontWeight: '800' },
  reasonTextSelected: { color: '#FFFFFF' },
  field: { gap: spacing.sm },
  fieldHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  counter: { color: palette.muted, fontSize: 11 },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 14,
    lineHeight: 21,
    minHeight: 130,
    padding: spacing.md,
  },
  message: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  messageSuccess: { backgroundColor: palette.successSoft },
  messageText: { color: palette.accentDeep, flex: 1, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  messageTextSuccess: { color: palette.success },
  submitButton: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 52,
  },
  submitButtonDisabled: { opacity: 0.55 },
  submitText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  emergency: { color: palette.muted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
});
