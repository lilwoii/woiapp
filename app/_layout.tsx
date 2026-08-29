import FontAwesome from '@expo/vector-icons/FontAwesome';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { StatusBar } from 'expo-status-bar';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { useEffect } from 'react';
import 'react-native-reanimated';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { AuthProvider } from '@/context/auth-context';
import { MarketplaceStoreProvider } from '@/context/marketplace-store';
import { RouteFocusManager } from '@/components/route-focus-manager';
export { RootErrorBoundary as ErrorBoundary } from '@/components/root-error-boundary';

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
    ...FontAwesome6.font,
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
    <SafeAreaProvider>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <AuthProvider>
          <MarketplaceStoreProvider>
            <ThemeProvider value={theme}>
              <Head>
                <title>Spottr · Live local food, mapped</title>
              </Head>
              <StatusBar style="dark" />
              <RouteFocusManager />
              <Stack
                screenOptions={{
                  headerShadowVisible: false,
                  headerShown: false,
                  headerStyle: { backgroundColor: '#FFFDF8' },
                  headerTitleStyle: { color: '#191D1B', fontWeight: '800' },
                  title: 'Spottr · Live local food, mapped',
                }}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="place/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="profile/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="profile-edit" options={{ headerShown: false }} />
                <Stack.Screen name="creator-invite" options={{ headerShown: false }} />
                <Stack.Screen name="creator-invitations" options={{ headerShown: false }} />
                <Stack.Screen name="promotion-studio" options={{ headerShown: false }} />
                <Stack.Screen name="navigation/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="order/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="messages/index" options={{ headerShown: false }} />
                <Stack.Screen name="messages/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="auth" options={{ headerShown: false, presentation: 'modal' }} />
                <Stack.Screen name="business-onboarding" options={{ headerShown: false }} />
                <Stack.Screen name="business-setup" options={{ headerShown: false }} />
                <Stack.Screen name="business-team" options={{ headerShown: false }} />
                <Stack.Screen name="business-profile" options={{ headerShown: false }} />
                <Stack.Screen name="business-posts" options={{ headerShown: false }} />
                <Stack.Screen name="business-marketplace" options={{ headerShown: false }} />
                <Stack.Screen name="badges" options={{ headerShown: false }} />
                <Stack.Screen name="report" options={{ headerShown: false, presentation: 'modal' }} />
                <Stack.Screen name="privacy" options={{ headerShown: false }} />
                <Stack.Screen name="safety" options={{ headerShown: false }} />
                <Stack.Screen name="legal" options={{ headerShown: false }} />
                <Stack.Screen name="account-data" options={{ headerShown: false }} />
                <Stack.Screen name="reset-password" options={{ headerShown: false, presentation: 'modal' }} />
                <Stack.Screen name="security" options={{ headerShown: false }} />
                <Stack.Screen name="moderation" options={{ headerShown: false }} />
                <Stack.Screen name="marketplace-moderation" options={{ headerShown: false }} />
                <Stack.Screen name="business-submission-moderation" options={{ headerShown: false }} />
              </Stack>
            </ThemeProvider>
          </MarketplaceStoreProvider>
        </AuthProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
