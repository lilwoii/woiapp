function enabled(value: string | undefined) {
  return value?.trim().toLocaleLowerCase('en-US') === 'true';
}

export const featureFlags = Object.freeze({
  homeKitchens: enabled(process.env.EXPO_PUBLIC_HOME_KITCHENS_ENABLED),
  mediaUploads: enabled(process.env.EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED),
  pushNotifications: enabled(process.env.EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED),
  pickupOrdering: enabled(process.env.EXPO_PUBLIC_PICKUP_ORDERING_ENABLED),
  inAppNavigation: enabled(process.env.EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED),
  businessClaims: enabled(process.env.EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED),
  sponsoredPlacements: enabled(process.env.EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED),
});

// The database remains the authority for public eligibility. These client
// helpers only keep a disabled launch category out of public UI and local
// caches while the backend gate is unavailable, stale, or being bypassed by a
// deep link.
export const HOME_KITCHEN_UNAVAILABLE_REASON = 'This listing is unavailable.';
export const HOME_KITCHEN_CHAT_UNAVAILABLE_REASON = 'This conversation is unavailable.';

export function isHomeKitchenBlocked(kind: unknown) {
  return kind === 'home_kitchen' && !featureFlags.homeKitchens;
}

export function filterHomeKitchenPlaces<
  T extends { id: string; category: string },
>(places: readonly T[]): T[] {
  if (featureFlags.homeKitchens) return [...places];
  return places.filter(
    (place) => place.category !== 'home_kitchen',
  );
}
