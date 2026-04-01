import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';

import { SectionTitle } from '@/components/section-title';
import { SyncBanner } from '@/components/sync-banner';
import { palette, spacing } from '@/constants/theme';
import { useTruckStore } from '@/context/truck-store';
import { TruckStatus } from '@/types/truck';

const statuses: TruckStatus[] = ['Open now', 'Moving soon', 'Closed'];

export default function OwnersScreen() {
  const { postOwnerUpdate, syncMessage, syncStatus, trucks } = useTruckStore();
  const [truckName, setTruckName] = useState('');
  const [cuisine, setCuisine] = useState('');
  const [address, setAddress] = useState('');
  const [hoursLabel, setHoursLabel] = useState('');
  const [description, setDescription] = useState('');
  const [menuLines, setMenuLines] = useState('Brisket Plate - $18\nHouse Lemonade - $5');
  const [status, setStatus] = useState<TruckStatus>('Open now');

  const submit = () => {
    if (!truckName.trim() || !cuisine.trim() || !address.trim() || !hoursLabel.trim()) {
      Alert.alert('Missing info', 'Add the truck name, cuisine, address, and hours before posting.');
      return;
    }

    const savedTruck = postOwnerUpdate({
      truckName,
      cuisine,
      address,
      hoursLabel,
      menuLines,
      status,
      description: description.trim() || 'Owner-posted live update',
    });

    Alert.alert('Update posted', `${savedTruck.name} is now live in the app.`);
    router.push(`/truck/${savedTruck.id}`);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionTitle
        eyebrow="Owner console"
        title="Post your live stop, business hours, and menu in one move."
        detail="This screen is built for truck owners to keep the listing fresh without sending customers through social posts and comment threads."
      />

      <SyncBanner status={syncStatus} message={syncMessage} />

      <View style={styles.form}>
        <TextInput
          placeholder="Truck name"
          placeholderTextColor={palette.muted}
          style={styles.input}
          value={truckName}
          onChangeText={setTruckName}
        />
        <TextInput
          placeholder="Cuisine"
          placeholderTextColor={palette.muted}
          style={styles.input}
          value={cuisine}
          onChangeText={setCuisine}
        />
        <TextInput
          placeholder="Current address / lot"
          placeholderTextColor={palette.muted}
          style={styles.input}
          value={address}
          onChangeText={setAddress}
        />
        <TextInput
          placeholder="Hours, for example Today 11:00 AM - 7:00 PM"
          placeholderTextColor={palette.muted}
          style={styles.input}
          value={hoursLabel}
          onChangeText={setHoursLabel}
        />
        <TextInput
          placeholder="Short truck description"
          placeholderTextColor={palette.muted}
          style={[styles.input, styles.multiline]}
          multiline
          value={description}
          onChangeText={setDescription}
        />
        <TextInput
          placeholder="Menu lines, one per row. Example: Taco Trio - $14"
          placeholderTextColor={palette.muted}
          style={[styles.input, styles.multiline]}
          multiline
          value={menuLines}
          onChangeText={setMenuLines}
        />

        <View style={styles.statusRow}>
          {statuses.map((option) => (
            <Pressable
              key={option}
              style={[styles.statusChip, status === option && styles.statusChipActive]}
              onPress={() => setStatus(option)}>
              <Text style={[styles.statusChipText, status === option && styles.statusChipTextActive]}>
                {option}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable style={styles.submitButton} onPress={submit}>
          <Text style={styles.submitText}>Publish live update</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <SectionTitle
          eyebrow="Already live"
          title="Current truck pages"
          detail="Existing listings can be updated by posting the same truck name again."
        />
        <View style={styles.list}>
          {trucks.map((truck) => (
            <View key={truck.id} style={styles.row}>
              <View style={[styles.dot, { backgroundColor: truck.accent }]} />
              <View style={styles.rowContent}>
                <Text style={styles.rowTitle}>{truck.name}</Text>
                <Text style={styles.rowMeta}>
                  {truck.status} - {truck.hoursLabel}
                </Text>
              </View>
            </View>
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
  form: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: 28,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 18,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  multiline: {
    minHeight: 110,
    paddingTop: 14,
    textAlignVertical: 'top',
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statusChip: {
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  statusChipActive: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  statusChipText: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  statusChipTextActive: {
    color: '#fff',
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: palette.ink,
    borderRadius: 999,
    paddingVertical: 14,
  },
  submitText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  section: {
    gap: spacing.lg,
  },
  list: {
    gap: spacing.md,
  },
  row: {
    alignItems: 'center',
    backgroundColor: palette.card,
    borderColor: palette.line,
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  dot: {
    borderRadius: 999,
    height: 12,
    width: 12,
  },
  rowContent: {
    flex: 1,
    gap: 4,
  },
  rowTitle: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  rowMeta: {
    color: palette.muted,
    fontSize: 13,
  },
});
