import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

function configuredOrigin() {
  const candidate = process.env.EXPO_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function publicAppOrigin() {
  const configured = configuredOrigin();
  if (configured) return configured;
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin;
  return null;
}

export function appRouteUrl(path: string, queryParams?: Record<string, string>) {
  const normalizedPath = `/${path.replace(/^\/+/, '')}`;
  const origin = publicAppOrigin();
  if (origin) {
    const url = new URL(normalizedPath, origin);
    for (const [key, value] of Object.entries(queryParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
  return Linking.createURL(normalizedPath, { queryParams });
}

export function safeHttpsUrl(value: string | undefined | null) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function phoneHref(value: string | undefined | null) {
  if (!value) return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

export function placeShareUrl(placeId: string) {
  const path = `/place/${encodeURIComponent(placeId)}`;
  return appRouteUrl(path);
}
