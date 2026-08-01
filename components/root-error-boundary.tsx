import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palette, radii, spacing } from '@/constants/theme';

export function RootErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    if (__DEV__) console.error(error);
  }, [error]);

  return (
    <SafeAreaView style={styles.screen}>
      <View accessibilityRole="alert" style={styles.panel}>
        <View style={styles.icon}>
          <FontAwesome6 color={palette.accentDeep} name="triangle-exclamation" size={22} />
        </View>
        <Text accessibilityRole="header" style={styles.title}>Spottr hit an unexpected problem.</Text>
        <Text style={styles.body}>
          Retry this screen, or reopen the app if the issue continues. Check the last action you
          submitted before trying it again.
        </Text>
        {__DEV__ ? <Text style={styles.debug}>{error.message}</Text> : null}
        <Pressable accessibilityRole="button" onPress={retry} style={styles.button}>
          <Text style={styles.buttonText}>Retry screen</Text>
          <FontAwesome6 color="#FFFFFF" name="rotate-right" size={12} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: 'center',
    backgroundColor: palette.bg,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  panel: {
    alignItems: 'flex-start',
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.md,
    maxWidth: 560,
    padding: spacing.xl,
    width: '100%',
  },
  icon: {
    alignItems: 'center',
    backgroundColor: palette.accentSoft,
    borderRadius: 999,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  title: {
    color: palette.ink,
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  body: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 22,
  },
  debug: {
    color: palette.accentDeep,
    fontFamily: 'SpaceMono',
    fontSize: 10,
    lineHeight: 16,
  },
  button: {
    alignItems: 'center',
    backgroundColor: palette.accentDeep,
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
});
