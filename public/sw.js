const CACHE_NAME = 'spottr-shell-v0.2.0-r5';
const SHELL = ['/', '/manifest.webmanifest', '/spottr-icon.png', '/spottr-icon-maskable.png'];
const REVALIDATE = new Set(['/manifest.webmanifest', '/register-sw.js', '/sw.js']);
const PRIVATE_NAVIGATION_PATHS = new Set([
  '/account-data',
  '/auth',
  '/business-onboarding',
  '/business-setup',
  '/business-team',
  '/profile',
  '/orders',
  '/reset-password',
  '/security',
  '/studio',
]);
const PLACE_ROUTE = /^\/place\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NOTIFICATION_BODIES = new Set([
  'A place you follow has a new update.',
  'A place you follow updated its location.',
  'Something is available again at a place you follow.',
]);

function isPrivateNavigation(url) {
  if (PRIVATE_NAVIGATION_PATHS.has(url.pathname)) return true;
  if (url.pathname.startsWith('/business-setup/')) return true;
  if (url.search) return true;
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

async function navigationResponse(request) {
  const url = new URL(request.url);
  const privateNavigation = isPrivateNavigation(url);
  try {
    const response = await fetch(request);
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (response.ok && !privateNavigation && !cacheControl.includes('no-store')) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (privateNavigation) return Response.error();
    return (await caches.match(request)) ?? (await caches.match('/')) ?? Response.error();
  }
}

async function staticResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic' && response.headers.get('cache-control') !== 'no-store') {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.well-known/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (REVALIDATE.has(url.pathname)) {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (/\.(?:css|js|json|png|jpg|jpeg|webp|svg|woff2?)$/i.test(url.pathname)) {
    event.respondWith(staticResponse(request));
  }
});

function safePushPayload(event) {
  const fallback = {
    body: 'A place you follow has a new update.',
    eventId: null,
    route: '/',
  };
  if (!event.data) return fallback;
  try {
    const value = event.data.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const data = value.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fallback;
    if (
      value.title !== 'Spottr' || !SAFE_NOTIFICATION_BODIES.has(value.body) ||
      typeof data.route !== 'string' || !PLACE_ROUTE.test(data.route) ||
      typeof data.eventId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(data.eventId)
    ) return fallback;
    return { body: value.body, eventId: data.eventId, route: data.route };
  } catch {
    return fallback;
  }
}

self.addEventListener('push', (event) => {
  const payload = safePushPayload(event);
  event.waitUntil(self.registration.showNotification('Spottr', {
    body: payload.body,
    icon: '/spottr-icon.png',
    badge: '/spottr-icon-maskable.png',
    tag: payload.eventId ? `spottr-event-${payload.eventId}` : 'spottr-update',
    renotify: false,
    data: { route: payload.route },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedRoute = event.notification.data?.route;
  const route = typeof requestedRoute === 'string' && PLACE_ROUTE.test(requestedRoute)
    ? requestedRoute
    : '/';
  const destination = new URL(route, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const exact = windows.find((client) => client.url === destination);
    if (exact) return exact.focus();
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ('navigate' in existing) await existing.navigate(destination);
      return existing.focus();
    }
    return self.clients.openWindow(destination);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) =>
      Promise.all(clients.map((client) => client.postMessage({ type: 'spottr:push-subscription-changed' })))
    )
  );
});
