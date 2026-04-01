import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { SyncStatus } from '@/types/truck';

type Props = {
  status: SyncStatus;
  message: string;
};

const backgrounds: Record<SyncStatus, string> = {
  demo: '#EFE4CF',
  syncing: '#F7E9C5',
  live: '#DCEEE4',
  error: '#F3D7D0',
};

export function SyncBanner({ status, message }: Props) {
  return (
    <View style={[styles.banner, { backgroundColor: backgrounds[status] }]}>
      <Text style={styles.label}>{status.toUpperCase()}</Text>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 18,
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  label: {
    color: palette.ink,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  message: {
    color: palette.ink,
    fontSize: 13,
    lineHeight: 18,
  },
});
