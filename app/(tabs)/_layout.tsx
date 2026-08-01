import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { Tabs } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';

import { palette } from '@/constants/theme';

export default function TabLayout() {
  const { width } = useWindowDimensions();
  // React Navigation reserves a full material sidebar column for left tabs.
  // Keep the compact bottom rail until the viewport can hold that column plus
  // Spottr's 1,240 px workspace without squeezing the map.
  const wideWeb = Platform.OS === 'web' && width >= 1600;

  return (
    <Tabs
      detachInactiveScreens
      screenOptions={{
        lazy: true,
        headerShown: false,
        tabBarPosition: wideWeb ? 'left' : 'bottom',
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
          borderRadius: 0,
          borderRightColor: wideWeb ? palette.line : undefined,
          borderRightWidth: wideWeb ? 1 : 0,
          borderTopColor: palette.line,
          borderWidth: 0,
          borderTopWidth: 1,
          elevation: 8,
          height: wideWeb ? undefined : 84,
          paddingBottom: wideWeb ? 18 : 18,
          paddingHorizontal: wideWeb ? 10 : 0,
          paddingTop: wideWeb ? 18 : 9,
          width: wideWeb ? 112 : undefined,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Discover',
          tabBarAccessibilityLabel: 'Discover nearby food',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6
              accessibilityElementsHidden
              color={color}
              importantForAccessibility="no-hide-descendants"
              name="location-dot"
              size={focused ? 21 : 19}
              solid={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: 'Saved',
          tabBarAccessibilityLabel: 'Saved places',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6 accessibilityElementsHidden color={color} name="heart" size={focused ? 20 : 18} solid={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="studio"
        options={{
          title: 'Business',
          tabBarAccessibilityLabel: 'Business studio',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6 color={color} name="store" size={focused ? 20 : 18} solid={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarAccessibilityLabel: 'Profile and settings',
          tabBarIcon: ({ color, focused }) => (
            <FontAwesome6 color={color} name="circle-user" size={focused ? 21 : 19} solid={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
