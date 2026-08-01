import { useIsFocused } from 'expo-router';
import { PropsWithChildren } from 'react';
import { View } from 'react-native';

export function FocusAwareScreen({ children }: PropsWithChildren) {
  const focused = useIsFocused();
  return (
    <View
      accessibilityElementsHidden={!focused}
      importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}
      style={{ flex: 1 }}>
      {children}
    </View>
  );
}
