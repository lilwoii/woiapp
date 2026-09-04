import appJson from './app.base.json';

export default () => {
  const environment = process.env.EXPO_PUBLIC_APP_ENV?.trim() ?? 'development';
  const productionBuild =
    environment === 'production' || process.env.EAS_BUILD_PROFILE === 'production';
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  const iosMapsKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_KEY?.trim();
  const androidMapsKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY?.trim();
  const mapStyleUrl = process.env.EXPO_PUBLIC_MAP_STYLE_URL?.trim();
  const mapAttribution = process.env.EXPO_PUBLIC_MAP_ATTRIBUTION?.trim();
  const mapAttributionUrl = process.env.EXPO_PUBLIC_MAP_ATTRIBUTION_URL?.trim();
  const privacyPolicyUrl = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim();
  const termsUrl = process.env.EXPO_PUBLIC_TERMS_URL?.trim();
  const communityRulesUrl = process.env.EXPO_PUBLIC_COMMUNITY_RULES_URL?.trim();
  const supportUrl = process.env.EXPO_PUBLIC_SUPPORT_URL?.trim();
  const highRiskFeatureFlags = [
    'EXPO_PUBLIC_HOME_KITCHENS_ENABLED',
    'EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED',
    'EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED',
    'EXPO_PUBLIC_PICKUP_ORDERING_ENABLED',
    'EXPO_PUBLIC_PREPAID_PICKUP_ENABLED',
    'EXPO_PUBLIC_INTERNAL_SHADOW_ORDERING_ENABLED',
    'EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED',
    'EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED',
    'EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED',
  ] as const;
  const placeholderPattern =
    /(?:your-|example|\.test(?:[/:]|$)|\.invalid(?:[/:]|$)|00000000-0000-0000-0000-000000000000)/i;
  const isPlaceholder = (value?: string) =>
    !value || placeholderPattern.test(value);
  const isNonPublicHostname = (hostname: string) =>
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.') ||
    /^[0-9.]+$/.test(hostname) ||
    hostname.includes(':') ||
    hostname.includes('*');
  const parsePublicHttpsUrl = (value?: string) => {
    if (!value) return null;
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        isNonPublicHostname(parsed.hostname)
      ) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const isHttpsUrl = (value?: string) => {
    const parsed = parsePublicHttpsUrl(value);
    return Boolean(parsed && !isPlaceholder(value));
  };
  const isHttpsOrigin = (value?: string) => {
    const parsed = parsePublicHttpsUrl(value);
    return Boolean(
      parsed &&
      !isPlaceholder(value) &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.port
    );
  };
  const isSupabaseProjectOrigin = (value?: string) => {
    const parsed = parsePublicHttpsUrl(value);
    return Boolean(
      parsed &&
      isHttpsOrigin(value) &&
      /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)
    );
  };
  const parseMapCspOrigins = (value?: string): string[] | null => {
    const raw = value?.trim();
    if (!raw || raw.length > 2048) return null;
    const entries = raw.split(',').map((entry) => entry.trim());
    if (
      entries.length === 0 ||
      entries.length > 16 ||
      entries.some((entry) => !entry)
    ) return null;
    const origins: string[] = [];
    for (const entry of entries) {
      const parsed = parsePublicHttpsUrl(entry);
      if (
        !parsed ||
        isPlaceholder(entry) ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.port
      ) return null;
      if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
    }
    return origins;
  };
  const mapCspOrigins = parseMapCspOrigins(
    process.env.EXPO_PUBLIC_MAP_CSP_ORIGINS,
  );
  const mapStyleOriginAllowed = (() => {
    if (!mapStyleUrl || !mapCspOrigins) return false;
    try {
      return mapCspOrigins.includes(new URL(mapStyleUrl).origin);
    } catch {
      return false;
    }
  })();
  const publicAppUrl = process.env.EXPO_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  let universalLinkHost: string | null = null;
  if (publicAppUrl && isHttpsOrigin(publicAppUrl)) {
    try {
      const parsed = new URL(publicAppUrl);
      if (parsed.protocol === 'https:') universalLinkHost = parsed.hostname;
    } catch {
      universalLinkHost = null;
    }
  }

  if (productionBuild) {
    const enabledHighRiskFlags = highRiskFeatureFlags.filter(
      (name) => process.env[name]?.trim().toLocaleLowerCase('en-US') === 'true'
    );
    const missing = [
      !isSupabaseProjectOrigin(supabaseUrl) && 'EXPO_PUBLIC_SUPABASE_URL (canonical Supabase project origin)',
      (isPlaceholder(supabaseAnonKey) || (supabaseAnonKey?.length ?? 0) < 20) &&
        'EXPO_PUBLIC_SUPABASE_ANON_KEY',
      (isPlaceholder(easProjectId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          easProjectId ?? ''
        )) &&
        'EXPO_PUBLIC_EAS_PROJECT_ID',
      isPlaceholder(androidMapsKey) && 'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY',
      !isHttpsUrl(mapStyleUrl) && 'EXPO_PUBLIC_MAP_STYLE_URL (public HTTPS URL)',
      !mapCspOrigins &&
        'EXPO_PUBLIC_MAP_CSP_ORIGINS (exact public HTTPS style/tile/glyph/sprite origins)',
      mapCspOrigins && !mapStyleOriginAllowed &&
        'EXPO_PUBLIC_MAP_CSP_ORIGINS (must include EXPO_PUBLIC_MAP_STYLE_URL origin)',
      isPlaceholder(mapAttribution) && 'EXPO_PUBLIC_MAP_ATTRIBUTION',
      !isHttpsUrl(mapAttributionUrl) && 'EXPO_PUBLIC_MAP_ATTRIBUTION_URL (public HTTPS URL)',
      !universalLinkHost && 'EXPO_PUBLIC_APP_URL (canonical public HTTPS origin)',
      !isHttpsUrl(privacyPolicyUrl) && 'EXPO_PUBLIC_PRIVACY_POLICY_URL (public HTTPS URL)',
      !isHttpsUrl(termsUrl) && 'EXPO_PUBLIC_TERMS_URL (public HTTPS URL)',
      !isHttpsUrl(communityRulesUrl) && 'EXPO_PUBLIC_COMMUNITY_RULES_URL (public HTTPS URL)',
      !isHttpsUrl(supportUrl) && 'EXPO_PUBLIC_SUPPORT_URL (public HTTPS URL)',
      enabledHighRiskFlags.length > 0 &&
        `high-risk feature gates must remain false (${enabledHighRiskFlags.join(', ')})`,
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`Spottr production configuration is incomplete: ${missing.join(', ')}`);
    }
  }

  return {
    ...appJson.expo,
    ios: {
      ...appJson.expo.ios,
      ...(iosMapsKey ? { config: { googleMapsApiKey: iosMapsKey } } : {}),
      ...(universalLinkHost
        ? { associatedDomains: [`applinks:${universalLinkHost}`] }
        : {}),
    },
    android: {
      ...appJson.expo.android,
      ...(androidMapsKey
        ? {
            config: {
              googleMaps: {
                apiKey: androidMapsKey,
              },
            },
          }
        : {}),
      ...(universalLinkHost
        ? {
            intentFilters: [
              {
                action: 'VIEW',
                autoVerify: true,
                data: [
                  {
                    scheme: 'https',
                    host: universalLinkHost,
                    pathPrefix: '/place',
                  },
                  {
                    scheme: 'https',
                    host: universalLinkHost,
                    pathPrefix: '/profile',
                  },
                  {
                    scheme: 'https',
                    host: universalLinkHost,
                    pathPrefix: '/navigation',
                  },
                  {
                    scheme: 'https',
                    host: universalLinkHost,
                    pathPrefix: '/auth',
                  },
                  {
                    scheme: 'https',
                    host: universalLinkHost,
                    pathPrefix: '/reset-password',
                  },
                  {
                    scheme: 'https',
                    host: universalLinkHost,
                    pathPrefix: '/orders',
                  },
                ],
                category: ['BROWSABLE', 'DEFAULT'],
              },
            ],
          }
        : {}),
    },
    extra: {
      eas: easProjectId ? { projectId: easProjectId } : undefined,
      environment,
      publicAppUrl: publicAppUrl ?? null,
      privacyPolicyUrl: privacyPolicyUrl ?? null,
      termsUrl: termsUrl ?? null,
      communityRulesUrl: communityRulesUrl ?? null,
      supportUrl: supportUrl ?? null,
      mapCspOrigins: mapCspOrigins ?? [],
    },
  };
};
