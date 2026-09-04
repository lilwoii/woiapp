import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { featureFlags } from '@/lib/features';
import {
  cancelPayInPersonPickupOrder,
  loadMyPayInPersonPickupOrders,
  type PickupOrderReceipt,
} from '@/lib/pay-in-person-ordering';
import { confirmAction } from '@/lib/platform-dialog';

const statusCopy: Record<PickupOrderReceipt['state'], { icon: keyof typeof FontAwesome6.glyphMap; label: string }> = {
  pending_acceptance: { icon: 'clock', label: 'Awaiting acceptance' },
  accepted: { icon: 'circle-check', label: 'Accepted' },
  preparing: { icon: 'fire-burner', label: 'Preparing' },
  ready: { icon: 'bag-shopping', label: 'Ready for pickup' },
  completed: { icon: 'check-double', label: 'Completed' },
  rejected: { icon: 'circle-xmark', label: 'Not accepted' },
  cancelled: { icon: 'ban', label: 'Cancelled' },
  expired: { icon: 'hourglass-end', label: 'Expired' },
};

function money(currency: string, minor: number) {
  try { return new Intl.NumberFormat(undefined, { currency, style: 'currency' }).format(minor / 100); }
  catch { return `${currency} ${(minor / 100).toFixed(2)}`; }
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short',
    timeZoneName: 'short', weekday: 'short',
  }).format(new Date(value));
}

export default function MyPickupOrdersScreen() {
  const auth = useAuth();
  const accountId = auth.account?.id;
  const requestVersion = useRef(0);
  const [orders, setOrders] = useState<readonly PickupOrderReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const version = ++requestVersion.current;
    const result = await loadMyPayInPersonPickupOrders(accountId);
    if (version !== requestVersion.current) return;
    setLoading(false);
    if (!result.ok) {
      setOrders([]);
      setNotice(result.reason);
      return;
    }
    setOrders(result.data);
    setNotice(null);
  }, [accountId]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => { clearTimeout(timer); requestVersion.current += 1; };
  }, [refresh]);

  const cancel = async (order: PickupOrderReceipt) => {
    if (!accountId || pendingId) return;
    const approved = await confirmAction({
      title: 'Cancel this pickup request?',
      message: 'The business will see the cancellation immediately. This cannot be undone.',
      confirmLabel: 'Cancel request',
      destructive: true,
    });
    if (!approved) return;
    setPendingId(order.orderPublicId);
    setNotice(null);
    const result = await cancelPayInPersonPickupOrder(order, accountId);
    setPendingId(null);
    if (!result.ok) {
      setNotice(result.reason);
      if (result.code === 'CONFLICT') void refresh();
      return;
    }
    setOrders((current) => current.map((candidate) => candidate.orderPublicId === result.data.orderPublicId ? result.data : candidate));
  };

  if (!featureFlags.pickupOrdering) return <Gate title="Pickup orders are unavailable" body="Spottr has not enabled pickup ordering for this release." />;
  if (auth.status === 'loading') return <Gate title="Checking your account" body="Confirming your secure Spottr session." loading />;
  if (auth.status !== 'authenticated' || !accountId) return <Gate title="Sign in to view orders" body="Your pickup history is private to your Spottr account." actionLabel="Sign in" onAction={() => router.push('/auth')} />;

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton}><FontAwesome6 color={palette.ink} name="arrow-left" size={14} /></Pressable>
            <Pressable accessibilityRole="button" onPress={() => { setLoading(true); void refresh(); }} style={styles.refresh}><FontAwesome6 color={palette.ink} name="rotate" size={11} /><Text style={styles.refreshText}>Refresh</Text></Pressable>
          </View>
          <Text accessibilityRole="header" style={styles.title}>Your pickup orders</Text>
          <Text style={styles.subtitle}>Live status, pickup details, and pay-in-person receipts in one private place.</Text>
          {notice ? <View accessibilityLiveRegion="polite" style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View> : null}
          {loading ? <View style={styles.loading}><ActivityIndicator color={palette.accent} /><Text style={styles.muted}>Loading your protected order history…</Text></View> : null}
          {!loading && !orders.length ? <View style={styles.empty}><View style={styles.emptyIcon}><FontAwesome6 color={palette.accentDeep} name="bag-shopping" size={18} /></View><Text style={styles.emptyTitle}>No pickup orders yet</Text><Text style={styles.muted}>When a verified place accepts Spottr pickup requests, your order will appear here.</Text><Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.primary}><Text style={styles.primaryText}>Explore nearby food</Text></Pressable></View> : null}
          <View style={styles.list}>
            {orders.map((order) => {
              const status = statusCopy[order.state];
              const canCancel = order.state === 'pending_acceptance' || order.state === 'accepted';
              return <View key={order.orderPublicId} style={styles.card}>
                <View style={styles.cardHeader}><View style={styles.flex}><Text style={styles.businessName}>{order.businessName}</Text><Text style={styles.pickupTime}>{dateTime(order.requestedPickupAt)}</Text></View><Text style={styles.total}>{money(order.currency, order.itemSubtotalMinor)}</Text></View>
                <View style={styles.status}><FontAwesome6 color={palette.accentDeep} name={status.icon} size={12} /><Text style={styles.statusText}>{status.label}</Text></View>
                {order.lines.map((line) => <View key={`${order.orderPublicId}:${line.menuItemId ?? line.name}`} style={styles.line}><Text style={styles.lineQuantity}>{line.quantity}×</Text><Text style={styles.lineName}>{line.name}</Text><Text style={styles.linePrice}>{money(order.currency, line.lineSubtotalMinor)}</Text></View>)}
                <View style={styles.paymentRow}><FontAwesome6 color={palette.success} name="money-bill-wave" size={12} /><Text style={styles.paymentText}>Pay the business in person · Spottr did not charge you</Text></View>
                {canCancel ? <Pressable accessibilityRole="button" disabled={Boolean(pendingId)} onPress={() => void cancel(order)} style={styles.cancelButton}>{pendingId === order.orderPublicId ? <ActivityIndicator color={palette.accentDeep} size="small" /> : <Text style={styles.cancelText}>Cancel request</Text>}</Pressable> : null}
              </View>;
            })}
          </View>
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

function Gate({ actionLabel, body, loading, onAction, title }: { actionLabel?: string; body: string; loading?: boolean; onAction?: () => void; title: string }) {
  return <FocusAwareScreen><View role="main" style={styles.gate}>{loading ? <ActivityIndicator color={palette.accent} /> : <View style={styles.emptyIcon}><FontAwesome6 color={palette.accentDeep} name="bag-shopping" size={18} /></View>}<Text accessibilityRole="header" style={styles.gateTitle}>{title}</Text><Text style={styles.muted}>{body}</Text>{onAction && actionLabel ? <Pressable accessibilityRole="button" onPress={onAction} style={styles.primary}><Text style={styles.primaryText}>{actionLabel}</Text></Pressable> : null}<Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}><Text style={styles.backText}>Back</Text></Pressable></View></FocusAwareScreen>;
}

const styles = StyleSheet.create({
  back: { padding: spacing.sm }, backText: { color: palette.ink, fontSize: 13, fontWeight: '800' },
  businessName: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  cancelButton: { alignItems: 'center', alignSelf: 'flex-start', borderColor: palette.accentDeep, borderRadius: radii.pill, borderWidth: 1, minHeight: 40, justifyContent: 'center', marginTop: spacing.md, paddingHorizontal: 15 },
  cancelText: { color: palette.accentDeep, fontSize: 12, fontWeight: '900' },
  card: { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, padding: spacing.lg },
  cardHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  content: { backgroundColor: palette.bg, flexGrow: 1, padding: spacing.lg, paddingBottom: 80 },
  empty: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.lg, borderWidth: 1, gap: spacing.sm, marginTop: spacing.xxl, padding: spacing.xxl },
  emptyIcon: { alignItems: 'center', backgroundColor: palette.accentSoft, borderRadius: radii.pill, height: 48, justifyContent: 'center', width: 48 },
  emptyTitle: { color: palette.ink, fontSize: 19, fontWeight: '900' },
  flex: { flex: 1 }, gate: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  gateTitle: { color: palette.ink, fontSize: 25, fontWeight: '900', textAlign: 'center' },
  iconButton: { alignItems: 'center', backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  line: { alignItems: 'center', borderTopColor: palette.line, borderTopWidth: 1, flexDirection: 'row', gap: spacing.sm, paddingVertical: 10 },
  lineName: { color: palette.ink, flex: 1, fontSize: 14, fontWeight: '700' },
  linePrice: { color: palette.ink, fontSize: 13, fontWeight: '800' },
  lineQuantity: { color: palette.accentDeep, fontSize: 13, fontWeight: '900' },
  list: { gap: spacing.md, marginTop: spacing.xl }, loading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  muted: { color: palette.muted, fontSize: 14, lineHeight: 21, maxWidth: 480, textAlign: 'center' },
  notice: { backgroundColor: palette.warningSoft, borderRadius: radii.md, marginTop: spacing.lg, padding: spacing.md },
  noticeText: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  paymentRow: { alignItems: 'center', backgroundColor: palette.successSoft, borderRadius: radii.sm, flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, padding: spacing.sm },
  paymentText: { color: palette.success, flex: 1, fontSize: 11, fontWeight: '800' },
  pickupTime: { color: palette.muted, fontSize: 13, marginTop: 4 },
  primary: { alignItems: 'center', backgroundColor: palette.accent, borderRadius: radii.pill, minHeight: 48, justifyContent: 'center', marginTop: spacing.sm, paddingHorizontal: spacing.lg },
  primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  refresh: { alignItems: 'center', flexDirection: 'row', gap: 7, padding: spacing.sm }, refreshText: { color: palette.ink, fontSize: 12, fontWeight: '800' },
  status: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: palette.accentSoft, borderRadius: radii.pill, flexDirection: 'row', gap: 7, marginBottom: spacing.md, marginTop: spacing.md, paddingHorizontal: 10, paddingVertical: 7 },
  statusText: { color: palette.accentDeep, fontSize: 11, fontWeight: '900' },
  subtitle: { color: palette.muted, fontSize: 16, lineHeight: 24, marginTop: spacing.sm },
  title: { color: palette.ink, fontSize: 34, fontWeight: '900', letterSpacing: -1, marginTop: spacing.xl },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, total: { color: palette.ink, fontSize: 18, fontWeight: '900' },
});
