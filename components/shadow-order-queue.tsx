import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { SectionHeading } from '@/components/section-heading';
import { palette, radii, spacing } from '@/constants/theme';
import {
  loadMerchantShadowOrderQueue,
  prepareMerchantShadowTransitionAttempt,
  transitionMerchantShadowOrder,
} from '@/lib/ordering-api';
import { confirmAction } from '@/lib/platform-dialog';
import type {
  ShadowMerchantQueueOrder,
  ShadowMerchantTransitionAttempt,
  ShadowMerchantTransitionState,
} from '@/types/ordering';

type Props = {
  businessId: string;
};

type QueueState = {
  businessId: string;
  error: string | null;
  loading: boolean;
  orders: readonly ShadowMerchantQueueOrder[];
};

type OrderAction = {
  icon: keyof typeof FontAwesome6.glyphMap;
  label: string;
  nextState: ShadowMerchantTransitionState;
  tone: 'danger' | 'primary' | 'secondary';
};

const currencyFormatters = new Map<string, Intl.NumberFormat>();
const pickupDateFormatters = new Map<string, Intl.DateTimeFormat>();
const pickupTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const pickupEndTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const deadlineFormatters = new Map<string, Intl.DateTimeFormat>();

const statusPresentation: Record<
  ShadowMerchantQueueOrder['fulfillmentState'],
  { icon: keyof typeof FontAwesome6.glyphMap; label: string }
> = {
  pending_acceptance: { icon: 'bell', label: 'Needs confirmation' },
  accepted: { icon: 'circle-check', label: 'Accepted' },
  preparing: { icon: 'fire-burner', label: 'Preparing' },
  ready: { icon: 'bag-shopping', label: 'Ready for pickup' },
};

const actionsByState: Record<
  ShadowMerchantQueueOrder['fulfillmentState'],
  readonly OrderAction[]
> = {
  pending_acceptance: [
    { icon: 'check', label: 'Accept', nextState: 'accepted', tone: 'primary' },
    { icon: 'xmark', label: 'Reject', nextState: 'rejected', tone: 'danger' },
  ],
  accepted: [
    { icon: 'fire-burner', label: 'Start preparing', nextState: 'preparing', tone: 'primary' },
    { icon: 'ban', label: 'Cancel', nextState: 'cancelled', tone: 'danger' },
  ],
  preparing: [
    { icon: 'bag-shopping', label: 'Mark ready', nextState: 'ready', tone: 'primary' },
    { icon: 'ban', label: 'Cancel', nextState: 'cancelled', tone: 'danger' },
  ],
  ready: [
    { icon: 'check-double', label: 'Mark picked up', nextState: 'completed', tone: 'primary' },
    { icon: 'ban', label: 'Cancel', nextState: 'cancelled', tone: 'danger' },
  ],
};

function cachedDateFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
) {
  let formatter = cache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    cache.set(timeZone, formatter);
  }
  return formatter;
}

function formatPickupDate(value: string, timeZone: string) {
  return cachedDateFormatter(pickupDateFormatters, timeZone, {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function formatPickupTime(value: string, timeZone: string) {
  return cachedDateFormatter(pickupTimeFormatters, timeZone, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatPickupEndTime(value: string, timeZone: string) {
  return cachedDateFormatter(pickupEndTimeFormatters, timeZone, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function formatDeadline(value: string, timeZone: string) {
  return cachedDateFormatter(deadlineFormatters, timeZone, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function formatMoney(minor: number, currency: string) {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { currency, style: 'currency' });
    currencyFormatters.set(currency, formatter);
  }
  return formatter.format(minor / 100);
}

function confirmationCopy(order: ShadowMerchantQueueOrder, nextState: ShadowMerchantTransitionState) {
  const pickup = `${formatPickupDate(
    order.pickupStartsAt,
    order.pickupLocation.timeZone
  )} at ${formatPickupTime(order.pickupStartsAt, order.pickupLocation.timeZone)}`;
  if (nextState === 'accepted') {
    return {
      title: 'Accept this staff test order?',
      message: `Pickup is ${pickup}. This records merchant acceptance but never charges the tester.`,
      confirmLabel: 'Accept order',
      destructive: false,
    };
  }
  if (nextState === 'rejected') {
    return {
      title: 'Reject this staff test order?',
      message: 'The reserved pickup capacity will be released and the order will leave this queue.',
      confirmLabel: 'Reject order',
      destructive: true,
    };
  }
  if (nextState === 'cancelled') {
    return {
      title: 'Cancel this staff test order?',
      message: 'The order will close and its accepted capacity will be released.',
      confirmLabel: 'Cancel order',
      destructive: true,
    };
  }
  if (nextState === 'completed') {
    return {
      title: 'Confirm this test pickup?',
      message: 'Mark the order picked up only after the internal tester receives it.',
      confirmLabel: 'Mark picked up',
      destructive: false,
    };
  }
  return null;
}

export function ShadowOrderQueue({ businessId }: Props) {
  const requestId = useRef(0);
  const attempts = useRef<Record<string, ShadowMerchantTransitionAttempt>>({});
  const actionInFlight = useRef(false);
  const mounted = useRef(true);
  const currentBusinessId = useRef(businessId);
  const [queue, setQueue] = useState<QueueState>({
    businessId,
    error: null,
    loading: true,
    orders: [],
  });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const refreshQueue = useCallback(async () => {
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    setQueue((current) => ({
      businessId,
      error: null,
      loading: true,
      orders: current.businessId === businessId ? current.orders : [],
    }));
    const result = await loadMerchantShadowOrderQueue(businessId);
    if (requestId.current !== currentRequest) return;
    setQueue(
      result.ok
        ? { businessId, error: null, loading: false, orders: result.data ?? [] }
        : { businessId, error: result.reason, loading: false, orders: [] }
    );
  }, [businessId]);

  useEffect(() => {
    currentBusinessId.current = businessId;
    mounted.current = true;
    const initialTimer = setTimeout(() => {
      void refreshQueue();
    }, 0);
    const refreshTimer = setInterval(() => {
      void refreshQueue();
    }, 20_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(refreshTimer);
      requestId.current += 1;
      mounted.current = false;
    };
  }, [businessId, refreshQueue]);

  const applyAction = async (
    order: ShadowMerchantQueueOrder,
    nextState: ShadowMerchantTransitionState
  ) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const actionBusinessId = businessId;
    try {
      const confirmation = confirmationCopy(order, nextState);
      if (confirmation && !(await confirmAction(confirmation))) return;
      if (!mounted.current || currentBusinessId.current !== actionBusinessId) return;

      const actionKey = `${order.orderPublicId}:${order.version}:${nextState}`;
      const attempt = prepareMerchantShadowTransitionAttempt(
        attempts.current[actionKey] ?? null,
        businessId,
        order,
        nextState
      );
      attempts.current[actionKey] = attempt;
      setPendingAction(actionKey);
      setNotice(null);
      const result = await transitionMerchantShadowOrder(attempt);
      if (!mounted.current || currentBusinessId.current !== actionBusinessId) return;
      if (!result.ok) {
        setNotice({ tone: 'error', text: result.reason });
        if (result.code === 'CONFLICT' || result.code === 'NOT_FOUND') void refreshQueue();
        return;
      }

      delete attempts.current[actionKey];
      setNotice({
        tone: 'success',
        text:
          nextState === 'accepted'
            ? 'Test order accepted.'
            : nextState === 'preparing'
              ? 'Preparation started.'
              : nextState === 'ready'
                ? 'Tester can now see that pickup is ready.'
                : nextState === 'completed'
                  ? 'Test pickup completed.'
                  : 'Test order closed and capacity released.',
      });
      setQueue((current) => ({
        ...current,
        orders:
          nextState === 'completed' || nextState === 'rejected' || nextState === 'cancelled'
            ? current.orders.filter((entry) => entry.orderPublicId !== order.orderPublicId)
            : current.orders.map((entry) =>
                entry.orderPublicId === order.orderPublicId
                  ? { ...entry, fulfillmentState: nextState, version: entry.version + 1 }
                  : entry
              ),
      }));
      void refreshQueue();
    } catch (error) {
      if (mounted.current && currentBusinessId.current === actionBusinessId) {
        setNotice({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Refresh this order and try again.',
        });
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current && currentBusinessId.current === actionBusinessId) {
        setPendingAction(null);
      }
    }
  };

  const orders = queue.businessId === businessId ? queue.orders : [];

  return (
    <View style={styles.panel}>
      <SectionHeading
        action={(
          <Pressable
            accessibilityLabel="Refresh pickup test queue"
            accessibilityRole="button"
            accessibilityState={{ busy: queue.loading, disabled: Boolean(pendingAction) }}
            disabled={Boolean(pendingAction)}
            onPress={() => void refreshQueue()}
            style={styles.refreshButton}>
            {queue.loading ? (
              <ActivityIndicator color={palette.ink} size="small" />
            ) : (
              <FontAwesome6 color={palette.ink} name="rotate" size={12} />
            )}
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        )}
        detail="Employee-only, zero-money orders. Every action is checked again by the server."
        eyebrow="Pickup operations"
        title="Live test queue"
      />

      <View style={styles.pilotNotice}>
        <View style={styles.pilotIcon}>
          <FontAwesome6 color={palette.accentDeep} name="flask" size={12} />
        </View>
        <View style={styles.pilotCopy}>
          <Text style={styles.pilotTitle}>Internal pickup pilot</Text>
          <Text style={styles.pilotText}>
            These orders total $0.00 and cannot charge a customer. Contact details are not exposed in this queue.
          </Text>
        </View>
      </View>

      {notice ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={[styles.notice, notice.tone === 'success' && styles.noticeSuccess]}>
          <FontAwesome6
            color={notice.tone === 'success' ? palette.success : palette.accentDeep}
            name={notice.tone === 'success' ? 'circle-check' : 'triangle-exclamation'}
            size={12}
            solid
          />
          <Text style={[styles.noticeText, notice.tone === 'success' && styles.noticeTextSuccess]}>
            {notice.text}
          </Text>
        </View>
      ) : null}

      {queue.error ? (
        <View accessibilityRole="alert" style={styles.errorState}>
          <FontAwesome6 color={palette.accentDeep} name="shield-halved" size={14} />
          <View style={styles.errorCopy}>
            <Text style={styles.errorTitle}>Queue stayed protected</Text>
            <Text style={styles.errorText}>{queue.error}</Text>
          </View>
          <Pressable
            accessibilityLabel="Retry loading pickup test queue"
            accessibilityRole="button"
            onPress={() => void refreshQueue()}
            style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {!queue.error && !orders.length && !queue.loading ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <FontAwesome6 color={palette.success} name="check" size={14} />
          </View>
          <View style={styles.emptyCopy}>
            <Text style={styles.emptyTitle}>The test queue is clear</Text>
            <Text style={styles.emptyText}>New internal pickup orders will appear here automatically.</Text>
          </View>
        </View>
      ) : null}

      {orders.length ? (
        <View style={styles.orderList}>
          {orders.map((order) => {
            const presentation = statusPresentation[order.fulfillmentState];
            const reference = order.orderPublicId.slice(0, 8).toLocaleUpperCase('en-US');
            return (
              <View key={order.orderPublicId} style={styles.orderCard}>
                <View style={styles.orderHeader}>
                  <View>
                    <Text style={styles.referenceLabel}>ORDER</Text>
                    <Text style={styles.reference}>#{reference}</Text>
                  </View>
                  <View style={styles.statusBadge}>
                    <FontAwesome6 color={palette.dark} name={presentation.icon} size={10} solid />
                    <Text style={styles.statusText}>{presentation.label}</Text>
                  </View>
                </View>

                <View style={styles.pickupRow}>
                  <View style={styles.pickupIcon}>
                    <FontAwesome6 color="#FFFFFF" name="bag-shopping" size={13} />
                  </View>
                  <View style={styles.pickupCopy}>
                    <Text style={styles.pickupLabel}>PICKUP WINDOW</Text>
                    <Text style={styles.pickupDate}>
                      {formatPickupDate(order.pickupStartsAt, order.pickupLocation.timeZone)}
                    </Text>
                    <Text style={styles.pickupTime}>
                      {formatPickupTime(order.pickupStartsAt, order.pickupLocation.timeZone)}–
                      {formatPickupEndTime(order.pickupEndsAt, order.pickupLocation.timeZone)}
                    </Text>
                    {order.fulfillmentState === 'pending_acceptance' ? (
                      <Text style={styles.deadlineText}>
                        Confirm by {formatDeadline(
                          order.acceptanceExpiresAt,
                          order.pickupLocation.timeZone
                        )}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.testTotal}>
                    <Text style={styles.testTotalLabel}>TEST TOTAL</Text>
                    <Text style={styles.testTotalValue}>{formatMoney(0, order.currency)}</Text>
                  </View>
                </View>

                <View style={styles.locationRow}>
                  <View style={styles.locationIcon}>
                    <FontAwesome6
                      color={palette.accentDeep}
                      name={order.pickupLocation.mobileStopId ? 'truck-fast' : 'location-dot'}
                      size={12}
                      solid
                    />
                  </View>
                  <View style={styles.locationCopy}>
                    <Text style={styles.locationKind}>
                      {order.pickupLocation.mobileStopId ? 'SCHEDULED TRUCK STOP' : 'PICKUP SITE'}
                    </Text>
                    <Text style={styles.locationLabel}>{order.pickupLocation.label}</Text>
                    <Text style={styles.locationAddress}>
                      {order.pickupLocation.addressLine
                        ? `${order.pickupLocation.addressLine} · `
                        : ''}
                      {order.pickupLocation.city}, {order.pickupLocation.region}
                      {order.pickupLocation.postalCode ? ` ${order.pickupLocation.postalCode}` : ''}
                    </Text>
                    <Text style={styles.locationZone}>{order.pickupLocation.timeZone}</Text>
                  </View>
                </View>

                <View style={styles.items}>
                  {order.lines.map((line, lineIndex) => (
                    <View key={`${order.orderPublicId}:${lineIndex}`} style={styles.itemRow}>
                      <View style={styles.quantityBadge}>
                        <Text style={styles.quantityText}>{line.quantity}×</Text>
                      </View>
                      <View style={styles.itemCopy}>
                        <Text style={styles.itemName}>{line.name}</Text>
                        {line.options.length ? (
                          <Text style={styles.optionText}>
                            {line.options.map((option) => `${option.groupName}: ${option.name}`).join(' · ')}
                          </Text>
                        ) : null}
                        {line.allergenNote ? (
                          <Text style={styles.allergenText}>
                            Allergen note: {line.allergenNote}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>

                <View style={styles.valueRow}>
                  <Text style={styles.valueLabel}>
                    {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'} · menu value{' '}
                    {formatMoney(order.itemSubtotalMinor, order.currency)}
                  </Text>
                  <Text style={styles.valueDiscount}>Internal pilot discount applied</Text>
                </View>

                <View style={styles.actions}>
                  {actionsByState[order.fulfillmentState].map((action) => {
                    const actionKey = `${order.orderPublicId}:${order.version}:${action.nextState}`;
                    const busy = pendingAction === actionKey;
                    const disabled = Boolean(pendingAction) || queue.loading;
                    return (
                      <Pressable
                        accessibilityHint={`Moves this order from ${presentation.label.toLocaleLowerCase('en-US')} to ${action.label.toLocaleLowerCase('en-US')}`}
                        accessibilityRole="button"
                        accessibilityState={{ busy, disabled }}
                        disabled={disabled}
                        key={action.nextState}
                        onPress={() => void applyAction(order, action.nextState)}
                        style={[
                          styles.actionButton,
                          action.tone === 'primary' && styles.actionPrimary,
                          action.tone === 'danger' && styles.actionDanger,
                          disabled && styles.actionDisabled,
                        ]}>
                        {busy ? (
                          <ActivityIndicator
                            color={action.tone === 'primary' ? '#FFFFFF' : palette.ink}
                            size="small"
                          />
                        ) : (
                          <FontAwesome6
                            color={action.tone === 'primary' ? '#FFFFFF' : action.tone === 'danger' ? palette.accentDeep : palette.ink}
                            name={action.icon}
                            size={10}
                          />
                        )}
                        <Text
                          style={[
                            styles.actionText,
                            action.tone === 'primary' && styles.actionTextPrimary,
                            action.tone === 'danger' && styles.actionTextDanger,
                          ]}>
                          {action.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    padding: spacing.xl,
  },
  refreshButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  refreshText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  pilotNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  pilotIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  pilotCopy: { flex: 1, gap: 3 },
  pilotTitle: { color: palette.accentDeep, fontSize: 12, fontWeight: '900' },
  pilotText: { color: palette.ink, fontSize: 11, lineHeight: 17 },
  notice: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: 9,
    padding: 12,
  },
  noticeSuccess: { backgroundColor: palette.successSoft },
  noticeText: { color: palette.accentDeep, flex: 1, fontSize: 11, fontWeight: '800' },
  noticeTextSuccess: { color: palette.success },
  errorState: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: palette.accentSoft,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  errorCopy: { flex: 1, gap: 3 },
  errorTitle: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  errorText: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  retryButton: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  retryText: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  emptyState: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 16,
  },
  emptyIcon: {
    alignItems: 'center',
    backgroundColor: palette.successSoft,
    borderRadius: 999,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  emptyCopy: { flex: 1, gap: 3 },
  emptyTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  emptyText: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  orderList: { gap: spacing.md },
  orderCard: {
    backgroundColor: '#FFFFFF',
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  orderHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  referenceLabel: { color: palette.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  reference: { color: palette.ink, fontSize: 13, fontWeight: '900', marginTop: 2 },
  statusBadge: {
    alignItems: 'center',
    backgroundColor: palette.mint,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 6,
    minHeight: 30,
    paddingHorizontal: 10,
  },
  statusText: { color: palette.dark, fontSize: 9, fontWeight: '900' },
  pickupRow: {
    alignItems: 'center',
    backgroundColor: palette.dark,
    flexDirection: 'row',
    gap: 11,
    padding: 15,
  },
  pickupIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  pickupCopy: { flex: 1 },
  pickupLabel: { color: palette.darkMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  pickupDate: { color: palette.darkMuted, fontSize: 10, fontWeight: '800', marginTop: 3 },
  pickupTime: { color: '#FFFFFF', fontSize: 14, fontWeight: '900', marginTop: 1 },
  deadlineText: { color: '#FFD2C9', fontSize: 9, fontWeight: '800', marginTop: 3 },
  testTotal: { alignItems: 'flex-end' },
  testTotalLabel: { color: palette.darkMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  testTotalValue: { color: '#FFFFFF', fontSize: 16, fontWeight: '900', marginTop: 2 },
  locationRow: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  locationIcon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  locationCopy: { flex: 1, gap: 2 },
  locationKind: { color: palette.accentDeep, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  locationLabel: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  locationAddress: { color: palette.ink, fontSize: 10, lineHeight: 15 },
  locationZone: { color: palette.muted, fontSize: 9, fontWeight: '800' },
  items: { paddingHorizontal: 16 },
  itemRow: {
    alignItems: 'flex-start',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 13,
  },
  quantityBadge: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.sm,
    minWidth: 34,
    paddingHorizontal: 7,
    paddingVertical: 5,
  },
  quantityText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  itemCopy: { flex: 1, gap: 3 },
  itemName: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  optionText: { color: palette.muted, fontSize: 10, lineHeight: 15 },
  allergenText: { color: palette.accentDeep, fontSize: 10, fontWeight: '800', lineHeight: 15 },
  valueRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  valueLabel: { color: palette.muted, fontSize: 9, fontWeight: '800' },
  valueDiscount: { color: palette.success, fontSize: 9, fontWeight: '900' },
  actions: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    padding: 13,
  },
  actionButton: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 118,
    paddingHorizontal: 15,
  },
  actionPrimary: { backgroundColor: palette.dark, borderColor: palette.dark },
  actionDanger: { backgroundColor: '#FFFFFF', borderColor: palette.accentSoft },
  actionDisabled: { opacity: 0.56 },
  actionText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  actionTextPrimary: { color: '#FFFFFF' },
  actionTextDanger: { color: palette.accentDeep },
});
