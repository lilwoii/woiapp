import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Link } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { OwnerUpdate } from '@/components/owner-update';
import { PageShell } from '@/components/page-shell';
import { SectionHeading } from '@/components/section-heading';
import { StatusPill } from '@/components/status-pill';
import { palette, radii, spacing } from '@/constants/theme';
import { useMarketplaceStore } from '@/context/marketplace-store';
import { BusinessUpdate, VenueStatus } from '@/types/marketplace';

const updateTypes: { id: BusinessUpdate['type']; label: string; icon: keyof typeof FontAwesome6.glyphMap }[] = [
  { id: 'availability', label: 'Sold out / available', icon: 'utensils' },
  { id: 'location', label: 'Location', icon: 'location-arrow' },
  { id: 'hours', label: 'Hours', icon: 'clock' },
  { id: 'menu', label: 'Menu', icon: 'receipt' },
];

const quickStatuses: { id: VenueStatus; label: string; icon: keyof typeof FontAwesome6.glyphMap }[] = [
  { id: 'open', label: 'Go live', icon: 'signal' },
  { id: 'moving_soon', label: 'Moving soon', icon: 'truck-fast' },
  { id: 'closed', label: 'Close early', icon: 'door-closed' },
];

export default function StudioScreen() {
  const { places, publishUpdate, setVenueStatus } = useMarketplaceStore();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const place = useMemo(() => places.find((entry) => entry.id === 'copper-coyote') ?? places[0], [places]);
  const [message, setMessage] = useState('');
  const [updateType, setUpdateType] = useState<BusinessUpdate['type']>('availability');
  const [soldOutIds, setSoldOutIds] = useState<string[]>(['aguas']);

  if (!place) return null;

  const publish = () => {
    const result = publishUpdate({ placeId: place.id, type: updateType, message });
    if (!result.ok) {
      Alert.alert('Update needs attention', result.reason);
      return;
    }

    setMessage('');
    Alert.alert('Update is live', 'Followers can see it now. It will expire automatically.');
  };

  const toggleSoldOut = (id: string) => {
    setSoldOutIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.screen}>
      <PageShell>
        <View style={styles.topbar}>
          <BrandMark />
          <View style={styles.secureBadge}>
            <FontAwesome6 color={palette.success} name="shield-halved" size={12} />
            <Text style={styles.secureText}>Owner access</Text>
          </View>
        </View>

        <View style={styles.businessHeader}>
          <View style={styles.businessIdentity}>
            <View style={styles.logoFallback}>
              <FontAwesome6 color="#FFFFFF" name="truck" size={20} />
            </View>
            <View style={styles.businessCopy}>
              <View style={styles.nameRow}>
                <Text style={styles.businessName}>{place.name}</Text>
                <FontAwesome6 color={palette.success} name="circle-check" size={16} solid />
              </View>
              <Text style={styles.businessMeta}>Food truck · Owner · Public listing</Text>
            </View>
          </View>
          <StatusPill status={place.status} />
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Business studio</Text>
          <Text style={styles.title}>Run today’s service in a few taps.</Text>
          <Text style={styles.subtitle}>
            Keep your location, availability, menu, and payments accurate without posting across five different places.
          </Text>
        </View>

        <View style={styles.quickActions}>
          {quickStatuses.map((action) => {
            const active = place.status === action.id;
            return (
              <Pressable
                key={action.id}
                onPress={() => setVenueStatus(place.id, action.id)}
                style={[styles.quickAction, active && styles.quickActionActive]}>
                <View style={[styles.quickIcon, active && styles.quickIconActive]}>
                  <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={action.icon} size={15} />
                </View>
                <Text style={[styles.quickLabel, active && styles.quickLabelActive]}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>1,284</Text>
            <Text style={styles.statLabel}>Listing views · 7 days</Text>
            <Text style={styles.statTrend}>↑ 18%</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>376</Text>
            <Text style={styles.statLabel}>Direction taps</Text>
            <Text style={styles.statTrend}>↑ 9%</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>94%</Text>
            <Text style={styles.statLabel}>Location reliability</Text>
            <Text style={styles.statQuiet}>Strong</Text>
          </View>
        </View>

        <View style={[styles.columns, wide && styles.columnsWide]}>
          <View style={[styles.mainColumn, wide && styles.mainColumnWide]}>
            <View style={styles.panel}>
              <SectionHeading
                detail="Short, professional, and automatically removed after six hours."
                eyebrow="Live signal"
                title="Post an owner update"
              />

              <ScrollView
                contentContainerStyle={styles.typeRow}
                horizontal
                showsHorizontalScrollIndicator={false}>
                {updateTypes.map((type) => {
                  const active = updateType === type.id;
                  return (
                    <Pressable
                      key={type.id}
                      onPress={() => setUpdateType(type.id)}
                      style={[styles.typeChip, active && styles.typeChipActive]}>
                      <FontAwesome6 color={active ? '#FFFFFF' : palette.ink} name={type.icon} size={12} />
                      <Text style={[styles.typeText, active && styles.typeTextActive]}>{type.label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <View style={styles.composer}>
                <TextInput
                  maxLength={120}
                  multiline
                  onChangeText={setMessage}
                  placeholder="Example: Brisket is sold out. Tacos and veggie bowls are still serving."
                  placeholderTextColor={palette.mutedLight}
                  style={styles.composerInput}
                  textAlignVertical="top"
                  value={message}
                />
                <View style={styles.composerFooter}>
                  <View style={styles.moderationNote}>
                    <FontAwesome6 color={palette.success} name="wand-magic-sparkles" size={11} />
                    <Text style={styles.moderationText}>Professional language filter on</Text>
                  </View>
                  <Text style={styles.counter}>{message.length}/120</Text>
                </View>
              </View>

              <Pressable onPress={publish} style={styles.publishButton}>
                <Text style={styles.publishText}>Publish update</Text>
                <FontAwesome6 color="#FFFFFF" name="arrow-up-right-from-square" size={12} />
              </Pressable>

              {place.update ? (
                <View style={styles.currentUpdate}>
                  <Text style={styles.currentLabel}>Currently visible</Text>
                  <OwnerUpdate update={place.update} />
                </View>
              ) : null}
            </View>

            <View style={styles.panel}>
              <SectionHeading
                detail="Prices are stored as currency values and availability can change instantly."
                eyebrow="Menu"
                title="Today’s menu"
              />
              <View style={styles.menuList}>
                {place.menu.flatMap((section) =>
                  section.items.map((item) => {
                    const soldOut = soldOutIds.includes(item.id);
                    return (
                      <View key={item.id} style={styles.menuRow}>
                        <View style={styles.menuCopy}>
                          <Text style={[styles.menuName, soldOut && styles.soldOutName]}>{item.name}</Text>
                          <Text numberOfLines={1} style={styles.menuDescription}>
                            {item.description}
                          </Text>
                        </View>
                        <Text style={styles.menuPrice}>${item.price.toFixed(0)}</Text>
                        <Pressable
                          onPress={() => toggleSoldOut(item.id)}
                          style={[styles.availabilityButton, soldOut && styles.availabilityButtonActive]}>
                          <Text style={[styles.availabilityText, soldOut && styles.availabilityTextActive]}>
                            {soldOut ? 'Sold out' : 'Available'}
                          </Text>
                        </Pressable>
                      </View>
                    );
                  })
                )}
              </View>
              <Pressable style={styles.secondaryButton}>
                <FontAwesome6 color={palette.ink} name="plus" size={12} />
                <Text style={styles.secondaryButtonText}>Add menu item</Text>
              </Pressable>
            </View>
          </View>

          <View style={[styles.sideColumn, wide && styles.sideColumnWide]}>
            <View style={styles.sidePanel}>
              <View style={styles.sideHeader}>
                <Text style={styles.sideTitle}>Today’s stop</Text>
                <Pressable>
                  <Text style={styles.editText}>Edit</Text>
                </Pressable>
              </View>
              <View style={styles.locationPreview}>
                <FontAwesome6 color={palette.accent} name="location-dot" size={18} solid />
                <View style={styles.locationCopy}>
                  <Text style={styles.locationName}>{place.address}</Text>
                  <Text style={styles.locationDetail}>{place.city}, CA {place.postalCode}</Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <FontAwesome6 color={palette.muted} name="clock" size={13} />
                <Text style={styles.detailText}>{place.todayHours}</Text>
              </View>
              <View style={styles.detailRow}>
                <FontAwesome6 color={palette.muted} name="location-crosshairs" size={13} />
                <Text style={styles.detailText}>Pin confirmed just now</Text>
              </View>
            </View>

            <View style={styles.sidePanel}>
              <View style={styles.sideHeader}>
                <Text style={styles.sideTitle}>Payments</Text>
                <Pressable>
                  <Text style={styles.editText}>Edit</Text>
                </Pressable>
              </View>
              <View style={styles.paymentWrap}>
                {place.payments.map((payment) => (
                  <View key={payment} style={styles.paymentChip}>
                    <FontAwesome6 color={palette.ink} name="check" size={10} />
                    <Text style={styles.paymentText}>{payment}</Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.sidePanel}>
              <View style={styles.sideHeader}>
                <Text style={styles.sideTitle}>Team access</Text>
                <FontAwesome6 color={palette.success} name="lock" size={12} />
              </View>
              <View style={styles.teamRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>MR</Text>
                </View>
                <View style={styles.teamCopy}>
                  <Text style={styles.teamName}>Mateo Ruiz</Text>
                  <Text style={styles.teamRole}>Owner · MFA enabled</Text>
                </View>
              </View>
              <Pressable style={styles.secondaryButton}>
                <FontAwesome6 color={palette.ink} name="user-plus" size={12} />
                <Text style={styles.secondaryButtonText}>Invite manager</Text>
              </Pressable>
            </View>

            <Link href="/business-onboarding" asChild>
              <Pressable style={styles.onboardingLink}>
                <View>
                  <Text style={styles.onboardingTitle}>Add or claim a business</Text>
                  <Text style={styles.onboardingDetail}>Start a separate verified listing.</Text>
                </View>
                <FontAwesome6 color={palette.ink} name="arrow-right" size={13} />
              </Pressable>
            </Link>
          </View>
        </View>
      </PageShell>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: palette.bg,
    flex: 1,
  },
  content: {
    paddingBottom: 132,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  topbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  secureBadge: {
    alignItems: 'center',
    backgroundColor: palette.successSoft,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secureText: {
    color: palette.success,
    fontSize: 11,
    fontWeight: '900',
  },
  businessHeader: {
    alignItems: 'center',
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  businessIdentity: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  logoFallback: {
    alignItems: 'center',
    backgroundColor: palette.accent,
    borderRadius: radii.md,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  businessCopy: {
    gap: 4,
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  businessName: {
    color: palette.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  businessMeta: {
    color: palette.muted,
    fontSize: 11,
  },
  hero: {
    gap: spacing.sm,
    marginTop: spacing.xxxl,
    maxWidth: 720,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 43,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 46,
  },
  subtitle: {
    color: palette.muted,
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 620,
  },
  quickActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  quickAction: {
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minWidth: 150,
    padding: spacing.md,
  },
  quickActionActive: {
    backgroundColor: palette.dark,
    borderColor: palette.dark,
  },
  quickIcon: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: 999,
    height: 35,
    justifyContent: 'center',
    width: 35,
  },
  quickIconActive: {
    backgroundColor: palette.accent,
  },
  quickLabel: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  quickLabelActive: {
    color: '#FFFFFF',
  },
  stats: {
    borderBottomColor: palette.line,
    borderTopColor: palette.line,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.xxl,
  },
  stat: {
    flex: 1,
    gap: 5,
    minWidth: 145,
    paddingVertical: spacing.lg,
  },
  statValue: {
    color: palette.ink,
    fontSize: 27,
    fontWeight: '900',
    letterSpacing: -1,
  },
  statLabel: {
    color: palette.muted,
    fontSize: 11,
  },
  statTrend: {
    color: palette.success,
    fontSize: 11,
    fontWeight: '800',
  },
  statQuiet: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  columns: {
    gap: spacing.lg,
    marginTop: spacing.xxl,
  },
  columnsWide: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  mainColumn: {
    gap: spacing.lg,
  },
  mainColumnWide: {
    flex: 1.2,
  },
  sideColumn: {
    gap: spacing.lg,
  },
  sideColumnWide: {
    flex: 0.8,
  },
  panel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  typeRow: {
    gap: spacing.sm,
  },
  typeChip: {
    alignItems: 'center',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  typeChipActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  typeText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '800',
  },
  typeTextActive: {
    color: '#FFFFFF',
  },
  composer: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  composerInput: {
    color: palette.ink,
    fontSize: 14,
    lineHeight: 21,
    minHeight: 100,
    padding: spacing.md,
  },
  composerFooter: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  moderationNote: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  moderationText: {
    color: palette.success,
    fontSize: 10,
    fontWeight: '700',
  },
  counter: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 10,
  },
  publishButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: palette.accent,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 17,
    paddingVertical: 12,
  },
  publishText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  currentUpdate: {
    borderTopColor: palette.line,
    borderTopWidth: 1,
    gap: spacing.sm,
    paddingTop: spacing.lg,
  },
  currentLabel: {
    color: palette.muted,
    fontFamily: 'SpaceMono',
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  menuList: {
    gap: 0,
  },
  menuRow: {
    alignItems: 'center',
    borderTopColor: palette.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  menuCopy: {
    flex: 1,
    gap: 4,
  },
  menuName: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  soldOutName: {
    color: palette.muted,
    textDecorationLine: 'line-through',
  },
  menuDescription: {
    color: palette.muted,
    fontSize: 10,
  },
  menuPrice: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  availabilityButton: {
    backgroundColor: palette.successSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  availabilityButtonActive: {
    backgroundColor: '#ECEDEB',
  },
  availabilityText: {
    color: palette.success,
    fontSize: 9,
    fontWeight: '900',
  },
  availabilityTextActive: {
    color: palette.muted,
  },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: palette.line,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  sidePanel: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  sideHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sideTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  editText: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
  },
  locationPreview: {
    alignItems: 'flex-start',
    backgroundColor: palette.bg,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  locationCopy: {
    flex: 1,
    gap: 3,
  },
  locationName: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  locationDetail: {
    color: palette.muted,
    fontSize: 10,
  },
  detailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  detailText: {
    color: palette.muted,
    fontSize: 11,
  },
  paymentWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  paymentChip: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  paymentText: {
    color: palette.ink,
    fontSize: 10,
    fontWeight: '800',
  },
  teamRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: palette.dark,
    borderRadius: 999,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  teamCopy: {
    flex: 1,
    gap: 3,
  },
  teamName: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  teamRole: {
    color: palette.muted,
    fontSize: 10,
  },
  onboardingLink: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  onboardingTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  onboardingDetail: {
    color: palette.muted,
    fontSize: 10,
    marginTop: 4,
  },
});

