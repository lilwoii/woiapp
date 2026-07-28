import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Tabs } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';

import { palette } from '@/constants/theme';

export default function TabLayout() {
  const { width } = useWindowDimensions();
  const wideWeb = Platform.OS === 'web' && width >= 900;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.muted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '800',
          marginTop: 2,
        },
        tabBarStyle: {
          backgroundColor: 'rgba(255, 253, 248, 0.98)',
          borderColor: palette.line,
          borderRadius: wideWeb ? 24 : 0,
          borderTopColor: palette.line,
          borderWidth: wideWeb ? 1 : 0,
          borderTopWidth: 1,
          bottom: wideWeb ? 18 : 0,
          elevation: 8,
          height: wideWeb ? 72 : 84,
          left: wideWeb ? '50%' : 0,
          marginLeft: wideWeb ? -340 : 0,
          paddingBottom: wideWeb ? 8 : 18,
          paddingTop: 9,
          position: 'absolute',
          right: wideWeb ? undefined : 0,
          shadowColor: '#18211D',
          shadowOffset: { width: 0, height: 7 },
          shadowOpacity: wideWeb ? 0.12 : 0,
          shadowRadius: 16,
          width: wideWeb ? 680 : undefined,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Discover',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6 color={color} name="location-dot" size={focused ? 21 : 19} solid={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: 'Saved',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6 color={color} name="heart" size={focused ? 20 : 18} solid={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="studio"
        options={{
          title: 'Business',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6 color={color} name="store" size={focused ? 20 : 18} solid={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6 color={color} name="circle-user" size={focused ? 21 : 19} solid={focused} />
          ),
        }}
      />
    </Tabs>
  );
}

