import { rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(projectRoot, 'dist-e2e');
const expoCli = path.join(projectRoot, 'node_modules', 'expo', 'bin', 'cli');

await rm(outputDirectory, { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  [expoCli, 'export', '--platform', 'web', '--output-dir', outputDirectory, '--clear'],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      EXPO_PUBLIC_SUPABASE_URL: 'https://spottr-fixture.supabase.co',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'spottr-public-fixture-anon-key',
      EXPO_PUBLIC_MAP_STYLE_URL: 'https://spottr-fixture.supabase.co/map/style.json',
      EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED: 'true',
    },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
