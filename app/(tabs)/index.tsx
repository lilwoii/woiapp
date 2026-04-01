import { startTransition, useDeferredValue, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';

import { LiveMap } from '@/components/live-map';
import { SectionTitle } from '@/components/section-title';
import { SyncBanner } from '@/components/sync-banner';
import { TruckCard } from '@/components/truck-card';
import { palette, spacing } from '@/constants/theme';
import { averageRating, useTruckStore } from '@/context/truck-store';

export default function DiscoverScreen() {
  const { trucks, syncMessage, syncStatus } = useTruckStore();
  const [query, setQuery] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();

    return trucks.filter((truck) => {
      const matchesSearch =
        !normalized ||
        truck.name.toLowerCase().includes(normalized) ||
        truck.cuisine.toLowerCase().includes(normalized) ||
        truck.address.toLowerCase().includes(normalized);
      const matchesOpen = !openOnly || truck.status === 'Open now';

      return matchesSearch && matchesOpen;
    });
  }, [deferredQuery, openOnly, trucks]);

  const featured = filtered[0] ?? trucks[0];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.brand}>TruckSpot</Text>
        <SectionTitle
          eyebrow="Live Truck Radar"
          title="Find the truck, the hours, and the real reviews before you leave."
          detail="Owners post directly. Diners track live stops, scan menus, and review the experience in the same place."
        />
      </View>

      <SyncBanner status={syncStatus} message={syncMessage} />

      <View style={styles.filterRow}>
        <TextInput
          value={query}
          onChangeText={(text) => startTransition(() => setQuery(text))}
          placeholder="Search trucks, cuisine, or neighborhood"
          placeholderTextColor={palette.muted}
          style={styles.search}
        />
        <View style={styles.switchWrap}>
          <Text style={styles.switchLabel}>Open now</Text>
          <Switch
            trackColor={{ false: palette.line, true: palette.accentSoft }}
            thumbColor={openOnly ? palette.accent : '#fff'}
            value={openOnly}
            onValueChange={setOpenOnly}
          />
        </View>
      </View>

      <View style={styles.mapWrap}>
        <LiveMap trucks={filtered} />
        {featured ? (
          <View style={styles.featuredPanel}>
            <Text style={styles.featuredLabel}>Closest live stop</Text>
            <Text style={styles.featuredTitle}>{featured.name}</Text>
            <Text style={styles.featuredMeta}>
              {featured.cuisine} - {averageRating(featured).toFixed(1)} stars - {featured.distance}
            </Text>
            <Text style={styles.featuredAddress}>{featured.address}</Text>
            <Link href={`/truck/${featured.id}`} asChild>
              <Pressable style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Open truck page</Text>
              </Pressable>
            </Link>
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionTitle
          eyebrow="Now serving"
          title={`${filtered.length} truck${filtered.length === 1 ? '' : 's'} on the map`}
          detail="The MVP already supports live owner updates, in-app menus, and review history."
        />
        <View style={styles.cardList}>
          {filtered.map((truck) => (
            <TruckCard key={truck.id} truck={truck} />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    gap: spacing.xl,
    padding: spacing.lg,
    paddingBottom: 120,
  },
  hero: {
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  brand: {
    color: palette.ink,
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: -1.4,
  },
  filterRow: {
    gap: spacing.md,
  },
  search: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: 18,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  switchWrap: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  switchLabel: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  mapWrap: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: 28,
    borderWidth: 1,
    overflow: 'hidden',
  },
  featuredPanel: {
    gap: spacing.xs,
    padding: spacing.lg,
  },
  featuredLabel: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  featuredTitle: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: '800',
  },
  featuredMeta: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  featuredAddress: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accent,
    borderRadius: 999,
    marginTop: spacing.sm,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  section: {
    gap: spacing.lg,
  },
  cardList: {
    gap: spacing.md,
  },
});
