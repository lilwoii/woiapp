import { useIsFocused } from 'expo-router';
import { PropsWithChildren } from 'react';

export function FocusAwareScreen({ children }: PropsWithChildren) {
  const focused = useIsFocused();
  return (
    <div aria-hidden={!focused} inert={focused ? undefined : true} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
