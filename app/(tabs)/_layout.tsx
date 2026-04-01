import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Tabs } from 'expo-router';

import { palette } from '@/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.muted,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.line,
          height: 88,
          paddingTop: 10,
        },
        headerStyle: { backgroundColor: palette.surface },
        headerShadowVisible: false,
        headerTitleStyle: { color: palette.ink, fontWeight: '800' },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Discover',
          tabBarIcon: ({ color }) => <FontAwesome6 color={color} name="location-dot" size={20} />,
        }}
      />
      <Tabs.Screen
        name="owners"
        options={{
          title: 'Owners',
          tabBarIcon: ({ color }) => <FontAwesome6 color={color} name="truck-fast" size={20} />,
        }}
      />
      <Tabs.Screen
        name="reviews"
        options={{
          title: 'Reviews',
          tabBarIcon: ({ color }) => <FontAwesome6 color={color} name="message" size={20} />,
        }}
      />
    </Tabs>
  );
}
