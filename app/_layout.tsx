import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { MarketplaceStoreProvider } from '@/context/marketplace-store';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#F6F3EC',
    card: '#FFFDF8',
    primary: '#F15A3A',
    text: '#191D1B',
    border: '#DEDCD4',
  },
};

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <MarketplaceStoreProvider>
      <ThemeProvider value={theme}>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShadowVisible: false,
            headerShown: false,
            headerStyle: { backgroundColor: '#FFFDF8' },
            headerTitleStyle: { color: '#191D1B', fontWeight: '800' },
          }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="place/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="auth" options={{ headerShown: false, presentation: 'modal' }} />
          <Stack.Screen name="business-onboarding" options={{ headerShown: false }} />
        </Stack>
      </ThemeProvider>
    </MarketplaceStoreProvider>
  );
}
