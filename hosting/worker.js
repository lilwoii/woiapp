function allowedMapOrigins(env) {
  return (env.SPOTTR_MAP_CSP_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' ? [url.origin] : [];
      } catch {
        return [];
      }
    });
}

function configuredSupabaseOrigins(env) {
  try {
    const url = new URL(env.EXPO_PUBLIC_SUPABASE_URL ?? '');
    if (url.protocol !== 'https:') return [];
    return [url.origin, `wss://${url.host}`];
  } catch {
    return [];
  }
}

function htmlHeaders(env) {
  const mapOrigins = allowedMapOrigins(env).join(' ');
  const configuredSupabase = configuredSupabaseOrigins(env);
  const supabaseOrigins = configuredSupabase.join(' ');
  const supabaseImageOrigins = configuredSupabase
    .filter((origin) => origin.startsWith('https://'))
    .join(' ');
  return {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co ${supabaseOrigins} https://tile.openstreetmap.org ${mapOrigins}`.trim(),
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `img-src 'self' data: blob: https://images.unsplash.com https://tile.openstreetmap.org https://*.supabase.co ${supabaseImageOrigins} ${mapOrigins}`.trim(),
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    'upgrade-insecure-requests',
  ].join('; '),
  'Permissions-Policy': 'camera=(), geolocation=(self), microphone=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  };
}

const revalidatedAssets = new Set([
  '/manifest.webmanifest',
  '/register-sw.js',
  '/sw.js',
]);

function withSecurityHeaders(response, env, pathname, privateNavigation = false) {
  const next = new Response(response.body, response);
  const contentType = response.headers.get('content-type') ?? '';

  next.headers.set('X-Content-Type-Options', 'nosniff');
  next.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (contentType.includes('text/html')) {
    for (const [name, value] of Object.entries(htmlHeaders(env))) {
      next.headers.set(name, value);
    }
    next.headers.set('Cache-Control', privateNavigation ? 'no-store' : 'no-cache');
  } else if (revalidatedAssets.has(pathname)) {
    next.headers.set('Cache-Control', 'no-cache');
  } else if (response.ok) {
    next.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  return next;
}

const privateNavigationPaths = new Set([
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
  return (
    privateNavigationPaths.has(url.pathname) ||
    url.pathname.startsWith('/business-setup/') ||
    Boolean(url.search)
  );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function appAssociationResponse(pathname, env) {
  if (pathname === '/.well-known/apple-app-site-association') {
    const teamId = env.SPOTTR_APPLE_TEAM_ID?.trim();
    const bundleId = env.SPOTTR_IOS_BUNDLE_ID?.trim() || 'com.spottr.food';
    if (!teamId) return jsonResponse({ error: 'Association is not configured.' }, 404);
    return jsonResponse({
      applinks: {
        apps: [],
        details: [
          {
            appID: `${teamId}.${bundleId}`,
            components: [
              { '/': '/place/*', comment: 'Spottr business listing links' },
              { '/': '/auth*', comment: 'Spottr authentication callbacks' },
              { '/': '/reset-password*', comment: 'Spottr password recovery links' },
            ],
          },
        ],
      },
    });
  }

  if (pathname === '/.well-known/assetlinks.json') {
    const packageName = env.SPOTTR_ANDROID_PACKAGE?.trim() || 'com.spottr.food';
    const fingerprints = (env.SPOTTR_ANDROID_CERT_SHA256 ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!fingerprints.length) return jsonResponse({ error: 'Association is not configured.' }, 404);
    return jsonResponse([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: packageName,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ]);
  }

  return null;
}

async function fetchAsset(env, request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return env.ASSETS.fetch(new Request(url, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const privateNavigation = isPrivateNavigation(url);
    const association = appAssociationResponse(url.pathname, env);
    if (association) return association;
    let response = await env.ASSETS.fetch(request);

    if (response.status !== 404) {
      return withSecurityHeaders(response, env, url.pathname, privateNavigation);
    }

    if (!url.pathname.includes('.')) {
      const cleanPath = url.pathname === '/' ? '/index' : url.pathname.replace(/\/$/, '');
      response = await fetchAsset(env, request, `${cleanPath}.html`);
    }

    if (response.status === 404 && url.pathname.startsWith('/place/')) {
      response = await fetchAsset(env, request, '/place/[id].html');
    }

    if (response.status === 404) {
      response = await fetchAsset(env, request, '/+not-found.html');
      response = new Response(response.body, {
        status: 404,
        statusText: 'Not Found',
        headers: response.headers,
      });
    }

    return withSecurityHeaders(response, env, url.pathname, privateNavigation);
  },
};
