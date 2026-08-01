import { Platform, StyleSheet, Text, View } from 'react-native';

import { palette, spacing } from '@/constants/theme';

type Props = {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: React.ReactNode;
};

export function SectionHeading({ eyebrow, title, detail, action }: Props) {
  const webHeadingLevel = Platform.OS === 'web' ? ({ 'aria-level': 2 } as const) : {};

  return (
    <View style={styles.row}>
      <View style={styles.copy}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text accessibilityRole="header" {...webHeadingLevel} style={styles.title}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: spacing.lg,
    justifyContent: 'space-between',
  },
  copy: {
    flex: 1,
    gap: 7,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: -0.8,
    lineHeight: 31,
  },
  detail: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    maxWidth: 620,
  },
});
