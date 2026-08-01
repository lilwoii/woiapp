import { PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

type Props = PropsWithChildren<{
  narrow?: boolean;
}>;

export function PageShell({ children, narrow = false }: Props) {
  return <View role="main" style={[styles.shell, narrow && styles.narrow]}>{children}</View>;
}

const styles = StyleSheet.create({
  shell: {
    alignSelf: 'center',
    maxWidth: 1240,
    width: '100%',
  },
  narrow: {
    maxWidth: 820,
  },
});
