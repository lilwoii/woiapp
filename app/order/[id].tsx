import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { FocusAwareScreen } from '@/components/focus-aware-screen';
import { PageShell } from '@/components/page-shell';
import { palette, radii, spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { featureFlags } from '@/lib/features';
import {
  cancelShadowOrder,
  loadShadowOrderableMenu,
  placeShadowOrder,
  prepareShadowCancellationAttempt,
  prepareShadowPlacementAttempt,
  prepareShadowQuoteAttempt,
  requestShadowOrderQuote,
} from '@/lib/ordering-api';
import {
  clearShadowOrderingRecovery,
  loadShadowOrderingRecovery,
  saveShadowOrderingRecovery,
} from '@/lib/ordering-recovery';
import type {
  ShadowCancellationAttempt,
  ShadowOrderMenuItem,
  ShadowOrderQuote,
  ShadowOrderReceipt,
  ShadowOrderableMenu,
  ShadowPlacementAttempt,
  ShadowQuoteAttempt,
} from '@/types/ordering';

type BusyAction = 'cancel' | 'menu' | 'place' | 'quote' | null;
type Notice = { tone: 'error' | 'success'; text: string };
type RecoveryStatus = 'blocked' | 'checking' | 'ready';
type SelectionState = Record<string, Record<string, string[]>>;

function money(currency: string, minor: number) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

function pickupTime(startsAt: string, endsAt: string) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  try {
    const day = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(start);
    const time = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${day} · ${time.format(start)}–${time.format(end)}`;
  } catch {
    return `${startsAt}–${endsAt}`;
  }
}

function deadlineTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function optionIdsForItem(selections: SelectionState, item: ShadowOrderMenuItem) {
  return item.optionGroups.flatMap(
    (group) => selections[item.itemVersionId]?.[group.optionGroupId] ?? []
  );
}

function itemSelectionError(selections: SelectionState, item: ShadowOrderMenuItem) {
  for (const group of item.optionGroups) {
    const count = selections[item.itemVersionId]?.[group.optionGroupId]?.length ?? 0;
    if (count < group.minimumSelections || count > group.maximumSelections) {
      const requirement =
        group.minimumSelections === group.maximumSelections
          ? group.minimumSelections
          : `${group.minimumSelections}–${group.maximumSelections}`;
      return `${item.name}: choose ${requirement} for ${group.name}.`;
    }
  }
  return null;
}

function GateScreen({
  body,
  icon,
  primaryAction,
  primaryLabel,
  title,
}: {
  body: string;
  icon: 'bag-shopping' | 'lock' | 'shield-halved';
  primaryAction?: () => void;
  primaryLabel?: string;
  title: string;
}) {
  return (
    <FocusAwareScreen>
      <View role="main" style={styles.center}>
        <View style={styles.gateIcon}>
          <FontAwesome6 color={palette.accentDeep} name={icon} size={19} />
        </View>
        <Text accessibilityRole="header" style={styles.centerTitle}>{title}</Text>
        <Text style={styles.centerText}>{body}</Text>
        <View style={styles.gateActions}>
          {primaryAction && primaryLabel ? (
            <Pressable accessibilityRole="button" onPress={primaryAction} style={styles.primaryPill}>
              <Text style={styles.primaryPillText}>{primaryLabel}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondaryPill}>
            <Text style={styles.secondaryPillText}>Back to listing</Text>
          </Pressable>
        </View>
      </View>
    </FocusAwareScreen>
  );
}

export default function PickupOrderScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const insets = useSafeAreaInsets();
  const placeId = Array.isArray(params.id) ? params.id[0] : params.id;
  const auth = useAuth();
  const { ensurePlace, places } = useMarketplaceStore();
  const place = places.find((candidate) => candidate.id === placeId);
  const [menu, setMenu] = useState<ShadowOrderableMenu | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [selections, setSelections] = useState<SelectionState>({});
  const [selectedWindowId, setSelectedWindowId] = useState('');
  const [quote, setQuote] = useState<ShadowOrderQuote | null>(null);
  const [receipt, setReceipt] = useState<ShadowOrderReceipt | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>('checking');
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const quoteAttempt = useRef<ShadowQuoteAttempt | null>(null);
  const placementAttempt = useRef<ShadowPlacementAttempt | null>(null);
  const cancellationAttempt = useRef<ShadowCancellationAttempt | null>(null);
  const recoveryAttempted = useRef<string | null>(null);
  const requestGeneration = useRef(0);
  const menuEntrance = useRef(new Animated.Value(0)).current;
  const quoteEntrance = useRef(new Animated.Value(0)).current;
  const receiptEntrance = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  const secureSession =
    auth.status === 'authenticated' &&
    auth.securityStatus === 'ready' &&
    auth.assuranceLevel === 'aal2';

  useLayoutEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setMenu(null);
    setQuantities({});
    setSelections({});
    setSelectedWindowId('');
    setQuote(null);
    setReceipt(null);
    setBusy(null);
    setNotice(null);
    setRecoveryStatus('checking');
    setNowMs(Date.now());
    quoteAttempt.current = null;
    placementAttempt.current = null;
    cancellationAttempt.current = null;
    recoveryAttempted.current = null;
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [auth.account?.id, placeId, secureSession]);

  useEffect(() => {
    if (!placeId || place) return;
    const timer = setTimeout(() => void ensurePlace(placeId), 0);
    return () => clearTimeout(timer);
  }, [ensurePlace, place, placeId]);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const loadMenu = useCallback(async () => {
    const accountId = auth.account?.id;
    if (!accountId || !placeId || !secureSession || !featureFlags.pickupOrdering) return;
    const generation = requestGeneration.current;
    setBusy('menu');
    setNotice(null);
    const result = await loadShadowOrderableMenu(placeId);
    if (generation !== requestGeneration.current) return;
    setBusy(null);
    if (!result.ok || !result.data) {
      setMenu(null);
      setNotice({
        tone: 'error',
        text: result.ok ? 'The pickup menu is unavailable.' : result.reason,
      });
      return;
    }
    setMenu(result.data);
    setSelectedWindowId((current) =>
      result.data?.pickupWindows.some((window) => window.capacitySlotId === current)
        ? current
        : result.data?.pickupWindows[0]?.capacitySlotId ?? ''
    );
  }, [auth.account?.id, placeId, secureSession]);

  useEffect(() => {
    const timer = setTimeout(() => void loadMenu(), 0);
    return () => clearTimeout(timer);
  }, [loadMenu]);

  useEffect(() => {
    const accountId = auth.account?.id;
    if (!accountId || !placeId || !secureSession) return;
    const attemptScope = `${accountId}:${placeId}:${recoveryNonce}`;
    if (recoveryAttempted.current === attemptScope) return;
    recoveryAttempted.current = attemptScope;
    const generation = requestGeneration.current;
    let active = true;
    setRecoveryStatus('checking');

    void (async () => {
      try {
        const recovery = await loadShadowOrderingRecovery(accountId, placeId);
        if (!active || generation !== requestGeneration.current) return;
        if (!recovery) {
          setRecoveryStatus('ready');
          return;
        }

        const { operation } = recovery;
        setBusy(operation.kind);
        setNotice({
          tone: 'success',
          text: 'Confirming the last interrupted secure operation…',
        });
        const result = operation.kind === 'place'
          ? await placeShadowOrder(operation.attempt)
          : await cancelShadowOrder(operation.attempt);
        const retainRecovery = result.ok
          ? !result.data
          : result.code === 'NETWORK' || result.code === 'UNKNOWN';
        if (!retainRecovery) {
          await clearShadowOrderingRecovery(
            accountId,
            placeId,
            operation.attempt.idempotencyKey
          );
        }
        if (!active || generation !== requestGeneration.current) return;
        setBusy(null);
        if (!result.ok || !result.data) {
          setRecoveryStatus(retainRecovery ? 'blocked' : 'ready');
          setNotice({
            tone: 'error',
            text: retainRecovery
              ? 'Spottr could not confirm the interrupted operation. Reconnect, then retry secure recovery before placing another order.'
              : result.ok
                ? 'The interrupted operation did not return a receipt.'
                : result.reason,
          });
          return;
        }
        if (operation.kind === 'place') placementAttempt.current = operation.attempt;
        else cancellationAttempt.current = operation.attempt;
        setQuote(null);
        setReceipt(result.data);
        setRecoveryStatus('ready');
        setNotice({
          tone: 'success',
          text: operation.kind === 'place'
            ? 'Interrupted placement safely recovered. No duplicate order was created.'
            : 'Interrupted cancellation safely recovered.',
        });
      } catch {
        if (!active || generation !== requestGeneration.current) return;
        setBusy(null);
        setRecoveryStatus('blocked');
        setNotice({
          tone: 'error',
          text: 'Secure retry recovery is unavailable. Resolve local secure storage before placing another order.',
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [auth.account?.id, placeId, recoveryNonce, secureSession]);

  useEffect(() => {
    if (!quote || receipt) return;
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [quote, receipt]);

  useEffect(() => {
    if (!menu) return;
    menuEntrance.setValue(reduceMotion ? 1 : 0);
    const animation = Animated.timing(menuEntrance, {
      duration: reduceMotion ? 0 : 260,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [menu, menuEntrance, reduceMotion]);

  useEffect(() => {
    if (!quote) return;
    quoteEntrance.setValue(reduceMotion ? 1 : 0);
    const animation = Animated.timing(quoteEntrance, {
      duration: reduceMotion ? 0 : 220,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [quote, quoteEntrance, reduceMotion]);

  useEffect(() => {
    if (!receipt) return;
    receiptEntrance.setValue(reduceMotion ? 1 : 0);
    const animation = Animated.spring(receiptEntrance, {
      damping: 18,
      mass: 0.7,
      stiffness: 180,
      toValue: 1,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [receipt, receiptEntrance, reduceMotion]);

  const selectedWindow = menu?.pickupWindows.find(
    (window) => window.capacitySlotId === selectedWindowId
  );
  const itemCount = Object.values(quantities).reduce((total, quantity) => total + quantity, 0);
  const menuValueMinor = (menu?.items ?? []).reduce((total, item) => {
    const quantity = quantities[item.itemVersionId] ?? 0;
    const selectedIds = new Set(optionIdsForItem(selections, item));
    const optionMinor = item.optionGroups
      .flatMap((group) => group.options)
      .filter((option) => selectedIds.has(option.optionVersionId))
      .reduce((sum, option) => sum + option.priceDeltaMinor, 0);
    const line = (item.unitPriceMinor + optionMinor) * quantity;
    return Number.isSafeInteger(total + line) ? total + line : total;
  }, 0);
  const quoteExpired = Boolean(quote && Date.parse(quote.expiresAt) <= nowMs);
  const quoteSeconds = quote
    ? Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - nowMs) / 1000))
    : 0;

  const invalidateQuote = useCallback(() => {
    setQuote(null);
    setReceipt(null);
    placementAttempt.current = null;
    cancellationAttempt.current = null;
    setNotice(null);
  }, []);

  const changeQuantity = (item: ShadowOrderMenuItem, delta: number) => {
    if (busy) return;
    invalidateQuote();
    setQuantities((current) => {
      const next = Math.min(
        Math.max((current[item.itemVersionId] ?? 0) + delta, 0),
        item.maximumQuantity
      );
      if (!next) {
        const nextQuantities = { ...current };
        delete nextQuantities[item.itemVersionId];
        return nextQuantities;
      }
      return { ...current, [item.itemVersionId]: next };
    });
    if (delta > 0) {
      setSelections((current) => {
        const itemSelections = { ...(current[item.itemVersionId] ?? {}) };
        for (const group of item.optionGroups) {
          if (
            group.minimumSelections === 1 &&
            group.options.length === 1 &&
            !itemSelections[group.optionGroupId]?.length
          ) {
            itemSelections[group.optionGroupId] = [group.options[0].optionVersionId];
          }
        }
        return { ...current, [item.itemVersionId]: itemSelections };
      });
    }
  };

  const toggleOption = (item: ShadowOrderMenuItem, groupId: string, optionId: string) => {
    if (busy || !(quantities[item.itemVersionId] ?? 0)) return;
    const group = item.optionGroups.find((candidate) => candidate.optionGroupId === groupId);
    if (!group) return;
    invalidateQuote();
    setSelections((current) => {
      const itemSelections = { ...(current[item.itemVersionId] ?? {}) };
      const selected = itemSelections[groupId] ?? [];
      const active = selected.includes(optionId);
      let next: string[];
      if (active) {
        next = selected.length <= group.minimumSelections
          ? selected
          : selected.filter((id) => id !== optionId);
      } else if (group.maximumSelections === 1) {
        next = [optionId];
      } else if (selected.length < group.maximumSelections) {
        next = [...selected, optionId];
      } else {
        next = selected;
      }
      itemSelections[groupId] = next;
      return { ...current, [item.itemVersionId]: itemSelections };
    });
  };

  const chooseWindow = (capacitySlotId: string) => {
    if (busy || selectedWindowId === capacitySlotId) return;
    invalidateQuote();
    quoteAttempt.current = null;
    setSelectedWindowId(capacitySlotId);
  };

  const requestQuote = async () => {
    if (!menu || !selectedWindow || busy || recoveryStatus !== 'ready') return;
    const generation = requestGeneration.current;
    const items = menu.items.filter((item) => (quantities[item.itemVersionId] ?? 0) > 0);
    if (!items.length) {
      setNotice({ tone: 'error', text: 'Choose at least one menu item.' });
      return;
    }
    const selectionError = items.map((item) => itemSelectionError(selections, item)).find(Boolean);
    if (selectionError) {
      setNotice({ tone: 'error', text: selectionError });
      return;
    }
    try {
      const attempt = prepareShadowQuoteAttempt(quoteAttempt.current, {
        businessId: menu.businessId,
        capacitySlotId: selectedWindow.capacitySlotId,
        pickupStartsAt: selectedWindow.startsAt,
        pickupEndsAt: selectedWindow.endsAt,
        lines: items.map((item) => ({
          itemVersionId: item.itemVersionId,
          quantity: quantities[item.itemVersionId],
          optionVersionIds: optionIdsForItem(selections, item),
        })),
      });
      quoteAttempt.current = attempt;
      setBusy('quote');
      setNotice(null);
      const result = await requestShadowOrderQuote(attempt);
      if (generation !== requestGeneration.current) return;
      setBusy(null);
      if (!result.ok || !result.data) {
        setQuote(null);
        setNotice({
          tone: 'error',
          text: result.ok ? 'A secure quote was not returned.' : result.reason,
        });
        return;
      }
      setQuote(result.data);
      setNowMs(Date.now());
      setNotice({
        tone: 'success',
        text: 'Server quote locked. Review it before placing the staff test.',
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setBusy(null);
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Review this order and try again.',
      });
    }
  };

  const submitOrder = async () => {
    const accountId = auth.account?.id;
    if (!accountId || !placeId || !quote || quoteExpired || busy || recoveryStatus !== 'ready') {
      return;
    }
    const generation = requestGeneration.current;
    let attempt: ShadowPlacementAttempt;
    try {
      attempt = prepareShadowPlacementAttempt(placementAttempt.current, quote);
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'The order could not be placed.',
      });
      return;
    }
    placementAttempt.current = attempt;
    setBusy('place');
    setRecoveryStatus('checking');
    setNotice(null);
    try {
      await saveShadowOrderingRecovery(accountId, placeId, { kind: 'place', attempt });
    } catch {
      if (generation !== requestGeneration.current) return;
      setBusy(null);
      setRecoveryStatus('blocked');
      setNotice({
        tone: 'error',
        text: 'Secure retry protection is unavailable, so Spottr did not place this order.',
      });
      return;
    }
    const result = await placeShadowOrder(attempt);
    const retainRecovery = result.ok
      ? !result.data
      : result.code === 'NETWORK' || result.code === 'UNKNOWN';
    let recoveryCleared = !retainRecovery;
    if (!retainRecovery) {
      try {
        await clearShadowOrderingRecovery(accountId, placeId, attempt.idempotencyKey);
      } catch {
        recoveryCleared = false;
      }
    }
    if (generation !== requestGeneration.current) return;
    setBusy(null);
    setRecoveryStatus(recoveryCleared ? 'ready' : 'blocked');
    if (!result.ok || !result.data) {
      if (
        !result.ok &&
        (result.code === 'CONFLICT' ||
          result.code === 'INVALID' ||
          result.code === 'NOT_FOUND')
      ) {
        setQuote(null);
        quoteAttempt.current = null;
        placementAttempt.current = null;
      }
      setNotice({
        tone: 'error',
        text: retainRecovery
          ? 'The placement result is unconfirmed. Retry secure recovery before placing another order.'
          : result.ok
            ? 'An order receipt was not returned.'
            : result.reason,
      });
      return;
    }
    setReceipt(result.data);
    setNotice({
      tone: recoveryCleared ? 'success' : 'error',
      text: recoveryCleared
        ? 'Zero-money staff test placed. No customer payment was created.'
        : 'Order confirmed, but local retry cleanup needs recovery before another operation.',
    });
  };

  const cancelOrder = async () => {
    const accountId = auth.account?.id;
    if (
      !accountId ||
      !placeId ||
      !receipt ||
      receipt.fulfillmentState !== 'pending_acceptance' ||
      busy ||
      recoveryStatus !== 'ready'
    ) return;
    const generation = requestGeneration.current;
    let attempt: ShadowCancellationAttempt;
    try {
      attempt = prepareShadowCancellationAttempt(cancellationAttempt.current, receipt);
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'The order could not be cancelled.',
      });
      return;
    }
    cancellationAttempt.current = attempt;
    setBusy('cancel');
    setRecoveryStatus('checking');
    setNotice(null);
    try {
      await saveShadowOrderingRecovery(accountId, placeId, { kind: 'cancel', attempt });
    } catch {
      if (generation !== requestGeneration.current) return;
      setBusy(null);
      setRecoveryStatus('blocked');
      setNotice({
        tone: 'error',
        text: 'Secure retry protection is unavailable, so Spottr did not cancel this order.',
      });
      return;
    }
    const result = await cancelShadowOrder(attempt);
    const retainRecovery = result.ok
      ? !result.data
      : result.code === 'NETWORK' || result.code === 'UNKNOWN';
    let recoveryCleared = !retainRecovery;
    if (!retainRecovery) {
      try {
        await clearShadowOrderingRecovery(accountId, placeId, attempt.idempotencyKey);
      } catch {
        recoveryCleared = false;
      }
    }
    if (generation !== requestGeneration.current) return;
    setBusy(null);
    setRecoveryStatus(recoveryCleared ? 'ready' : 'blocked');
    if (!result.ok || !result.data) {
      setNotice({
        tone: 'error',
        text: retainRecovery
          ? 'The cancellation result is unconfirmed. Retry secure recovery before another operation.'
          : result.ok
            ? 'A cancellation receipt was not returned.'
            : result.reason,
      });
      return;
    }
    setReceipt(result.data);
    setNotice({
      tone: recoveryCleared ? 'success' : 'error',
      text: recoveryCleared
        ? 'The staff test was cancelled and capacity was released.'
        : 'Cancellation confirmed, but local retry cleanup still needs recovery.',
    });
  };

  const runPrimaryAction = () => {
    if (quoteExpired) {
      quoteAttempt.current = null;
      placementAttempt.current = null;
      void requestQuote();
      return;
    }
    void (quote ? submitOrder() : requestQuote());
  };

  if (!featureFlags.pickupOrdering) {
    return (
      <GateScreen
        body="Spottr pickup ordering is securely disabled in this release."
        icon="bag-shopping"
        title="Pickup ordering is unavailable."
      />
    );
  }
  if (auth.status === 'loading' || auth.securityStatus === 'loading') {
    return (
      <FocusAwareScreen>
        <View style={styles.center}>
          <ActivityIndicator color={palette.accentDeep} />
          <Text style={styles.centerText}>Checking secure pilot access…</Text>
        </View>
      </FocusAwareScreen>
    );
  }
  if (auth.status !== 'authenticated') {
    return (
      <GateScreen
        body="Sign in with an approved staff account to use the zero-money pickup pilot."
        icon="lock"
        primaryAction={() => router.push('/auth')}
        primaryLabel="Sign in"
        title="Staff sign-in required"
      />
    );
  }
  if (!secureSession) {
    return (
      <GateScreen
        body="A current authenticator verification is required before ordering operations."
        icon="shield-halved"
        primaryAction={() => router.push('/security')}
        primaryLabel="Open Security"
        title="Verify this session"
      />
    );
  }
  if (!menu && receipt) {
    return (
      <GateScreen
        body={`${pickupTime(receipt.pickupStartsAt, receipt.pickupEndsAt)} · Reference ${receipt.orderPublicId
          .slice(0, 8)
          .toUpperCase()} · Payment not required.${
          receipt.fulfillmentState === 'pending_acceptance'
            ? ` Manual confirmation is due by ${deadlineTime(receipt.acceptanceExpiresAt)}.`
            : ''
        }`}
        icon="shield-halved"
        primaryAction={
          receipt.fulfillmentState === 'pending_acceptance' && recoveryStatus === 'ready'
            ? () => void cancelOrder()
            : undefined
        }
        primaryLabel="Cancel recovered staff test"
        title={
          receipt.fulfillmentState === 'cancelled'
            ? 'Cancellation safely recovered'
            : 'Pickup test safely recovered'
        }
      />
    );
  }
  if (busy === 'menu' && !menu) {
    return (
      <FocusAwareScreen>
        <View accessibilityLiveRegion="polite" style={styles.center}>
          <ActivityIndicator color={palette.accentDeep} />
          <Text style={styles.centerText}>Loading the server-owned pickup menu…</Text>
        </View>
      </FocusAwareScreen>
    );
  }
  if (!menu) {
    return (
      <GateScreen
        body={notice?.text ?? 'This business is not accepting internal pickup tests.'}
        icon="bag-shopping"
        primaryAction={() => void loadMenu()}
        primaryLabel="Try again"
        title="Pickup pilot unavailable"
      />
    );
  }

  return (
    <FocusAwareScreen>
      <View style={styles.screen}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: 156 + insets.bottom }]}
          style={styles.scroller}>
          <PageShell narrow>
            <View style={styles.topbar}>
              <BrandMark />
              <Pressable
                accessibilityLabel="Close pickup order"
                accessibilityRole="button"
                onPress={() => router.back()}
                style={styles.closeButton}>
                <FontAwesome6 color={palette.ink} name="xmark" size={14} />
              </Pressable>
            </View>

            <Animated.View
              style={[
                styles.identity,
                {
                  opacity: menuEntrance,
                  transform: [
                    {
                      translateY: menuEntrance.interpolate({
                        inputRange: [0, 1],
                        outputRange: [reduceMotion ? 0 : 10, 0],
                      }),
                    },
                  ],
                },
              ]}>
              {place?.logoUrl ? (
                <Image accessibilityIgnoresInvertColors source={{ uri: place.logoUrl }} style={styles.logo} />
              ) : (
                <View style={styles.logoFallback}>
                  <FontAwesome6 color={palette.accentDeep} name="truck" size={22} />
                </View>
              )}
              <View style={styles.identityCopy}>
                <Text style={styles.eyebrow}>Internal pickup pilot</Text>
                <Text accessibilityRole="header" style={styles.title}>
                  {place?.name ?? 'Spottr business'}
                </Text>
                <Text style={styles.detail}>
                  {selectedWindow
                    ? pickupTime(selectedWindow.startsAt, selectedWindow.endsAt)
                    : 'No pickup window'}
                </Text>
              </View>
            </Animated.View>

            <View style={styles.pilotNotice}>
              <FontAwesome6 color={palette.warning} name="shield-halved" size={13} />
              <Text style={styles.pilotText}>
                Employee-only operational test. The server creates no charge, and this does not
                represent a paid customer order. Manual confirmation is due within{' '}
                {Math.ceil(menu.acceptanceTimeoutSeconds / 60)} minutes after placement.
              </Text>
            </View>

            {receipt ? (
              <Animated.View
                style={[
                  styles.receipt,
                  {
                    opacity: receiptEntrance,
                    transform: [
                      {
                        scale: receiptEntrance.interpolate({
                          inputRange: [0, 1],
                          outputRange: [reduceMotion ? 1 : 0.98, 1],
                        }),
                      },
                    ],
                  },
                ]}>
                <View style={styles.receiptMark}>
                  <FontAwesome6
                    color={receipt.fulfillmentState === 'cancelled' ? palette.muted : palette.success}
                    name={receipt.fulfillmentState === 'cancelled' ? 'xmark' : 'check'}
                    size={20}
                  />
                </View>
                <Text style={styles.receiptEyebrow}>
                  Staff test · {receipt.fulfillmentState.replaceAll('_', ' ')}
                </Text>
                <Text accessibilityRole="header" style={styles.receiptTitle}>
                  {receipt.fulfillmentState === 'cancelled'
                    ? 'Test cancelled'
                    : 'Awaiting merchant confirmation'}
                </Text>
                <Text style={styles.receiptBody}>
                  {pickupTime(receipt.pickupStartsAt, receipt.pickupEndsAt)}
                </Text>
                <View style={styles.receiptRule} />
                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>Reference</Text>
                  <Text style={styles.receiptValue}>
                    {receipt.orderPublicId.slice(0, 8).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>Items</Text>
                  <Text style={styles.receiptValue}>
                    {receipt.lines.reduce((total, line) => total + line.quantity, 0)} ·{' '}
                    {money(receipt.currency, receipt.itemSubtotalMinor)} menu value
                  </Text>
                </View>
                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>Payment</Text>
                  <Text style={styles.receiptValue}>
                    Not required · {money(receipt.currency, 0)}
                  </Text>
                </View>
                <View style={styles.receiptRow}>
                  <Text style={styles.receiptLabel}>Confirmation</Text>
                  <Text style={styles.receiptValue}>
                    Manual · by {deadlineTime(receipt.acceptanceExpiresAt)}
                  </Text>
                </View>
                {receipt.fulfillmentState === 'pending_acceptance' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: busy === 'cancel' || recoveryStatus !== 'ready',
                    }}
                    disabled={busy === 'cancel' || recoveryStatus !== 'ready'}
                    onPress={() => void cancelOrder()}
                    style={[styles.cancelButton, busy === 'cancel' && styles.disabled]}>
                    {busy === 'cancel' ? (
                      <ActivityIndicator color={palette.accentDeep} size="small" />
                    ) : null}
                    <Text style={styles.cancelText}>Cancel staff test</Text>
                  </Pressable>
                ) : null}
              </Animated.View>
            ) : (
              <>
                <View style={styles.sectionHeader}>
                  <View>
                    <Text style={styles.sectionEyebrow}>01 · Pickup</Text>
                    <Text accessibilityRole="header" style={styles.sectionTitle}>
                      Choose a window
                    </Text>
                  </View>
                  <Text style={styles.sectionHint}>Live capacity</Text>
                </View>
                <View accessibilityRole="radiogroup">
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.windowRail}>
                    {menu.pickupWindows.map((window) => {
                      const active = window.capacitySlotId === selectedWindowId;
                      return (
                        <Pressable
                          accessibilityHint="Select this live pickup window"
                          accessibilityLabel={`${pickupTime(window.startsAt, window.endsAt)}, ${window.remainingCapacity} remaining`}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: active, disabled: Boolean(busy) }}
                          disabled={Boolean(busy)}
                          key={window.capacitySlotId}
                          onPress={() => chooseWindow(window.capacitySlotId)}
                          style={[styles.windowChoice, active && styles.windowChoiceActive]}>
                          <Text style={[styles.windowTime, active && styles.windowTextActive]}>
                            {pickupTime(window.startsAt, window.endsAt)}
                          </Text>
                          <Text style={[styles.windowCapacity, active && styles.windowTextActive]}>
                            {window.remainingCapacity} remaining
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
                {!menu.pickupWindows.length ? (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyStateTitle}>No pickup capacity right now</Text>
                    <Text style={styles.emptyStateText}>
                      Reload after the merchant publishes a future pickup window.
                    </Text>
                  </View>
                ) : null}

                <View style={styles.sectionHeader}>
                  <View>
                    <Text style={styles.sectionEyebrow}>02 · Menu</Text>
                    <Text accessibilityRole="header" style={styles.sectionTitle}>
                      Build the test order
                    </Text>
                  </View>
                  <Text style={styles.sectionHint}>Catalog v{menu.catalogVersion}</Text>
                </View>

                <View style={styles.menu}>
                  {menu.items.map((item) => {
                    const quantity = quantities[item.itemVersionId] ?? 0;
                    return (
                      <View key={item.itemVersionId} style={styles.item}>
                        <View style={styles.itemTopline}>
                          <View style={styles.itemCopy}>
                            <Text style={styles.itemName}>{item.name}</Text>
                            {item.description ? (
                              <Text style={styles.itemDescription}>{item.description}</Text>
                            ) : null}
                            <Text style={styles.itemPrice}>
                              {money(menu.currency, item.unitPriceMinor)}
                            </Text>
                          </View>
                          <View style={styles.quantity}>
                            <Pressable
                              accessibilityLabel={`Remove one ${item.name}`}
                              accessibilityRole="button"
                              disabled={!quantity || Boolean(busy)}
                              onPress={() => changeQuantity(item, -1)}
                              style={[
                                styles.quantityButton,
                                (!quantity || Boolean(busy)) && styles.disabled,
                              ]}>
                              <FontAwesome6 color={palette.ink} name="minus" size={10} />
                            </Pressable>
                            <Text accessibilityLiveRegion="polite" style={styles.quantityText}>
                              {quantity}
                            </Text>
                            <Pressable
                              accessibilityLabel={`Add one ${item.name}`}
                              accessibilityRole="button"
                              disabled={quantity >= item.maximumQuantity || Boolean(busy)}
                              onPress={() => changeQuantity(item, 1)}
                              style={[
                                styles.quantityButton,
                                (quantity >= item.maximumQuantity || Boolean(busy)) && styles.disabled,
                              ]}>
                              <FontAwesome6 color={palette.ink} name="plus" size={10} />
                            </Pressable>
                          </View>
                        </View>

                        {quantity > 0
                          ? item.optionGroups.map((group) => {
                              const selected =
                                selections[item.itemVersionId]?.[group.optionGroupId] ?? [];
                              return (
                                <View key={group.optionGroupId} style={styles.optionGroup}>
                                  <View style={styles.optionHeading}>
                                    <Text style={styles.optionTitle}>{group.name}</Text>
                                    <Text style={styles.optionRule}>
                                      {group.minimumSelections ? 'Required' : 'Optional'} · up to{' '}
                                      {group.maximumSelections}
                                    </Text>
                                  </View>
                                  <View
                                    accessibilityRole={
                                      group.maximumSelections === 1 ? 'radiogroup' : undefined
                                    }
                                    style={styles.optionRail}>
                                    {group.options.map((option) => {
                                      const active = selected.includes(option.optionVersionId);
                                      return (
                                        <Pressable
                                          accessibilityHint={`Select this option for ${group.name}`}
                                          accessibilityLabel={`${group.name}: ${option.name}${
                                            option.priceDeltaMinor
                                              ? `, plus ${money(menu.currency, option.priceDeltaMinor)}`
                                              : ''
                                          }`}
                                          accessibilityRole={
                                            group.maximumSelections === 1 ? 'radio' : 'checkbox'
                                          }
                                          accessibilityState={{
                                            checked: active,
                                            disabled: Boolean(busy),
                                          }}
                                          disabled={Boolean(busy)}
                                          key={option.optionVersionId}
                                          onPress={() =>
                                            toggleOption(
                                              item,
                                              group.optionGroupId,
                                              option.optionVersionId
                                            )
                                          }
                                          style={[
                                            styles.optionChoice,
                                            active && styles.optionChoiceActive,
                                          ]}>
                                          <Text
                                            style={[
                                              styles.optionText,
                                              active && styles.optionTextActive,
                                            ]}>
                                            {option.name}
                                            {option.priceDeltaMinor
                                              ? ` +${money(menu.currency, option.priceDeltaMinor)}`
                                              : ''}
                                          </Text>
                                        </Pressable>
                                      );
                                    })}
                                  </View>
                                </View>
                              );
                            })
                          : null}
                        {quantity > 0 && item.allergenNote ? (
                          <Text style={styles.allergenNote}>
                            Allergen note: {item.allergenNote}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
                {!menu.items.length ? (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyStateTitle}>No orderable items</Text>
                    <Text style={styles.emptyStateText}>
                      Discovery menu items never become orderable until a reviewed catalog is published.
                    </Text>
                  </View>
                ) : null}

                {quote ? (
                  <Animated.View
                    style={[
                      styles.quotePanel,
                      {
                        opacity: quoteEntrance,
                        transform: [
                          {
                            translateY: quoteEntrance.interpolate({
                              inputRange: [0, 1],
                              outputRange: [reduceMotion ? 0 : 12, 0],
                            }),
                          },
                        ],
                      },
                    ]}>
                    <View style={styles.quoteHeading}>
                      <View>
                        <Text style={styles.sectionEyebrow}>03 · Server quote</Text>
                        <Text accessibilityRole="header" style={styles.quoteTitle}>
                          Review the locked snapshot
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.expiryPill,
                          quoteExpired && styles.expiryPillExpired,
                        ]}>
                        <Text
                          accessibilityLiveRegion="polite"
                          style={[
                            styles.expiryText,
                            quoteExpired && styles.expiryTextExpired,
                          ]}>
                          {quoteExpired ? 'Expired' : `${Math.ceil(quoteSeconds / 60)} min`}
                        </Text>
                      </View>
                    </View>
                    {quote.lines.map((line) => (
                      <View key={line.itemVersionId} style={styles.quoteLine}>
                        <View style={styles.quoteLineCopy}>
                          <Text style={styles.quoteLineName}>
                            {line.quantity} × {line.name}
                          </Text>
                          {line.options.length ? (
                            <Text style={styles.quoteLineOptions}>
                              {line.options.map((option) => option.name).join(' · ')}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.quoteLineValue}>
                          {money(quote.currency, line.lineSubtotalMinor)}
                        </Text>
                      </View>
                    ))}
                    <View style={styles.quoteRule} />
                    <View style={styles.totalRow}>
                      <Text style={styles.totalLabel}>Menu value</Text>
                      <Text style={styles.totalValue}>
                        {money(quote.currency, quote.itemSubtotalMinor)}
                      </Text>
                    </View>
                    <View style={styles.totalRow}>
                      <Text style={styles.totalLabel}>Internal pilot offset</Text>
                      <Text style={styles.totalValue}>
                        −{money(quote.currency, quote.shadowDiscountMinor)}
                      </Text>
                    </View>
                    <View style={styles.dueRow}>
                      <Text style={styles.dueLabel}>Due</Text>
                      <Text style={styles.dueValue}>
                        {money(quote.currency, quote.totalMinor)}
                      </Text>
                    </View>
                    <Text style={styles.policyText}>
                      No payment method is collected. Manual merchant confirmation is required
                      after placement. Quote{' '}
                      {quote.quotePublicId.slice(0, 8).toUpperCase()} · policy versions{' '}
                      {quote.termsVersion} / {quote.refundPolicyVersion}.
                    </Text>
                  </Animated.View>
                ) : null}
              </>
            )}

            {notice ? (
              <View
                accessibilityLiveRegion="polite"
                style={[
                  styles.notice,
                  notice.tone === 'error' ? styles.noticeError : styles.noticeSuccess,
                ]}>
                <FontAwesome6
                  color={notice.tone === 'error' ? palette.accentDeep : palette.success}
                  name={notice.tone === 'error' ? 'circle-exclamation' : 'circle-check'}
                  size={12}
                />
                <Text
                  style={[
                    styles.noticeText,
                    notice.tone === 'error'
                      ? styles.noticeErrorText
                      : styles.noticeSuccessText,
                  ]}>
                  {notice.text}
                </Text>
              </View>
            ) : null}
            {recoveryStatus === 'blocked' ? (
              <Pressable
                accessibilityHint="Reconnect and safely retry the stored operation with its original request key"
                accessibilityRole="button"
                onPress={() => {
                  recoveryAttempted.current = null;
                  setRecoveryStatus('checking');
                  setRecoveryNonce((current) => current + 1);
                }}
                style={styles.recoveryButton}>
                <FontAwesome6 color={palette.accentDeep} name="rotate" size={11} />
                <Text style={styles.recoveryButtonText}>Retry secure recovery</Text>
              </Pressable>
            ) : null}
          </PageShell>
        </ScrollView>

        {!receipt ? (
          <View
            style={[
              styles.actionDock,
              { paddingBottom: Math.max(spacing.md, insets.bottom) },
            ]}>
            <View style={styles.actionDockInner}>
              <View style={styles.actionSummary}>
                <Text style={styles.actionEyebrow}>
                  {quote
                    ? 'Server-locked value'
                    : `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
                </Text>
                <Text style={styles.actionValue}>
                  {money(menu.currency, quote?.itemSubtotalMinor ?? menuValueMinor)}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{
                  disabled:
                    Boolean(busy) ||
                    recoveryStatus !== 'ready' ||
                    !itemCount ||
                    !selectedWindow,
                }}
                disabled={
                  Boolean(busy) ||
                  recoveryStatus !== 'ready' ||
                  !itemCount ||
                  !selectedWindow
                }
                onPress={runPrimaryAction}
                style={[
                  styles.actionButton,
                  (Boolean(busy) ||
                    recoveryStatus !== 'ready' ||
                    !itemCount ||
                    !selectedWindow) &&
                    styles.disabled,
                ]}>
                {recoveryStatus === 'checking' || busy === 'quote' || busy === 'place' ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <FontAwesome6
                    color="#FFFFFF"
                    name={quote ? 'shield-halved' : 'arrow-right'}
                    size={12}
                  />
                )}
                <Text style={styles.actionButtonText}>
                  {recoveryStatus === 'checking'
                    ? 'Checking secure recovery…'
                    : busy === 'quote'
                    ? 'Locking quote…'
                    : busy === 'place'
                      ? 'Placing test…'
                      : quoteExpired
                        ? 'Refresh secure quote'
                        : quote
                          ? 'Place zero-money staff test'
                          : 'Review secure quote'}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  scroller: { flex: 1 },
  content: { paddingBottom: 156 },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
  },
  closeButton: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  identity: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.lg,
    paddingBottom: spacing.xl,
    paddingTop: 42,
  },
  logo: {
    backgroundColor: palette.surface,
    borderRadius: radii.xl,
    height: 92,
    width: 92,
  },
  logoFallback: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.xl,
    height: 92,
    justifyContent: 'center',
    width: 92,
  },
  identityCopy: { flex: 1, gap: 5 },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  title: { color: palette.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1.1 },
  detail: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  pilotNotice: {
    alignItems: 'flex-start',
    backgroundColor: palette.warningSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
    padding: spacing.md,
  },
  pilotText: { color: palette.warning, flex: 1, fontSize: 12, lineHeight: 18 },
  sectionHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    marginTop: spacing.xxxl,
  },
  sectionEyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sectionTitle: {
    color: palette.ink,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.7,
    marginTop: 5,
  },
  sectionHint: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    textTransform: 'uppercase',
  },
  windowRail: { gap: spacing.sm, paddingRight: spacing.lg },
  windowChoice: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.md,
    borderWidth: 1,
    gap: 5,
    minHeight: 66,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    width: 188,
  },
  windowChoiceActive: { backgroundColor: palette.dark, borderColor: palette.dark },
  windowTime: { color: palette.ink, fontSize: 11, fontWeight: '900', lineHeight: 16 },
  windowCapacity: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    textTransform: 'uppercase',
  },
  windowTextActive: { color: '#FFFFFF' },
  emptyState: {
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    gap: 5,
    paddingVertical: spacing.xl,
  },
  emptyStateTitle: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  emptyStateText: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  menu: { borderTopColor: palette.line, borderTopWidth: 1 },
  item: { borderBottomColor: palette.line, borderBottomWidth: 1, paddingVertical: spacing.xl },
  itemTopline: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  itemCopy: { flex: 1, gap: 5 },
  itemName: { color: palette.ink, fontSize: 16, fontWeight: '900' },
  itemDescription: { color: palette.muted, fontSize: 11, lineHeight: 17, maxWidth: 480 },
  itemPrice: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  quantity: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    padding: 3,
  },
  quantityButton: {
    alignItems: 'center',
    borderRadius: 999,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  quantityText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
    minWidth: 18,
    textAlign: 'center',
  },
  optionGroup: { gap: spacing.sm, marginTop: spacing.lg },
  optionHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  optionTitle: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  optionRule: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    textTransform: 'uppercase',
  },
  optionRail: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  optionChoice: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 13,
  },
  optionChoiceActive: { backgroundColor: palette.accentSoft, borderColor: palette.accentDeep },
  optionText: { color: palette.muted, fontSize: 11, fontWeight: '800' },
  optionTextActive: { color: palette.accentDeep },
  allergenNote: { color: palette.warning, fontSize: 10, lineHeight: 15, marginTop: spacing.md },
  quotePanel: {
    backgroundColor: palette.dark,
    borderRadius: radii.xl,
    gap: spacing.sm,
    marginTop: spacing.xxxl,
    padding: spacing.xl,
  },
  quoteHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  quoteTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.5,
    marginTop: 5,
  },
  expiryPill: {
    backgroundColor: palette.mint,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  expiryPillExpired: { backgroundColor: palette.accentSoft },
  expiryText: {
    color: palette.success,
    fontFamily: 'SpaceMono',
    fontSize: 9,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  expiryTextExpired: { color: palette.accentDeep },
  quoteLine: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  quoteLineCopy: { flex: 1 },
  quoteLineName: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  quoteLineOptions: { color: palette.darkMuted, fontSize: 10, lineHeight: 15, marginTop: 3 },
  quoteLineValue: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  quoteRule: { backgroundColor: '#35504D', height: 1, marginVertical: spacing.sm },
  totalRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  totalLabel: { color: palette.darkMuted, fontSize: 11 },
  totalValue: { color: palette.darkMuted, fontSize: 11, fontWeight: '800' },
  dueRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 5,
  },
  dueLabel: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  dueValue: { color: '#FFFFFF', fontSize: 24, fontWeight: '900', letterSpacing: -0.8 },
  policyText: { color: palette.darkMuted, fontSize: 10, lineHeight: 15, marginTop: spacing.sm },
  notice: {
    alignItems: 'flex-start',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  noticeError: { backgroundColor: palette.accentSoft },
  noticeSuccess: { backgroundColor: palette.successSoft },
  noticeText: { flex: 1, fontSize: 11, lineHeight: 17 },
  noticeErrorText: { color: palette.accentDeep },
  noticeSuccessText: { color: palette.success },
  recoveryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: palette.accentDeep,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    marginTop: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  recoveryButtonText: { color: palette.accentDeep, fontSize: 11, fontWeight: '900' },
  actionDock: {
    backgroundColor: 'rgba(246,243,236,0.97)',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    position: 'absolute',
    right: 0,
  },
  actionDockInner: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    maxWidth: 760,
    width: '100%',
  },
  actionSummary: { gap: 2, minWidth: 90 },
  actionEyebrow: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 7,
    textTransform: 'uppercase',
  },
  actionValue: { color: palette.ink, fontSize: 19, fontWeight: '900', letterSpacing: -0.5 },
  actionButton: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    maxWidth: 430,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  actionButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', textAlign: 'center' },
  receipt: { alignItems: 'center', paddingBottom: spacing.xxl, paddingTop: 54 },
  receiptMark: {
    alignItems: 'center',
    backgroundColor: palette.successSoft,
    borderRadius: 999,
    height: 58,
    justifyContent: 'center',
    marginBottom: spacing.lg,
    width: 58,
  },
  receiptEyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 8,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  receiptTitle: {
    color: palette.ink,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  receiptBody: { color: palette.muted, fontSize: 11, marginTop: spacing.sm, textAlign: 'center' },
  receiptRule: {
    backgroundColor: palette.line,
    height: 1,
    marginVertical: spacing.xl,
    maxWidth: 460,
    width: '100%',
  },
  receiptRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    maxWidth: 460,
    paddingVertical: 7,
    width: '100%',
  },
  receiptLabel: { color: palette.muted, fontSize: 10 },
  receiptValue: { color: palette.ink, fontSize: 10, fontWeight: '900' },
  cancelButton: {
    alignItems: 'center',
    borderColor: palette.accentDeep,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: spacing.xl,
    minHeight: 46,
    paddingHorizontal: spacing.lg,
  },
  cancelText: { color: palette.accentDeep, fontSize: 9, fontWeight: '900' },
  disabled: { opacity: 0.45 },
  center: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  gateIcon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  centerTitle: {
    color: palette.ink,
    fontSize: 23,
    fontWeight: '900',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  centerText: {
    color: palette.muted,
    fontSize: 11,
    lineHeight: 18,
    maxWidth: 460,
    textAlign: 'center',
  },
  gateActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  primaryPill: {
    backgroundColor: palette.ink,
    borderRadius: radii.pill,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 18,
  },
  primaryPillText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  secondaryPill: {
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 18,
  },
  secondaryPillText: { color: palette.ink, fontSize: 10, fontWeight: '900' },
});
