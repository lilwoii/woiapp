import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6';
const SETUP_NODE = 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6';
const UPLOAD = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1';

function stepBody(workflow, stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}`);
  if (start < 0) return '';
  const remaining = workflow.slice(start);
  const next = remaining.slice(1).search(/^      - name:/m);
  return next < 0 ? remaining : remaining.slice(0, next + 1);
}

export function validateProductionWebReleaseWorkflow(workflow) {
  const errors = [];
  const build = stepBody(workflow, 'Build configured production Sites artifact');
  const upload = stepBody(workflow, 'Upload commit-bound production Sites artifact');
  if (!/^on:\r?\n  workflow_dispatch:\s*$/m.test(workflow)
    || /^  (?:pull_request|push|schedule):/m.test(workflow)) {
    errors.push('Production web release must be manual only.');
  }
  if (!/^permissions:\r?\n  contents: read\s*$/m.test(workflow)) {
    errors.push('Production web release must use read-only repository permissions.');
  }
  for (const token of [
    '    environment: production-web',
    '    timeout-minutes: 20',
    '  cancel-in-progress: false',
    `uses: ${CHECKOUT}`,
    `uses: ${SETUP_NODE}`,
    'run: npm ci',
    'run: npm run verify:production-config',
    'run: npm run test:audit-tools && npm run audit:production',
  ]) {
    if (!workflow.includes(token)) errors.push(`Production web release is missing: ${token}`);
  }
  const actionLines = workflow.split(/\r?\n/).filter((line) => /\buses:\s*/.test(line));
  if (actionLines.length !== 3 || actionLines.some((line) => !/@[0-9a-f]{40}\s+#\s*\S+\s*$/.test(line))) {
    errors.push('Production web release must use exactly three immutable reviewed actions.');
  }
  const requiredBuildValues = [
    'EXPO_PUBLIC_APP_ENV: production',
    'EXPO_PUBLIC_SUPABASE_URL: ${{ vars.EXPO_PUBLIC_SUPABASE_URL }}',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.EXPO_PUBLIC_SUPABASE_ANON_KEY }}',
    'EXPO_PUBLIC_APP_URL: ${{ vars.EXPO_PUBLIC_APP_URL }}',
    'EXPO_PUBLIC_EAS_PROJECT_ID: ${{ vars.EXPO_PUBLIC_EAS_PROJECT_ID }}',
    'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: ${{ secrets.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY }}',
    'EXPO_PUBLIC_MAP_STYLE_URL: ${{ vars.EXPO_PUBLIC_MAP_STYLE_URL }}',
    'EXPO_PUBLIC_MAP_CSP_ORIGINS: ${{ vars.EXPO_PUBLIC_MAP_CSP_ORIGINS }}',
    'EXPO_PUBLIC_MAP_ATTRIBUTION: ${{ vars.EXPO_PUBLIC_MAP_ATTRIBUTION }}',
    'EXPO_PUBLIC_MAP_ATTRIBUTION_URL: ${{ vars.EXPO_PUBLIC_MAP_ATTRIBUTION_URL }}',
    'EXPO_PUBLIC_PRIVACY_POLICY_URL: ${{ vars.EXPO_PUBLIC_PRIVACY_POLICY_URL }}',
    'EXPO_PUBLIC_TERMS_URL: ${{ vars.EXPO_PUBLIC_TERMS_URL }}',
    'EXPO_PUBLIC_COMMUNITY_RULES_URL: ${{ vars.EXPO_PUBLIC_COMMUNITY_RULES_URL }}',
    'EXPO_PUBLIC_SUPPORT_URL: ${{ vars.EXPO_PUBLIC_SUPPORT_URL }}',
    'run: npm run build:sites',
  ];
  for (const token of requiredBuildValues) {
    if (!build.includes(token)) errors.push(`Configured production build is missing: ${token}`);
  }
  for (const flag of [
    'EXPO_PUBLIC_HOME_KITCHENS_ENABLED',
    'EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED',
    'EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED',
    'EXPO_PUBLIC_PICKUP_ORDERING_ENABLED',
    'EXPO_PUBLIC_PREPAID_PICKUP_ENABLED',
    'EXPO_PUBLIC_INTERNAL_SHADOW_ORDERING_ENABLED',
    'EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED',
    'EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED',
    'EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED',
  ]) {
    if (!build.includes(`${flag}: "false"`)) {
      errors.push(`High-risk production feature must remain fail closed: ${flag}`);
    }
  }
  const sensitiveReferences = workflow.match(/\$\{\{ secrets\.[A-Z0-9_]+ \}\}/g) ?? [];
  if (sensitiveReferences.length !== 2 || sensitiveReferences.some((reference) => !build.includes(reference))) {
    errors.push('Publishable build credentials must be scoped only to the build step.');
  }
  if (/SERVICE_ROLE|MAPBOX_DIRECTIONS|PROVIDER_INGEST|SCANNER|WORKER_SECRET/.test(workflow)) {
    errors.push('Server-only credentials must never enter the web release workflow.');
  }
  const buildIndex = workflow.indexOf('name: Build configured production Sites artifact');
  const auditIndex = workflow.indexOf('name: Audit production dependencies');
  const uploadIndex = workflow.indexOf('name: Upload commit-bound production Sites artifact');
  if (buildIndex < 0 || auditIndex < buildIndex || uploadIndex < auditIndex) {
    errors.push('Production artifact upload must follow the configured build and dependency audit.');
  }
  for (const token of [
    `uses: ${UPLOAD}`,
    'name: spottr-production-sites-dist-${{ github.sha }}',
    'path: dist/',
    'if-no-files-found: error',
    'retention-days: 7',
    'overwrite: false',
    'include-hidden-files: true',
  ]) {
    if (!upload.includes(token)) errors.push(`Production artifact contract is missing: ${token}`);
  }
  if (/continue-on-error:|pull_request_target:/.test(workflow)) {
    errors.push('Production web release must fail closed and never run with privileged pull-request semantics.');
  }
  return errors;
}

export async function verifyProductionWebReleaseWorkflow(projectRoot = PROJECT_ROOT) {
  const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'production-web-release.yml'), 'utf8');
  const errors = validateProductionWebReleaseWorkflow(workflow);
  if (errors.length) throw new Error(errors.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  verifyProductionWebReleaseWorkflow()
    .then(() => process.stdout.write('Production web artifacts require protected real configuration and retain fail-closed feature gates.\n'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
