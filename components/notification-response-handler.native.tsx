import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { featureFlags } from '@/lib/features';
import { parseNotificationRoute } from '@/lib/notification-routing';

export function NotificationResponseHandler() {
  const handledIdentifier = useRef<string | null>(null);

  useEffect(() => {
    if (!featureFlags.pushNotifications) return;

    const openResponse = (response: Notifications.NotificationResponse) => {
      const identifier = response.notification.request.identifier;
      if (handledIdentifier.current === identifier) return;
      const route = parseNotificationRoute(response.notification.request.content.data?.route);
      if (!route) return;
      handledIdentifier.current = identifier;
      router.push(route);
      void Notifications.clearLastNotificationResponseAsync();
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
