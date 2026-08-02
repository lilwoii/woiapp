import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { useMarketplaceStore } from '@/context/marketplace-store';
import { featureFlags } from '@/lib/features';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export default function PickupOrderScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const placeId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { ensurePlace, places } = useMarketplaceStore();
  const place = places.find((candidate) => candidate.id === placeId);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(Boolean(placeId && !place));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!placeId || place) return;
    const timer = setTimeout(() => {
      void ensurePlace(placeId).then((result) => {
        setLoading(false);
        if (!result.ok) setError(result.reason);
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [ensurePlace, place, placeId]);

  const items = useMemo(
    () => place?.menu.flatMap((section) => section.items.map((item) => ({ ...item, sectionName: section.name }))) ?? [],
    [place]
  );
  const subtotalMinor = items.reduce((total, item) => {
    const quantity = quantities[item.id] ?? 0;
    const unitMinor = Number.isSafeInteger(Math.round(item.price * 100))
      ? Math.round(item.price * 100)
      : 0;
    const lineMinor = unitMinor * quantity;
    return Number.isSafeInteger(total + lineMinor) ? total + lineMinor : total;
  }, 0);
  const itemCount = Object.values(quantities).reduce((total, quantity) => total + quantity, 0);

  const changeQuantity = (itemId: string, delta: number) => {
    setQuantities((current) => {
      const next = Math.min(Math.max((current[itemId] ?? 0) + delta, 0), 20);
      if (!next) {
        const nextQuantities = { ...current };
        delete nextQuantities[itemId];
        return nextQuantities;
      }
      return { ...current, [itemId]: next };
    });
  };

  if (loading) {
    return <FocusAwareScreen><View accessibilityLiveRegion="polite" style={styles.center}><ActivityIndicator color={palette.accentDeep} /><Text style={styles.centerText}>Loading the pickup menu…</Text></View></FocusAwareScreen>;
  }

  if (!featureFlags.pickupOrdering || !place || error || !place.pickup?.enabled) {
    return <FocusAwareScreen><View style={styles.center}><FontAwesome6 color={palette.accentDeep} name="bag-shopping" size={24} /><Text accessibilityRole="header" style={styles.centerTitle}>Pickup ordering is unavailable.</Text><Text style={styles.centerText}>{error ?? 'This business is not accepting Spottr pickup orders.'}</Text><Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backPill}><Text style={styles.backPillText}>Back to listing</Text></Pressable></View></FocusAwareScreen>;
  }

  return (
    <FocusAwareScreen>
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        <PageShell narrow>
          <View style={styles.topbar}>
            <BrandMark />
            <Pressable accessibilityLabel="Close pickup order" accessibilityRole="button" onPress={() => router.back()} style={styles.closeButton}><FontAwesome6 color={palette.ink} name="xmark" size={14} /></Pressable>
          </View>
          <View style={styles.identity}>
            <Image accessibilityIgnoresInvertColors source={{ uri: place.logoUrl }} style={styles.logo} />
            <View style={styles.identityCopy}>
              <Text style={styles.eyebrow}>Pickup pilot</Text>
              <Text accessibilityRole="header" style={styles.title}>{place.name}</Text>
              <Text style={styles.detail}>{place.address} · about {place.pickup.estimatedMinutes ?? 20} min</Text>
            </View>
          </View>

          <View style={styles.pilotNotice}>
            <FontAwesome6 color={palette.warning} name="shield-halved" size={13} />
            <Text style={styles.pilotText}>This staff-only pilot validates catalog and pickup operations. Customer payment and submission remain off until tax, processor, merchant, refund, and operations gates are approved.</Text>
          </View>

          <View style={styles.menu}>
            {items.map((item) => {
              const quantity = quantities[item.id] ?? 0;
              return (
                <View key={item.id} style={styles.item}>
                  <View style={styles.itemCopy}>
                    <Text style={styles.sectionName}>{item.sectionName}</Text>
                    <Text style={[styles.itemName, item.soldOut && styles.soldOut]}>{item.name}</Text>
                    <Text style={styles.itemDescription}>{item.description}</Text>
                    <Text style={styles.itemPrice}>{money.format(item.price)}</Text>
                  </View>
                  <View style={styles.quantity}>
                    <Pressable accessibilityLabel={`Remove one ${item.name}`} accessibilityRole="button" disabled={!quantity} onPress={() => changeQuantity(item.id, -1)} style={[styles.quantityButton, !quantity && styles.disabled]}><FontAwesome6 color={palette.ink} name="minus" size={10} /></Pressable>
                    <Text accessibilityLiveRegion="polite" style={styles.quantityText}>{quantity}</Text>
                    <Pressable accessibilityLabel={`Add one ${item.name}`} accessibilityRole="button" disabled={Boolean(item.soldOut)} onPress={() => changeQuantity(item.id, 1)} style={[styles.quantityButton, item.soldOut && styles.disabled]}><FontAwesome6 color={palette.ink} name="plus" size={10} /></Pressable>
                  </View>
                </View>
              );
            })}
          </View>

          <View style={styles.summary}>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Items ({itemCount})</Text><Text style={styles.summaryValue}>{money.format(subtotalMinor / 100)}</Text></View>
            <Text style={styles.taxNote}>Tax, fees, tip, availability, and pickup capacity would be calculated and version-locked by the secure server quote—not estimated by this client.</Text>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: true }} disabled style={[styles.checkoutButton, styles.disabled]}><FontAwesome6 color="#FFFFFF" name="lock" size={11} /><Text style={styles.checkoutText}>Secure checkout coming after pilot approval</Text></Pressable>
          </View>
        </PageShell>
      </ScrollView>
    </FocusAwareScreen>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: palette.bg, flex: 1 },
  content: { paddingBottom: 88 },
  topbar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: spacing.md },
  closeButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
  identity: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.lg, paddingBottom: spacing.xl, paddingTop: 48 },
  logo: { borderRadius: radii.xl, height: 96, width: 96 },
  identityCopy: { flex: 1, gap: 5 },
  eyebrow: { color: palette.accentDeep, fontFamily: 'SpaceMono', fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase' },
  title: { color: palette.ink, fontSize: 29, fontWeight: '900', letterSpacing: -1 },
  detail: { color: palette.muted, fontSize: 10, lineHeight: 16 },
  pilotNotice: { alignItems: 'flex-start', backgroundColor: palette.warningSoft, borderRadius: radii.lg, flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.xl, padding: spacing.md },
  pilotText: { color: palette.warning, flex: 1, fontSize: 10, lineHeight: 16 },
  menu: { borderTopColor: palette.line, borderTopWidth: 1 },
  item: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.lg },
  itemCopy: { flex: 1, gap: 4 },
  sectionName: { color: palette.muted, fontFamily: 'SpaceMono', fontSize: 8, letterSpacing: 0.6, textTransform: 'uppercase' },
  itemName: { color: palette.ink, fontSize: 15, fontWeight: '900' },
  soldOut: { color: palette.muted, textDecorationLine: 'line-through' },
  itemDescription: { color: palette.muted, fontSize: 10, lineHeight: 15 },
  itemPrice: { color: palette.ink, fontSize: 11, fontWeight: '900' },
  quantity: { alignItems: 'center', borderColor: palette.line, borderRadius: radii.pill, borderWidth: 1, flexDirection: 'row', gap: 5, padding: 3 },
  quantityButton: { alignItems: 'center', borderRadius: 999, height: 38, justifyContent: 'center', width: 38 },
  quantityText: { color: palette.ink, fontSize: 12, fontWeight: '900', minWidth: 18, textAlign: 'center' },
  summary: { backgroundColor: palette.surface, borderRadius: radii.xl, gap: spacing.md, marginTop: spacing.xl, padding: spacing.lg },
  summaryRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  summaryLabel: { color: palette.ink, fontSize: 12, fontWeight: '900' },
  summaryValue: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  taxNote: { color: palette.muted, fontSize: 9, lineHeight: 15 },
  checkoutButton: { alignItems: 'center', backgroundColor: palette.accentDeep, borderRadius: radii.pill, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50, paddingHorizontal: spacing.md },
  checkoutText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900', textAlign: 'center' },
  disabled: { opacity: 0.5 },
  center: { alignItems: 'center', backgroundColor: palette.bg, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  centerTitle: { color: palette.ink, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  centerText: { color: palette.muted, fontSize: 12, lineHeight: 18, maxWidth: 440, textAlign: 'center' },
  backPill: { backgroundColor: palette.ink, borderRadius: radii.pill, justifyContent: 'center', minHeight: 46, paddingHorizontal: 18 },
  backPillText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
});
