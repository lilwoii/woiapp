import { StyleSheet, Text, View } from 'react-native';

import { palette, spacing } from '@/constants/theme';

type Props = {
  eyebrow?: string;
  title: string;
  detail?: string;
};

export function SectionTitle({ eyebrow, title, detail }: Props) {
  return (
    <View style={styles.wrap}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 4,
  },
  eyebrow: {
    color: palette.accentDeep,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: '800',
  },
  detail: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
    paddingRight: spacing.lg,
  },
});
