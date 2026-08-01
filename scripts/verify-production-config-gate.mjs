import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const protectedVariables = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_APP_URL',
  'EXPO_PUBLIC_EAS_PROJECT_ID',
  'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY',
  'EXPO_PUBLIC_MAP_STYLE_URL',
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
const runConfig = (environment) =>
  spawnSync(process.execPath, [expoCli, 'config', '--type', 'public', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...env, EXPO_PUBLIC_APP_ENV: environment },
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

process.stdout.write('Production configuration fails closed when required values are absent.\n');
