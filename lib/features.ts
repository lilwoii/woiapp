function enabled(value: string | undefined) {
  return value?.trim().toLocaleLowerCase('en-US') === 'true';
}

export const featureFlags = Object.freeze({
  homeKitchens: enabled(process.env.EXPO_PUBLIC_HOME_KITCHENS_ENABLED),
  mediaUploads: enabled(process.env.EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED),
  pushNotifications: enabled(process.env.EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED),
  pickupOrdering: enabled(process.env.EXPO_PUBLIC_PICKUP_ORDERING_ENABLED),
});
