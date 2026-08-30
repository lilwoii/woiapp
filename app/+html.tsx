import { ScrollViewStyleReset } from 'expo-router/html';
import { parseMapCspOrigins } from '@/lib/map-csp';

const browserMapOrigins =
  parseMapCspOrigins(process.env.EXPO_PUBLIC_MAP_CSP_ORIGINS) ?? [];
const browserMapSources = browserMapOrigins.join(' ');

const browserContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://tile.openstreetmap.org ${browserMapSources}`.trim(),
  "font-src 'self' data:",
  "form-action 'self'",
  `img-src 'self' data: blob: https://images.unsplash.com https://tile.openstreetmap.org https://*.supabase.co ${browserMapSources}`.trim(),
  "manifest-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  'upgrade-insecure-requests',
].join('; ');

const publicOrigin = (() => {
  const candidate = process.env.EXPO_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
})();

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta httpEquiv="Content-Security-Policy" content={browserContentSecurityPolicy} />
        <meta name="referrer" content="strict-origin-when-cross-origin" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>Spottr · Live local food, mapped</title>
        <meta
          name="description"
          content="Find nearby food trucks, restaurants, pop-ups, bakeries, and permit-verified Neighborhood Kitchens with live locations, menus, payments, reviews, and owner updates."
        />
        <meta name="theme-color" content="#F6F3EC" />
        <meta name="color-scheme" content="light" />
        <meta name="application-name" content="Spottr" />
        <meta name="apple-mobile-web-app-title" content="Spottr" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        {publicOrigin ? <link rel="canonical" href={publicOrigin} /> : null}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/spottr-icon.png" />
        <script defer src="/register-sw.js" />
        <meta property="og:title" content="Spottr · Live local food, mapped" />
        <meta
          property="og:description"
          content="Know what is serving, where it is, what it costs, and how you can pay—before you go."
        />
        <meta property="og:type" content="website" />
        {publicOrigin ? <meta property="og:url" content={publicOrigin} /> : null}
        <meta
          property="og:image"
          content={
            publicOrigin
              ? `${publicOrigin}/spottr-social-card.png`
              : '/spottr-social-card.png'
          }
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="twitter:image"
          content={
            publicOrigin
              ? `${publicOrigin}/spottr-social-card.png`
              : '/spottr-social-card.png'
          }
        />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
body {
  background-color: #F6F3EC;
  color: #191D1B;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* {
  box-sizing: border-box;
}
::selection {
  background: #FFE0D7;
  color: #191D1B;
}
button, input, textarea {
  font: inherit;
}
:focus-visible {
  outline: 3px solid #9E2718;
  outline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
`;
