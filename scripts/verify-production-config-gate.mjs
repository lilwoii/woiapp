import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const protectedVariables = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_APP_URL',
  'EXPO_PUBLIC_EAS_PROJECT_ID',
  'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY',
  'EXPO_PUBLIC_MAP_STYLE_URL',
  'EXPO_PUBLIC_MAP_CSP_ORIGINS',
  'EXPO_PUBLIC_MAP_ATTRIBUTION',
  'EXPO_PUBLIC_MAP_ATTRIBUTION_URL',
  'EXPO_PUBLIC_PRIVACY_POLICY_URL',
  'EXPO_PUBLIC_TERMS_URL',
  'EXPO_PUBLIC_COMMUNITY_RULES_URL',
  'EXPO_PUBLIC_SUPPORT_URL',
];

const env = { ...process.env, EAS_BUILD_PROFILE: '' };
for (const variable of protectedVariables) delete env[variable];

const require = createRequire(import.meta.url);
const expoCli = require.resolve('expo/bin/cli');
const runConfig = (environment, overrides = {}) =>
  spawnSync(process.execPath, [expoCli, 'config', '--type', 'public', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...env, ...overrides, EXPO_PUBLIC_APP_ENV: environment },
  });

const developmentResult = runConfig('development');
if (developmentResult.status !== 0) {
  process.stderr.write(`${developmentResult.stdout ?? ''}\n${developmentResult.stderr ?? ''}`);
  throw new Error('Expo configuration could not be evaluated in development mode.');
}

const productionResult = runConfig('production');
if (productionResult.status === 0) {
  throw new Error('Production configuration must fail closed when required values are absent.');
}

const syntheticProductionValues = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://spottr-release-test.supabase.co',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-publishable-key-for-config-validation-only',
  EXPO_PUBLIC_APP_URL: 'https://release-check.spottr.app',
  EXPO_PUBLIC_EAS_PROJECT_ID: '123e4567-e89b-42d3-a456-426614174000',
  EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: 'synthetic-restricted-android-map-key',
  EXPO_PUBLIC_MAP_STYLE_URL: 'https://tiles-release-check.spottr.app/style.json',
  EXPO_PUBLIC_MAP_CSP_ORIGINS:
    'https://tiles-release-check.spottr.app,https://glyphs-release-check.spottr.app',
  EXPO_PUBLIC_MAP_ATTRIBUTION: 'Synthetic licensed map provider',
  EXPO_PUBLIC_MAP_ATTRIBUTION_URL: 'https://tiles-release-check.spottr.app/attribution',
  EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://release-check.spottr.app/privacy',
  EXPO_PUBLIC_TERMS_URL: 'https://release-check.spottr.app/terms',
  EXPO_PUBLIC_COMMUNITY_RULES_URL: 'https://release-check.spottr.app/community-rules',
  EXPO_PUBLIC_SUPPORT_URL: 'https://release-check.spottr.app/support',
  EXPO_PUBLIC_HOME_KITCHENS_ENABLED: 'false',
  EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED: 'false',
  EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED: 'false',
  EXPO_PUBLIC_PICKUP_ORDERING_ENABLED: 'false',
  EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED: 'false',
  EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED: 'false',
  EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED: 'false',
};
const configuredProductionResult = runConfig('production', syntheticProductionValues);
if (configuredProductionResult.status !== 0) {
  process.stderr.write(`${configuredProductionResult.stdout ?? ''}\n${configuredProductionResult.stderr ?? ''}`);
  throw new Error('A complete synthetic production configuration must succeed.');
}
const configured = JSON.parse(configuredProductionResult.stdout);
const deepLinkData = configured.android?.intentFilters?.[0]?.data;
const deepLinkPaths = Array.isArray(deepLinkData)
  ? deepLinkData.map((entry) => entry.pathPrefix).sort()
  : [];
if (
  configured.extra?.environment !== 'production' ||
  configured.extra?.publicAppUrl !== syntheticProductionValues.EXPO_PUBLIC_APP_URL ||
  configured.extra?.privacyPolicyUrl !== syntheticProductionValues.EXPO_PUBLIC_PRIVACY_POLICY_URL ||
  configured.extra?.termsUrl !== syntheticProductionValues.EXPO_PUBLIC_TERMS_URL ||
  configured.extra?.communityRulesUrl !== syntheticProductionValues.EXPO_PUBLIC_COMMUNITY_RULES_URL ||
  configured.extra?.supportUrl !== syntheticProductionValues.EXPO_PUBLIC_SUPPORT_URL ||
  JSON.stringify(configured.extra?.mapCspOrigins) !== JSON.stringify([
    'https://tiles-release-check.spottr.app',
    'https://glyphs-release-check.spottr.app',
  ]) ||
  configured.ios?.associatedDomains?.[0] !== 'applinks:release-check.spottr.app' ||
  configured.ios.associatedDomains.length !== 1 ||
  configured.android?.intentFilters?.[0]?.autoVerify !== true ||
  !Array.isArray(deepLinkData) ||
  deepLinkData.some((entry) => entry.host !== 'release-check.spottr.app') ||
  JSON.stringify(deepLinkPaths) !==
    JSON.stringify(['/auth', '/navigation', '/place', '/profile', '/reset-password'])
) {
  throw new Error('Synthetic production configuration did not preserve legal URLs or verified deep links.');
}

const rejectedConfigurations = [
  ['non-Supabase backend origin', { EXPO_PUBLIC_SUPABASE_URL: 'https://api.release-check.spottr.app' }],
  ['Supabase URL with a path', { EXPO_PUBLIC_SUPABASE_URL: 'https://spottr-release-test.supabase.co/rest/v1' }],
  ['credential-bearing app URL', { EXPO_PUBLIC_APP_URL: 'https://user:secret@release-check.spottr.app' }],
  ['non-origin app URL', { EXPO_PUBLIC_APP_URL: 'https://release-check.spottr.app/app' }],
  ['placeholder legal URL', { EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://example.com/privacy' }],
  ['credential-bearing map URL', { EXPO_PUBLIC_MAP_STYLE_URL: 'https://token:secret@tiles-release-check.spottr.app/style.json' }],
  ['insecure map CSP origin', { EXPO_PUBLIC_MAP_CSP_ORIGINS: 'http://tiles-release-check.spottr.app' }],
  ['credential-bearing map CSP origin', { EXPO_PUBLIC_MAP_CSP_ORIGINS: 'https://token:secret@tiles-release-check.spottr.app' }],
  ['non-origin map CSP value', { EXPO_PUBLIC_MAP_CSP_ORIGINS: 'https://tiles-release-check.spottr.app/style.json' }],
  ['wildcard map CSP origin', { EXPO_PUBLIC_MAP_CSP_ORIGINS: 'https://*.spottr.app' }],
  ['trailing-dot map CSP origin', { EXPO_PUBLIC_MAP_CSP_ORIGINS: 'https://localhost.' }],
  ['placeholder map CSP origin', { EXPO_PUBLIC_MAP_CSP_ORIGINS: 'https://00000000-0000-0000-0000-000000000000.spottr.app' }],
  ['map style origin omitted from CSP', { EXPO_PUBLIC_MAP_CSP_ORIGINS: 'https://glyphs-release-check.spottr.app' }],
  ['non-public support URL', { EXPO_PUBLIC_SUPPORT_URL: 'https://127.0.0.1/support' }],
  ['unverified home kitchens', { EXPO_PUBLIC_HOME_KITCHENS_ENABLED: 'true' }],
  ['unverified media uploads', { EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED: 'TRUE' }],
  ['unimplemented push delivery', { EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED: 'true' }],
  ['unverified pickup ordering', { EXPO_PUBLIC_PICKUP_ORDERING_ENABLED: 'true' }],
  ['unverified in-app navigation', { EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED: 'true' }],
  ['unverified business claims', { EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED: 'true' }],
  ['unverified sponsored serving', { EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED: 'true' }],
];
for (const [label, override] of rejectedConfigurations) {
  const result = runConfig('production', { ...syntheticProductionValues, ...override });
  if (result.status === 0) {
    throw new Error(`Production configuration accepted ${label}.`);
  }
}

process.stdout.write('Production configuration rejects incomplete, noncanonical, credential-bearing, and placeholder values while accepting a complete synthetic contract.\n');
