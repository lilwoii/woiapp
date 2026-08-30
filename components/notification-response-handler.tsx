// TypeScript and non-native runtimes resolve this fail-closed implementation.
// Metro selects the platform-specific .native or .web component at bundle time.
export function NotificationResponseHandler() {
  return null;
}
