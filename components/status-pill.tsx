import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { VenueStatus } from '@/types/marketplace';

const statusCopy: Record<VenueStatus, string> = {
  open: 'Open now',
  opening_soon: 'Opening soon',
  moving_soon: 'Moving soon',
  closed: 'Closed',
};

type Props = {
  status: VenueStatus;
  compact?: boolean;
};

export function StatusPill({ status, compact = false }: Props) {
  const live = status === 'open';
  const moving = status === 'moving_soon' || status === 'opening_soon';

  return (
    <View
      style={[
        styles.pill,
        live ? styles.live : moving ? styles.moving : styles.closed,
        compact && styles.compact,
      ]}>
      <View
        style={[
          styles.dot,
          live ? styles.liveDot : moving ? styles.movingDot : styles.closedDot,
        ]}
      />
      <Text
        style={[
          styles.label,
          live ? styles.liveText : moving ? styles.movingText : styles.closedText,
          compact && styles.compactText,
        ]}>
        {statusCopy[status]}
      </Text>
    </View>
  );
}

export function getStatusLabel(status: VenueStatus) {
  return statusCopy[status];
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  compact: {
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  live: {
    backgroundColor: palette.successSoft,
  },
  moving: {
    backgroundColor: palette.warningSoft,
  },
  closed: {
    backgroundColor: '#ECEDEB',
  },
  dot: {
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  liveDot: {
    backgroundColor: palette.success,
  },
  movingDot: {
    backgroundColor: palette.warning,
  },
  closedDot: {
    backgroundColor: palette.muted,
  },
  label: {
    fontSize: 12,
    fontWeight: '800',
  },
  compactText: {
    fontSize: 11,
  },
  liveText: {
    color: palette.success,
  },
  movingText: {
    color: palette.warning,
  },
  closedText: {
    color: palette.muted,
  },
});

