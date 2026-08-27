import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { canInviteCreator, sendCreatorInvitation } from '@/lib/creator-invitations';
import { createMarketplaceIdempotencyKey } from '@/lib/marketplace-api';
import { checkProfessionalText } from '@/lib/moderation';

function defaultDate() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export default function CreatorInviteScreen() {
  const { recipientId, recipientName } = useLocalSearchParams<{ recipientId?: string; recipientName?: string }>();
  const auth = useAuth();
  const { managedPlaceIds, places } = useMarketplaceStore();
  const businesses = useMemo(
    () => places.filter((place) => managedPlaceIds.includes(place.id) && place.verified),
    [managedPlaceIds, places]
  );
  const accountId = auth.status === 'authenticated' ? auth.account?.id : undefined;
  const [businessId, setBusinessId] = useState('');
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [title, setTitle] = useState('Spottr community invitation');
  const [message, setMessage] = useState('We would be glad to host you at an upcoming food experience. Attendance is optional and no review is expected or required.');
  const [eventDate, setEventDate] = useState(defaultDate);
  const [eventTime, setEventTime] = useState('18:00');
  const [duration, setDuration] = useState('2');
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const selectedBusinessId = businessId || businesses[0]?.id || '';

  useEffect(() => {
    let active = true;
    if (!recipientId || !accountId) return () => { active = false; };
    void canInviteCreator(recipientId, accountId).then((result) => {
      if (active) setEligible(result.ok && result.data === true);
    });
    return () => { active = false; };
  }, [accountId, recipientId]);

  const send = async () => {
    if (!accountId || !recipientId || !selectedBusinessId || saving) return;
    const titleCheck = checkProfessionalText(title, 80);
    const messageCheck = checkProfessionalText(message, 800);
    if (!titleCheck.ok || !messageCheck.ok) {
      setNotice({ tone: 'error', text: !titleCheck.ok ? titleCheck.reason : !messageCheck.ok ? messageCheck.reason : 'Check the invitation.' });
      return;
    }
    const start = new Date(`${eventDate}T${eventTime}:00`);
    const hours = Number(duration);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(hours) || hours < 1 || hours > 12) {
      setNotice({ tone: 'error', text: 'Enter a valid future date, 24-hour time, and duration from 1 to 12 hours.' });
      return;
    }
    const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
    const fingerprint = [selectedBusinessId, recipientId, title.trim(), message.trim(), start.toISOString(), end.toISOString()].join('\u0000');
    const key = attempt.current?.fingerprint === fingerprint ? attempt.current.key : createMarketplaceIdempotencyKey('invite');
    attempt.current = { fingerprint, key };
    setSaving(true);
    setNotice(null);
    const result = await sendCreatorInvitation({
      businessId: selectedBusinessId,
      recipientPublicId: recipientId,
      title,
      message,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      independenceAcknowledged: acknowledged,
      idempotencyKey: key,
    }, accountId);
    setSaving(false);
    setNotice({ tone: result.ok ? 'success' : 'error', text: result.ok ? result.message ?? 'Invitation sent.' : result.reason });
    if (result.ok) attempt.current = null;
  };

  if (auth.status !== 'authenticated' || auth.assuranceLevel !== 'aal2') {
    return <FocusAwareScreen><View role="main" style={styles.gate}><FontAwesome6 color={palette.accentDeep} name="shield-halved" size={22} /><Text accessibilityRole="header" style={styles.gateTitle}>Protected invitations</Text><Text style={styles.gateBody}>Sign in and verify your authenticator before inviting a reviewer.</Text><Pressable accessibilityRole="button" onPress={() => router.replace(auth.status === 'authenticated' ? '/security' : '/auth')} style={styles.primary}><Text style={styles.primaryText}>{auth.status === 'authenticated' ? 'Verify security' : 'Sign in'}</Text></Pressable></View></FocusAwareScreen>;
  }

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}><Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}><FontAwesome6 color={palette.ink} name="arrow-left" size={12} /></Pressable><Text style={styles.topbarTitle}>Private invitation</Text><View style={styles.spacer} /></View>
          <View style={styles.heading}><Text style={styles.eyebrow}>COMMUNITY ACCESS</Text><Text accessibilityRole="header" style={styles.title}>Invite {recipientName ?? 'this reviewer'}.</Text><Text style={styles.subtitle}>A private, optional invitation from a verified business. Organic reviews and rankings stay completely separate.</Text></View>

          {eligible === false ? <View accessibilityRole="alert" style={styles.notice}><Text style={styles.noticeError}>This reviewer is not accepting invitations or has not reached the eligibility threshold.</Text></View> : null}
          {!businesses.length ? <View accessibilityRole="alert" style={styles.notice}><Text style={styles.noticeError}>A verified, publicly visible business is required before you can send invitations.</Text></View> : null}
          <View style={styles.form}>
            <Text style={styles.label}>From business</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.businesses}>{businesses.map((business) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: business.id === selectedBusinessId }} key={business.id} onPress={() => setBusinessId(business.id)} style={[styles.choice, business.id === selectedBusinessId && styles.choiceActive]}><Text style={[styles.choiceText, business.id === selectedBusinessId && styles.choiceTextActive]}>{business.name}</Text></Pressable>)}</View></ScrollView>
            <Text style={styles.label}>Invitation title</Text><TextInput maxLength={80} onChangeText={setTitle} style={styles.input} value={title} />
            <Text style={styles.label}>Private message</Text><TextInput maxLength={800} multiline onChangeText={setMessage} style={[styles.input, styles.messageInput]} value={message} />
            <View style={styles.schedule}><View style={styles.scheduleField}><Text style={styles.label}>Date</Text><TextInput accessibilityLabel="Event date YYYY-MM-DD" autoCapitalize="none" onChangeText={setEventDate} placeholder="YYYY-MM-DD" style={styles.input} value={eventDate} /></View><View style={styles.scheduleField}><Text style={styles.label}>Time</Text><TextInput accessibilityLabel="Event time 24-hour" autoCapitalize="none" onChangeText={setEventTime} placeholder="18:00" style={styles.input} value={eventTime} /></View><View style={styles.scheduleSmall}><Text style={styles.label}>Hours</Text><TextInput accessibilityLabel="Event duration hours" keyboardType="numeric" maxLength={2} onChangeText={setDuration} style={styles.input} value={duration} /></View></View>
            <View style={styles.ackRow}><View style={styles.ackCopy}><Text style={styles.ackTitle}>Review independence</Text><Text style={styles.help}>I confirm attendance, gifts, discounts, or access are not conditioned on posting or changing a review.</Text></View><Switch accessibilityLabel="Confirm no review is required" onValueChange={setAcknowledged} trackColor={{ false: palette.line, true: palette.mint }} thumbColor={acknowledged ? palette.success : '#FFFFFF'} value={acknowledged} /></View>
          </View>
          {notice ? <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.notice, notice.tone === 'success' && styles.noticeSuccess]}><Text style={notice.tone === 'success' ? styles.noticeSuccessText : styles.noticeError}>{notice.text}</Text></View> : null}
          <Pressable accessibilityRole="button" accessibilityState={{ busy: saving, disabled: saving || eligible !== true || !acknowledged }} disabled={saving || eligible !== true || !acknowledged} onPress={() => void send()} style={[styles.primary, (saving || eligible !== true || !acknowledged) && styles.disabled]}>{saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Send private invitation</Text>}</Pressable>
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 }, content: { padding: spacing.lg, paddingBottom: 120 }, topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, iconButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: 99, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, topbarTitle: { color: palette.ink, fontSize: 12, fontWeight: '900' }, spacer: { width: 42 }, heading: { gap: 7, marginTop: spacing.xxxl }, eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, fontWeight: '900', letterSpacing: 1 }, title: { color: palette.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1 }, subtitle: { color: palette.muted, fontSize: 10, lineHeight: 17, maxWidth: 600 }, form: { gap: spacing.sm, marginTop: spacing.xxl }, label: { color: palette.ink, fontSize: 10, fontWeight: '900', marginTop: spacing.sm }, input: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 11, minHeight: 44, padding: 12 }, messageInput: { minHeight: 130, textAlignVertical: 'top' }, businesses: { flexDirection: 'row', gap: spacing.sm }, choice: { borderColor: palette.line, borderRadius: 99, borderWidth: 1, minHeight: 40, paddingHorizontal: 15, justifyContent: 'center' }, choiceActive: { backgroundColor: palette.dark, borderColor: palette.dark }, choiceText: { color: palette.ink, fontSize: 9, fontWeight: '900' }, choiceTextActive: { color: '#FFFFFF' }, schedule: { flexDirection: 'row', gap: spacing.sm }, scheduleField: { flex: 1 }, scheduleSmall: { width: 76 }, ackRow: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, flexDirection: 'row', gap: spacing.md, marginTop: spacing.md, padding: spacing.md }, ackCopy: { flex: 1, gap: 4 }, ackTitle: { color: palette.ink, fontSize: 11, fontWeight: '900' }, help: { color: palette.muted, fontSize: 9, lineHeight: 14 }, primary: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: 99, justifyContent: 'center', marginTop: spacing.xl, minHeight: 50, paddingHorizontal: spacing.xl }, primaryText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' }, disabled: { opacity: 0.5 }, notice: { backgroundColor: palette.accentSoft, borderRadius: radii.md, marginTop: spacing.lg, padding: spacing.md }, noticeSuccess: { backgroundColor: palette.successSoft }, noticeError: { color: palette.accentDeep, fontSize: 10, lineHeight: 16 }, noticeSuccessText: { color: palette.success, fontSize: 10, fontWeight: '800' }, gate: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl }, gateTitle: { color: palette.ink, fontSize: 22, fontWeight: '900' }, gateBody: { color: palette.muted, fontSize: 10, lineHeight: 16, maxWidth: 420, textAlign: 'center' },
});
