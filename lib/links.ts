import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { normalizePublicUuid } from '@/lib/public-uuid';

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

const blockedPublicHostSuffixes = new Set([
  'corp',
  'example',
  'home',
  'internal',
  'invalid',
  'lan',
  'local',
  'localhost',
  'onion',
  'test',
]);

function publicHostnameIsSafe(hostname: string) {
  const host = hostname.toLocaleLowerCase('en-US');
  if (
    !host.includes('.') ||
    host.endsWith('.') ||
    host.startsWith('[') ||
    host.includes(':') ||
    /^[0-9.]+$/u.test(host) ||
    host.length > 253
  ) {
    return false;
  }

  const labels = host.split('.');
  if (blockedPublicHostSuffixes.has(labels.at(-1) ?? '')) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

export function safePublicHttpsUrl(value: string | undefined | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const authority = /^https:\/\/([^/?#]+)/iu.exec(trimmed)?.[1];
    const url = new URL(trimmed);
    if (
      !authority ||
      authority.includes(':') ||
      !/^[a-z0-9.-]+$/iu.test(authority) ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !publicHostnameIsSafe(url.hostname)
    ) {
      return null;
    }
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

export function parsePublicLocationRouteParam(
  value: string | string[] | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    return parsePublicLocationRouteParam(value[0]);
  }
  return normalizePublicUuid(value);
}

export function placeLocationRoutePath(
  route: 'place' | 'navigation' | 'order',
  placeId: string,
  locationId?: string,
) {
  const path = `/${route}/${encodeURIComponent(placeId)}`;
  const normalizedLocationId = parsePublicLocationRouteParam(locationId);
  return normalizedLocationId
    ? `${path}?location=${encodeURIComponent(normalizedLocationId)}`
    : path;
}

export function placeLocationRouteParams(placeId: string, locationId?: string) {
  const normalizedLocationId = parsePublicLocationRouteParam(locationId);
  return {
    id: placeId,
    ...(normalizedLocationId ? { location: normalizedLocationId } : {}),
  };
}

export function placeShareUrl(placeId: string, locationId?: string) {
  const path = `/place/${encodeURIComponent(placeId)}`;
  const normalizedLocationId = parsePublicLocationRouteParam(locationId);
  return appRouteUrl(path, normalizedLocationId ? { location: normalizedLocationId } : undefined);
}

export function profileShareUrl(profileId: string) {
  const path = `/profile/${encodeURIComponent(profileId)}`;
  return appRouteUrl(path);
}
