const htmlHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https://images.unsplash.com",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'upgrade-insecure-requests',
  ].join('; '),
  'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function withSecurityHeaders(response) {
  const next = new Response(response.body, response);
  const contentType = response.headers.get('content-type') ?? '';

  next.headers.set('X-Content-Type-Options', 'nosniff');
  next.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (contentType.includes('text/html')) {
    for (const [name, value] of Object.entries(htmlHeaders)) {
      next.headers.set(name, value);
    }
    next.headers.set('Cache-Control', 'no-cache');
  } else if (response.ok) {
    next.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  return next;
}

async function fetchAsset(env, request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return env.ASSETS.fetch(new Request(url, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response = await env.ASSETS.fetch(request);

    if (response.status !== 404) {
      return withSecurityHeaders(response);
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
    }

    return withSecurityHeaders(response);
  },
};

