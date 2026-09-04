import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { featureFlags } from '@/lib/features';
import { parseNotificationRoute } from '@/lib/notification-routing';

if (featureFlags.pushNotifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export function RouteFocusManager() {
  const handledIdentifier = useRef<string | null>(null);

  useEffect(() => {
    if (!featureFlags.pushNotifications) return;

    const openResponse = (response: Notifications.NotificationResponse) => {
      const identifier = response.notification.request.identifier;
      if (handledIdentifier.current === identifier) return;
      handledIdentifier.current = identifier;
      void Notifications.clearLastNotificationResponseAsync();
      const route = parseNotificationRoute(response.notification.request.content.data?.route);
      if (route) router.push(route);
    };

    let active = true;
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (active && response) openResponse(response);
    }).catch(() => undefined);
    const subscription = Notifications.addNotificationResponseReceivedListener(openResponse);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return null;
}
