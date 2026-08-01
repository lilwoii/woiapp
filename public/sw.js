const CACHE_NAME = 'spottr-shell-v0.2.0-r3';
const SHELL = ['/', '/manifest.webmanifest', '/spottr-icon.png', '/spottr-icon-maskable.png'];
const REVALIDATE = new Set(['/manifest.webmanifest', '/register-sw.js', '/sw.js']);
const PRIVATE_NAVIGATION_PATHS = new Set([
  '/account-data',
  '/auth',
  '/business-onboarding',
  '/business-setup',
  '/business-team',
  '/profile',
  '/reset-password',
  '/security',
  '/studio',
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
