import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { StyleSheet, Text, View } from 'react-native';

import { palette, radii, spacing } from '@/constants/theme';
import { BusinessUpdate } from '@/types/marketplace';

const updateIcons: Record<BusinessUpdate['type'], keyof typeof FontAwesome6.glyphMap> = {
  availability: 'utensils',
  hours: 'clock',
  location: 'location-arrow',
  menu: 'receipt',
};

type Props = {
  update: BusinessUpdate;
  dark?: boolean;
};

export function OwnerUpdate({ update, dark = false }: Props) {
  return (
    <View style={[styles.wrap, dark && styles.dark]}>
      <View style={[styles.icon, dark && styles.iconDark]}>
        <FontAwesome6 color={dark ? '#FFFFFF' : palette.accent} name={updateIcons[update.type]} size={13} />
      </View>
      <View style={styles.copy}>
        <View style={styles.metaRow}>
          <Text style={[styles.label, dark && styles.labelDark]}>Update from the owner</Text>
          <Text style={[styles.time, dark && styles.timeDark]}>{update.createdAt}</Text>
        </View>
        <Text style={[styles.message, dark && styles.messageDark]}>{update.message}</Text>
        <Text style={[styles.expiry, dark && styles.timeDark]}>{update.expiresAt}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'flex-start',
    backgroundColor: palette.accentSoft,
    borderRadius: radii.lg,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  dark: {
    backgroundColor: '#243D39',
  },
  icon: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  iconDark: {
    backgroundColor: palette.accent,
  },
  copy: {
    flex: 1,
    gap: 5,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  label: {
    color: palette.accentDeep,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  labelDark: {
    color: '#FFFFFF',
  },
  time: {
    color: palette.accentDeep,
    fontSize: 11,
  },
  timeDark: {
    color: palette.darkMuted,
  },
  message: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  messageDark: {
    color: '#FFFFFF',
  },
  expiry: {
    color: palette.muted,
    fontSize: 11,
  },
});

