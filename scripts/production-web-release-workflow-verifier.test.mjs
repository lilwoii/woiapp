import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProductionWebReleaseWorkflow } from './production-web-release-workflow-verifier.mjs';

const workflow = `name: Production web release artifact
on:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: production-web-release
  cancel-in-progress: false
jobs:
  release:
    environment: production-web
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Check out exact source
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
      - name: Use Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
      - name: Install locked dependencies
        run: npm ci
      - name: Verify the production configuration contract
        run: npm run verify:production-config
      - name: Build configured production Sites artifact
        env:
          EXPO_PUBLIC_APP_ENV: production
          EXPO_PUBLIC_SUPABASE_URL: \${{ vars.EXPO_PUBLIC_SUPABASE_URL }}
          EXPO_PUBLIC_SUPABASE_ANON_KEY: \${{ secrets.EXPO_PUBLIC_SUPABASE_ANON_KEY }}
          EXPO_PUBLIC_APP_URL: \${{ vars.EXPO_PUBLIC_APP_URL }}
          EXPO_PUBLIC_EAS_PROJECT_ID: \${{ vars.EXPO_PUBLIC_EAS_PROJECT_ID }}
          EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: \${{ secrets.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY }}
          EXPO_PUBLIC_MAP_STYLE_URL: \${{ vars.EXPO_PUBLIC_MAP_STYLE_URL }}
          EXPO_PUBLIC_MAP_ATTRIBUTION: \${{ vars.EXPO_PUBLIC_MAP_ATTRIBUTION }}
          EXPO_PUBLIC_MAP_ATTRIBUTION_URL: \${{ vars.EXPO_PUBLIC_MAP_ATTRIBUTION_URL }}
          EXPO_PUBLIC_PRIVACY_POLICY_URL: \${{ vars.EXPO_PUBLIC_PRIVACY_POLICY_URL }}
          EXPO_PUBLIC_TERMS_URL: \${{ vars.EXPO_PUBLIC_TERMS_URL }}
          EXPO_PUBLIC_COMMUNITY_RULES_URL: \${{ vars.EXPO_PUBLIC_COMMUNITY_RULES_URL }}
          EXPO_PUBLIC_SUPPORT_URL: \${{ vars.EXPO_PUBLIC_SUPPORT_URL }}
          EXPO_PUBLIC_HOME_KITCHENS_ENABLED: "false"
          EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED: "false"
          EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED: "false"
          EXPO_PUBLIC_PICKUP_ORDERING_ENABLED: "false"
          EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED: "false"
        run: npm run build:sites
      - name: Audit production dependencies
        run: npm run test:audit-tools && npm run audit:production
      - name: Upload commit-bound production Sites artifact
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: spottr-production-sites-dist-\${{ github.sha }}
          path: dist/
          if-no-files-found: error
          retention-days: 7
          overwrite: false
          include-hidden-files: true
`;

test('accepts a manual protected and commit-bound production web artifact workflow', () => {
  assert.deepEqual(validateProductionWebReleaseWorkflow(workflow), []);
});

test('rejects broadened triggers, leaked credentials, mutable actions, unsafe flags, and broad artifacts', () => {
  for (const [from, to] of [
    ['  workflow_dispatch:', '  pull_request_target:'],
    ['    environment: production-web', '    environment: development'],
    ['checkout@d23441a48e516b6c34aea4fa41551a30e30af803', 'checkout@v6'],
    ['EXPO_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.EXPO_PUBLIC_SUPABASE_ANON_KEY }}', 'EXPO_PUBLIC_SUPABASE_ANON_KEY: ${{ vars.EXPO_PUBLIC_SUPABASE_ANON_KEY }}'],
    ['EXPO_PUBLIC_HOME_KITCHENS_ENABLED: "false"', 'EXPO_PUBLIC_HOME_KITCHENS_ENABLED: "true"'],
    ['spottr-production-sites-dist-${{ github.sha }}', 'spottr-production-sites-dist-latest'],
    ['path: dist/', 'path: **/*'],
    ['include-hidden-files: true', 'include-hidden-files: false'],
  ]) {
    const mutated = workflow.replace(from, to);
    assert.notEqual(mutated, workflow);
    assert.ok(validateProductionWebReleaseWorkflow(mutated).length > 0);
  }
  assert.ok(validateProductionWebReleaseWorkflow(`${workflow}\n# SERVICE_ROLE`).length > 0);
  assert.ok(validateProductionWebReleaseWorkflow(workflow.replace(
    'run: npm run test:audit-tools && npm run audit:production',
    'continue-on-error: true\n        run: npm run test:audit-tools && npm run audit:production',
  )).length > 0);
});
