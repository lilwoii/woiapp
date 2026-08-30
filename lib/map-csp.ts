const MAX_MAP_CSP_ORIGINS = 16;
const PLACEHOLDER_PATTERN =
  /(?:your-|example|\.test(?:[/:]|$)|\.invalid(?:[/:]|$)|00000000-0000-0000-0000-000000000000)/i;

function isNonPublicHostname(hostname: string) {
  return hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.') ||
    /^[0-9.]+$/.test(hostname) ||
    hostname.includes(':') ||
    hostname.includes('*');
}

/**
 * Parse exact public HTTPS origins for web-map style, tile, glyph, and sprite
 * requests. A single malformed entry invalidates the whole list so a typo can
 * never broaden only one of Spottr's intersecting CSP policies.
 */
export function parseMapCspOrigins(value?: string): string[] | null {
  const raw = value?.trim();
  if (!raw || raw.length > 2048) return null;
  const entries = raw.split(',').map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.length > MAX_MAP_CSP_ORIGINS ||
    entries.some((entry) => !entry)
  ) return null;

  const origins: string[] = [];
  for (const entry of entries) {
    try {
      const parsed = new URL(entry);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash ||
        parsed.port ||
        isNonPublicHostname(parsed.hostname) ||
        PLACEHOLDER_PATTERN.test(entry)
      ) return null;
      if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
    } catch {
      return null;
    }
  }
  return origins;
}

export function mapStyleOriginIsAllowed(
  mapStyleUrl: string | undefined,
  allowedOrigins: readonly string[] | null,
) {
  if (!mapStyleUrl || !allowedOrigins) return false;
  try {
    return allowedOrigins.includes(new URL(mapStyleUrl).origin);
  } catch {
    return false;
  }
}
