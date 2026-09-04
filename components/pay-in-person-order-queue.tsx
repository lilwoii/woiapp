import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { SectionHeading } from '@/components/section-heading';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import {
  loadBusinessPayInPersonPickupOrders,
  transitionPayInPersonPickupOrder,
  type PickupOrderReceipt,
} from '@/lib/pay-in-person-ordering';
import { confirmAction } from '@/lib/platform-dialog';

type ActiveState = 'pending_acceptance' | 'accepted' | 'preparing' | 'ready';
type NextState = 'accepted' | 'preparing' | 'ready' | 'completed' | 'rejected' | 'cancelled';
type Action = Readonly<{
  icon: keyof typeof FontAwesome6.glyphMap;
  label: string;
  nextState: NextState;
  danger?: boolean;
}>;

const presentations: Record<ActiveState, { icon: keyof typeof FontAwesome6.glyphMap; label: string }> = {
  pending_acceptance: { icon: 'bell', label: 'Needs acceptance' },
  accepted: { icon: 'circle-check', label: 'Accepted' },
  preparing: { icon: 'fire-burner', label: 'Preparing' },
  ready: { icon: 'bag-shopping', label: 'Ready' },
};
const actions: Record<ActiveState, readonly Action[]> = {
  pending_acceptance: [
    { icon: 'check', label: 'Accept', nextState: 'accepted' },
    { danger: true, icon: 'xmark', label: 'Reject', nextState: 'rejected' },
  ],
  accepted: [
    { icon: 'fire-burner', label: 'Start preparing', nextState: 'preparing' },
    { danger: true, icon: 'ban', label: 'Cancel', nextState: 'cancelled' },
  ],
  preparing: [
    { icon: 'bag-shopping', label: 'Mark ready', nextState: 'ready' },
    { danger: true, icon: 'ban', label: 'Cancel', nextState: 'cancelled' },
  ],
  ready: [
    { icon: 'check-double', label: 'Picked up', nextState: 'completed' },
    { danger: true, icon: 'ban', label: 'Cancel', nextState: 'cancelled' },
  ],
};

function money(currency: string, minor: number) {
  try {
    return new Intl.NumberFormat(undefined, { currency, style: 'currency' }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZoneName: 'short',
    weekday: 'short',
  }).format(new Date(value));
}

function isActiveOrder(order: PickupOrderReceipt): order is PickupOrderReceipt & { state: ActiveState } {
  return order.state in presentations;
}

export function PayInPersonOrderQueue({ businessId }: { businessId: string }) {
  const auth = useAuth();
  const accountId = auth.account?.id;
  const requestVersion = useRef(0);
  const actionInFlight = useRef(false);
  const [orders, setOrders] = useState<readonly PickupOrderReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const version = ++requestVersion.current;
    const result = await loadBusinessPayInPersonPickupOrders(businessId, accountId);
    if (version !== requestVersion.current) return;
    setLoading(false);
    if (!result.ok) {
      setOrders([]);
      setNotice({ tone: 'error', text: result.reason });
      return;
    }
    setOrders(result.data);
  }, [accountId, businessId]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const interval = setInterval(() => void refresh(), 20_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      requestVersion.current += 1;
    };
  }, [refresh]);

  const act = async (order: PickupOrderReceipt, action: Action) => {
    if (!accountId || actionInFlight.current) return;
    const approved = await confirmAction({
      title: `${action.label} this pickup order?`,
      message: action.nextState === 'accepted'
        ? `Confirm pickup for ${dateTime(order.requestedPickupAt)}. The customer pays you in person.`
        : action.nextState === 'completed'
          ? 'Only mark this complete after the customer has received the order.'
          : 'This status change is recorded immediately for the customer.',
      confirmLabel: action.label,
      destructive: Boolean(action.danger),
    });
    if (!approved) return;
    actionInFlight.current = true;
    const key = `${order.orderPublicId}:${order.version}:${action.nextState}`;
    setPendingAction(key);
    setNotice(null);
    const result = await transitionPayInPersonPickupOrder({
      businessId,
      orderPublicId: order.orderPublicId,
      expectedVersion: order.version,
      nextState: action.nextState,
    }, accountId);
    actionInFlight.current = false;
    setPendingAction(null);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.reason });
      if (result.code === 'CONFLICT') void refresh();
      return;
    }
    setOrders((current) => current.flatMap((candidate) =>
      candidate.orderPublicId === result.data.orderPublicId
        ? isActiveOrder(result.data) ? [result.data] : []
        : [candidate]
    ));
    setNotice({ tone: 'success', text: `Order marked ${action.label.toLocaleLowerCase()}.` });
  };

  return (
    <View style={styles.panel}>
      <SectionHeading
        detail="Live customer requests. Payment is collected by your business at pickup."
        eyebrow="Pickup queue"
        title="Orders to prepare"
      />
      <View style={styles.safetyRow}>
        <FontAwesome6 color={palette.success} name="shield-halved" size={12} />
        <Text style={styles.safetyText}>Spottr never stores a card for these orders. Verify the order before collecting payment in person.</Text>
      </View>
      {notice ? <View accessibilityLiveRegion="polite" style={[styles.notice, notice.tone === 'success' && styles.noticeSuccess]}><Text style={styles.noticeText}>{notice.text}</Text></View> : null}
      {loading ? <View style={styles.loading}><ActivityIndicator color={palette.accent} /><Text style={styles.muted}>Loading protected queue…</Text></View> : null}
      {!loading && !orders.length ? <View style={styles.empty}><FontAwesome6 color={palette.muted} name="bag-shopping" size={18} /><Text style={styles.emptyTitle}>No active pickup requests</Text><Text style={styles.muted}>New accepted customer requests will appear here.</Text></View> : null}
      {orders.filter(isActiveOrder).map((order) => {
        const presentation = presentations[order.state];
        return (
          <View key={order.orderPublicId} style={styles.orderCard}>
            <View style={styles.orderHeader}>
              <View style={styles.status}><FontAwesome6 color={palette.accentDeep} name={presentation.icon} size={12} /><Text style={styles.statusText}>{presentation.label}</Text></View>
              <Text style={styles.total}>{money(order.currency, order.itemSubtotalMinor)}</Text>
            </View>
            <Text style={styles.pickupTime}>{dateTime(order.requestedPickupAt)}</Text>
            {order.lines.map((line) => <View key={`${order.orderPublicId}:${line.menuItemId ?? line.name}`} style={styles.line}><Text style={styles.lineQuantity}>{line.quantity}×</Text><Text style={styles.lineName}>{line.name}</Text><Text style={styles.linePrice}>{money(order.currency, line.lineSubtotalMinor)}</Text></View>)}
            {order.customerNote ? <View style={styles.note}><Text style={styles.noteLabel}>CUSTOMER NOTE</Text><Text style={styles.noteText}>{order.customerNote}</Text></View> : null}
            <View style={styles.actionRow}>
              {actions[order.state].map((action) => {
                const key = `${order.orderPublicId}:${order.version}:${action.nextState}`;
                const busy = pendingAction === key;
                return <Pressable key={action.nextState} accessibilityRole="button" accessibilityState={{ disabled: Boolean(pendingAction) }} disabled={Boolean(pendingAction)} onPress={() => void act(order, action)} style={[styles.action, action.danger ? styles.actionDanger : styles.actionPrimary]}>{busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : <><FontAwesome6 color="#FFFFFF" name={action.icon} size={12} /><Text style={styles.actionText}>{action.label}</Text></>}</Pressable>;
              })}
            </View>
          </View>
        );
      })}
      <Pressable accessibilityRole="button" onPress={() => { setLoading(true); void refresh(); }} style={styles.refresh}><FontAwesome6 color={palette.ink} name="rotate" size={11} /><Text style={styles.refreshText}>Refresh queue</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  action: { alignItems: 'center', borderRadius: radii.pill, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 42, paddingHorizontal: 16 },
  actionDanger: { backgroundColor: palette.accentDeep },
  actionPrimary: { backgroundColor: palette.dark },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  actionText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  empty: { alignItems: 'center', backgroundColor: palette.bg, borderRadius: radii.md, gap: 7, padding: spacing.xl },
  emptyTitle: { color: palette.ink, fontSize: 15, fontWeight: '900' },
  line: { alignItems: 'center', borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.sm, paddingVertical: 10 },
  lineName: { color: palette.ink, flex: 1, fontSize: 14, fontWeight: '700' },
  linePrice: { color: palette.ink, fontSize: 13, fontWeight: '800' },
  lineQuantity: { color: palette.accentDeep, fontSize: 13, fontWeight: '900' },
  loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.lg },
  muted: { color: palette.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  note: { backgroundColor: palette.warningSoft, borderRadius: radii.sm, gap: 4, marginTop: spacing.sm, padding: spacing.sm },
  noteLabel: { color: palette.warning, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  noteText: { color: palette.ink, fontSize: 13, lineHeight: 19 },
  notice: { backgroundColor: palette.warningSoft, borderRadius: radii.sm, marginBottom: spacing.md, padding: spacing.sm },
  noticeSuccess: { backgroundColor: palette.successSoft },
  noticeText: { color: palette.ink, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  orderCard: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, marginTop: spacing.sm, padding: spacing.md },
  orderHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  panel: { backgroundColor: palette.card, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, marginBottom: spacing.xl, padding: spacing.lg },
  pickupTime: { color: palette.ink, fontSize: 17, fontWeight: '900', marginBottom: spacing.md, marginTop: spacing.sm },
  refresh: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 7, marginTop: spacing.md, paddingHorizontal: 4, paddingVertical: 8 },
  refreshText: { color: palette.ink, fontSize: 12, fontWeight: '800' },
  safetyRow: { alignItems: 'flex-start', backgroundColor: palette.successSoft, borderRadius: radii.sm, flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, padding: spacing.sm },
  safetyText: { color: palette.success, flex: 1, fontSize: 11, fontWeight: '700', lineHeight: 17 },
  status: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: radii.pill, flexDirection: 'row', gap: 7, paddingHorizontal: 10, paddingVertical: 7 },
  statusText: { color: palette.accentDeep, fontSize: 11, fontWeight: '900' },
  total: { color: palette.ink, fontSize: 17, fontWeight: '900' },
});
