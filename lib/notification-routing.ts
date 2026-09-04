const placeNotificationRoute = /^\/place\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function parseNotificationRoute(value: unknown): `/place/${string}` | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = placeNotificationRoute.exec(value);
  return match ? `/place/${match[1]}` : null;
}
