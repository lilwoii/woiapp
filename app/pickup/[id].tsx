import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { featureFlags } from '@/lib/features';
import { parsePublicLocationRouteParam } from '@/lib/links';
import {
  createPayInPersonPickupOrder,
  loadPayInPersonPickupMenu,
  type PayInPersonPickupMenu,
  type PickupOrderReceipt,
} from '@/lib/pay-in-person-ordering';

type Notice = { tone: 'error' | 'success'; text: string };

function money(currency: string, minor: number) {
  try {
    return new Intl.NumberFormat(undefined, { currency, style: 'currency' }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

function pickupLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function timeChoices(menu: PayInPersonPickupMenu) {
  const now = Date.now();
  const first = Math.ceil((now + menu.minimumLeadMinutes * 60_000) / 900_000) * 900_000;
  return Array.from({ length: 6 }, (_, index) => new Date(first + index * 30 * 60_000).toISOString())
    .filter((value) => Date.parse(value) <= now + menu.maximumAdvanceMinutes * 60_000);
}

export default function PayInPersonPickupScreen() {
  const params = useLocalSearchParams<{ id?: string | string[]; location?: string | string[] }>();
  const businessId = Array.isArray(params.id) ? params.id[0] : params.id;
  const requestedLocationId = parsePublicLocationRouteParam(params.location) ?? undefined;
  const auth = useAuth();
  const [menu, setMenu] = useState<PayInPersonPickupMenu | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [locationId, setLocationId] = useState<string>();
  const [pickupAt, setPickupAt] = useState<string>();
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [receipt, setReceipt] = useState<PickupOrderReceipt | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestGeneration = useRef(0);
  const accountId = auth.account?.id;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (!businessId || !accountId || !featureFlags.pickupOrdering) return undefined;
    void loadPayInPersonPickupMenu(businessId, accountId).then((result) => {
      if (generation !== requestGeneration.current) return;
      if (!result.ok) {
        setMenu(null);
        setNotice({ tone: 'error', text: result.reason });
        setLoading(false);
        return;
      }
      const nextMenu = result.data;
      const preferredLocation = nextMenu.locations.find((location) => location.id === requestedLocationId);
      const times = timeChoices(nextMenu);
      setMenu(nextMenu);
      setLocationId(preferredLocation?.id ?? nextMenu.locations[0]?.id);
      setPickupAt(times[0]);
      setLoading(false);
    });
    return () => { requestGeneration.current += 1; };
  }, [accountId, businessId, reloadVersion, requestedLocationId]);

  const retry = () => {
    setLoading(true);
    setNotice(null);
    setReloadVersion((current) => current + 1);
  };

  const selectedLines = useMemo(() => {
    if (!menu) return [];
    return menu.sections.flatMap((section) => section.items)
      .flatMap((item) => {
        const quantity = quantities[item.id] ?? 0;
        return quantity > 0 ? [{ item, quantity }] : [];
      });
  }, [menu, quantities]);
  const subtotal = selectedLines.reduce((sum, line) => sum + line.item.priceMinor * line.quantity, 0);
  const currency = selectedLines[0]?.item.currency ?? menu?.sections[0]?.items[0]?.currency ?? 'USD';

  const changeQuantity = (itemId: string, delta: number) => {
    setQuantities((current) => {
      const next = Math.max(0, Math.min(20, (current[itemId] ?? 0) + delta));
      if (next === 0) {
        const { [itemId]: _removed, ...remaining } = current;
        return remaining;
      }
      return { ...current, [itemId]: next };
    });
  };

  const submit = async () => {
    if (!menu || !auth.account?.id || !locationId || !pickupAt || !selectedLines.length) {
      setNotice({ tone: 'error', text: 'Choose at least one item, a pickup place, and a pickup time.' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    const result = await createPayInPersonPickupOrder({
      businessId: menu.businessId,
      locationId,
      requestedPickupAt: pickupAt,
      lines: selectedLines.map(({ item, quantity }) => ({ menuItemId: item.id, quantity })),
      customerNote: note,
    }, auth.account.id);
    setSubmitting(false);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      return;
    }
    setReceipt(result.data);
    setNotice({ tone: 'success', text: 'Pickup request sent. The business must accept it before you travel.' });
  };

  if (!featureFlags.pickupOrdering) {
    return <Gate title="Pickup ordering is not available" body="Spottr has not enabled secure pickup ordering for this release." />;
  }
  if (auth.status === 'loading') {
    return <Gate title="Checking your account" body="Confirming your secure Spottr session." loading />;
  }
  if (auth.status !== 'authenticated' || !auth.account) {
    return <Gate title="Sign in to order pickup" body="An account keeps your request, cancellation, and business response tied to you." actionLabel="Sign in" onAction={() => router.push('/auth')} />;
  }
  if (loading) return <Gate title="Loading pickup" body="Checking the live menu and pickup availability." loading />;
  if (!menu) return <Gate title="Pickup is unavailable" body={notice?.text ?? 'This business is not accepting Spottr pickup requests right now.'} actionLabel="Try again" onAction={retry} />;

  const times = timeChoices(menu);
  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <PageShell narrow>
          <View style={styles.topRow}>
            <Pressable accessibilityLabel="Back to listing" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}>
              <FontAwesome6 color={palette.ink} name="arrow-left" size={15} />
            </Pressable>
            <View style={styles.eyebrowPill}><Text style={styles.eyebrow}>PAY IN PERSON</Text></View>
          </View>
          <Text accessibilityRole="header" style={styles.title}>Pickup from {menu.businessName}</Text>
          <Text style={styles.subtitle}>Build your order, choose a public pickup location, and wait for acceptance before heading out.</Text>

          {notice ? <View accessibilityLiveRegion="polite" style={[styles.notice, notice.tone === 'error' ? styles.noticeError : styles.noticeSuccess]}><Text style={styles.noticeText}>{notice.text}</Text></View> : null}

          {receipt ? (
            <View style={styles.receiptCard}>
              <View style={styles.receiptIcon}><FontAwesome6 color={palette.success} name="check" size={17} /></View>
              <View style={styles.flex}>
                <Text style={styles.cardTitle}>Request pending acceptance</Text>
                <Text style={styles.body}>Pickup {pickupLabel(receipt.requestedPickupAt)} · {money(receipt.currency, receipt.itemSubtotalMinor)} subtotal</Text>
                <Text style={styles.finePrint}>Payment is collected by the business in person. No card or Apple Pay charge was made in Spottr.</Text>
              </View>
            </View>
          ) : (
            <>
              <SectionTitle number="1" title="Choose items" />
              {menu.sections.map((section) => (
                <View key={section.id} style={styles.menuSection}>
                  <Text style={styles.menuSectionTitle}>{section.name}</Text>
                  {section.items.map((item) => {
                    const quantity = quantities[item.id] ?? 0;
                    return (
                      <View key={item.id} style={styles.menuItem}>
                        <View style={styles.flex}>
                          <Text style={styles.itemName}>{item.name}</Text>
                          {item.description ? <Text style={styles.itemDescription}>{item.description}</Text> : null}
                          <Text style={styles.price}>{money(item.currency, item.priceMinor)}</Text>
                          {item.allergenNote ? <Text style={styles.allergen}>Allergen note: {item.allergenNote}</Text> : null}
                        </View>
                        <View accessibilityLabel={`${item.name} quantity ${quantity}`} style={styles.stepper}>
                          <Pressable accessibilityLabel={`Remove one ${item.name}`} accessibilityRole="button" disabled={quantity === 0} onPress={() => changeQuantity(item.id, -1)} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable>
                          <Text style={styles.quantity}>{quantity}</Text>
                          <Pressable accessibilityLabel={`Add one ${item.name}`} accessibilityRole="button" onPress={() => changeQuantity(item.id, 1)} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ))}

              <SectionTitle number="2" title="Pickup location" />
              <View style={styles.choiceWrap}>
                {menu.locations.map((location) => {
                  const selected = location.id === locationId;
                  return <Pressable key={location.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setLocationId(location.id)} style={[styles.choiceCard, selected && styles.choiceCardSelected]}><Text style={styles.choiceTitle}>{location.label}</Text><Text style={styles.body}>{location.address} · {location.city}, {location.region} {location.postalCode}</Text></Pressable>;
                })}
              </View>

              <SectionTitle number="3" title="Pickup time" />
              <View style={styles.timeGrid}>
                {times.map((time) => {
                  const selected = pickupAt === time;
                  return <Pressable key={time} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setPickupAt(time)} style={[styles.timeChoice, selected && styles.timeChoiceSelected]}><Text style={[styles.timeText, selected && styles.timeTextSelected]}>{pickupLabel(time)}</Text></Pressable>;
                })}
              </View>

              <SectionTitle number="4" title="Pickup note" optional />
              <TextInput accessibilityLabel="Pickup note" maxLength={240} multiline onChangeText={setNote} placeholder="Keep it brief—no payment or sensitive details." placeholderTextColor={palette.mutedLight} style={styles.noteInput} value={note} />
              <Text style={styles.counter}>{note.length}/240</Text>

              <View style={styles.summary}>
                <View style={styles.summaryRow}><Text style={[styles.cardTitle, styles.summaryTitle]}>Item subtotal</Text><Text style={styles.total}>{money(currency, subtotal)}</Text></View>
                <Text style={[styles.finePrint, styles.summaryFinePrint]}>Taxes or merchant adjustments, if required, are handled and disclosed by the business at pickup. Spottr does not process this payment.</Text>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: submitting || !selectedLines.length }} disabled={submitting || !selectedLines.length} onPress={() => void submit()} style={[styles.submitButton, (submitting || !selectedLines.length) && styles.disabled]}>
                  {submitting ? <ActivityIndicator color="#FFFFFF" /> : <><Text style={styles.submitText}>Send pickup request</Text><FontAwesome6 color="#FFFFFF" name="arrow-right" size={14} /></>}
                </Pressable>
              </View>
            </>
          )}
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

function SectionTitle({ number, optional, title }: { number: string; optional?: boolean; title: string }) {
  return <View style={styles.sectionHeading}><View style={styles.number}><Text style={styles.numberText}>{number}</Text></View><Text style={styles.sectionTitle}>{title}</Text>{optional ? <Text style={styles.optional}>Optional</Text> : null}</View>;
}

function Gate({ actionLabel, body, loading, onAction, title }: { actionLabel?: string; body: string; loading?: boolean; onAction?: () => void; title: string }) {
  return <FocusAwareScreen><View role="main" style={styles.gate}>{loading ? <ActivityIndicator color={palette.accent} /> : <View style={styles.gateIcon}><FontAwesome6 color={palette.accentDeep} name="bag-shopping" size={18} /></View>}<Text accessibilityRole="header" style={styles.gateTitle}>{title}</Text><Text style={styles.gateBody}>{body}</Text>{onAction && actionLabel ? <Pressable accessibilityRole="button" onPress={onAction} style={styles.submitButton}><Text style={styles.submitText}>{actionLabel}</Text></Pressable> : null}<Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}><Text style={styles.backText}>Back to listing</Text></Pressable></View></FocusAwareScreen>;
}

const styles = StyleSheet.create({
  allergen: { color: palette.warning, fontSize: 12, lineHeight: 18, marginTop: 6 },
  backButton: { paddingHorizontal: 18, paddingVertical: 12 },
  backText: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  body: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  cardTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  choiceCard: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, gap: 4, padding: spacing.md },
  choiceCardSelected: { backgroundColor: palette.accentSoft, borderColor: palette.accent },
  choiceTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  choiceWrap: { gap: spacing.sm },
  content: { backgroundColor: palette.bg, flexGrow: 1, padding: spacing.lg, paddingBottom: 80 },
  counter: { alignSelf: 'flex-end', color: palette.muted, fontSize: 12, marginTop: 6 },
  disabled: { opacity: 0.45 },
  eyebrow: { color: palette.accentDeep, fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  eyebrowPill: { backgroundColor: palette.accentSoft, borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 8 },
  finePrint: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  flex: { flex: 1 },
  gate: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  gateBody: { color: palette.muted, fontSize: 15, lineHeight: 23, maxWidth: 460, textAlign: 'center' },
  gateIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: radii.pill, height: 48, justifyContent: 'center', width: 48 },
  gateTitle: { color: palette.ink, fontSize: 25, fontWeight: '900', textAlign: 'center' },
  iconButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  itemDescription: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  itemName: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  menuItem: { alignItems: 'center', borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.md },
  menuSection: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, marginTop: spacing.sm, overflow: 'hidden', paddingHorizontal: spacing.md },
  menuSectionTitle: { color: palette.muted, fontSize: 12, fontWeight: '900', letterSpacing: 1, paddingBottom: 12, paddingTop: 16, textTransform: 'uppercase' },
  noteInput: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.md, borderWidth: 1, color: palette.ink, fontSize: 15, minHeight: 104, padding: spacing.md, textAlignVertical: 'top' },
  notice: { borderRadius: radii.md, marginTop: spacing.lg, padding: spacing.md },
  noticeError: { backgroundColor: palette.warningSoft },
  noticeSuccess: { backgroundColor: palette.successSoft },
  noticeText: { color: palette.ink, fontSize: 14, fontWeight: '700', lineHeight: 20 },
  number: { alignItems: 'center', backgroundColor: palette.dark, borderRadius: radii.pill, height: 28, justifyContent: 'center', width: 28 },
  numberText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  optional: { color: palette.muted, fontSize: 12, marginLeft: 'auto' },
  price: { color: palette.ink, fontSize: 14, fontWeight: '800', marginTop: 7 },
  quantity: { color: palette.ink, fontSize: 15, fontWeight: '900', minWidth: 22, textAlign: 'center' },
  receiptCard: { backgroundColor: palette.successSoft, borderColor: palette.mint, borderRadius: radii.lg, borderWidth: 1, flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl, padding: spacing.lg },
  receiptIcon: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: radii.pill, height: 38, justifyContent: 'center', width: 38 },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, marginTop: spacing.xxl },
  sectionTitle: { color: palette.ink, fontSize: 19, fontWeight: '900' },
  stepButton: { alignItems: 'center', backgroundColor: palette.bg, borderRadius: radii.pill, height: 34, justifyContent: 'center', width: 34 },
  stepText: { color: palette.ink, fontSize: 20, fontWeight: '700' },
  stepper: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', padding: 3 },
  submitButton: { alignItems: 'center', alignSelf: 'stretch', backgroundColor: palette.accent, borderRadius: radii.pill, flexDirection: 'row', gap: 10, justifyContent: 'center', minHeight: 52, paddingHorizontal: spacing.lg },
  submitText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  subtitle: { color: palette.muted, fontSize: 16, lineHeight: 24, marginTop: spacing.sm, maxWidth: 620 },
  summary: { backgroundColor: palette.dark, borderRadius: radii.lg, gap: spacing.md, marginTop: spacing.xxl, padding: spacing.lg },
  summaryFinePrint: { color: palette.darkMuted },
  summaryRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  summaryTitle: { color: '#FFFFFF' },
  timeChoice: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11 },
  timeChoiceSelected: { backgroundColor: palette.dark, borderColor: palette.dark },
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  timeText: { color: palette.ink, fontSize: 13, fontWeight: '800' },
  timeTextSelected: { color: '#FFFFFF' },
  title: { color: palette.ink, fontSize: 34, fontWeight: '900', letterSpacing: -1, lineHeight: 39, marginTop: spacing.xl },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  total: { color: '#FFFFFF', fontSize: 22, fontWeight: '900' },
});
