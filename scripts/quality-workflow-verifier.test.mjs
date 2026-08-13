import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateFullRuntimeGate,
  validateMaintenanceGate,
  validatePinnedActions,
  validatePostgresCommands,
  validateProductionSbomGate,
  validateSbomPackageContract,
  validateSecretHistoryGate,
} from './quality-workflow-verifier.mjs';

const command = (file) => `psql -X -v ON_ERROR_STOP=1 -1 -h 127.0.0.1 -f ${file}`;
const validWorkflow = [
  '  full-supabase-db:',
  '      - uses: supabase/setup-cli@3c2f5e2ae34c34e428e8e206e2c4d21fa2d20fbf # v2',
  '          version: 2.84.2',
  '      - run: npm run test:db-runtime',
  '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  `if ${command('supabase/tests/psql_fail_fast_probe.sql')}; then`,
  '  exit 1',
  'fi',
  command('supabase/tests/shadow_ordering_runtime_setup.sql'),
  command('supabase/migrations/20260802000000_shadow_ordering_foundation.sql'),
  command('supabase/tests/shadow_ordering_runtime_test.sql'),
  '  secret-history:',
  '    permissions:',
  '      contents: read',
  '    runs-on: ubuntu-latest',
  '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  '          fetch-depth: 0',
  "          trap 'rm -f \"$archive\" \"$scanner\" \"$output\"' EXIT",
  "          curl --proto '=https' --tlsv1.2",
  '          https://github.com/trufflesecurity/trufflehog/releases/download/v3.96.0/trufflehog_3.96.0_linux_amd64.tar.gz',
  '          7105f1cd6577f058a9e39d0578f1a99c8a1e481e4d3512cd8a09acfe22a0fdc0',
  '          sha256sum --check --status',
  '          "$scanner" git "file://$GITHUB_WORKSPACE" --results=verified,unknown --fail --fail-on-scan-errors --no-update --github-actions >"$output" 2>&1',
  '  production-sbom:',
  '    permissions:',
  '      contents: read',
  '    runs-on: ubuntu-latest',
  '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  '      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6',
  '          GITHUB_SHA: ${{ github.sha }}',
  '      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
  '          name: spottr-production-sbom-${{ github.sha }}',
  '          path: |',
  '            spottr-production.cdx.json',
  '            spottr-production.cdx.json.sha256',
  '          if-no-files-found: error',
  '          retention-days: 90',
  '          overwrite: false',
  '          include-hidden-files: false',
  '      - run: npm ci',
  '          npm run generate:production-sbom',
  '          npm run verify:production-sbom',
  '          sha256sum spottr-production.cdx.json > spottr-production.cdx.json.sha256',
  '  validate:',
  '      - name: Test production maintenance control plane',
  '        run: npm run test:maintenance-tools',
  '      - name: Test production SBOM verifier',
  '        run: npm run test:production-sbom-tools',
].join('\n');

test('accepts transactional fail-fast SQL commands and a guarded failure probe', () => {
  assert.deepEqual(validatePostgresCommands(validWorkflow), []);
});

test('rejects a migration command that could continue after a SQL error', () => {
  const unsafe = validWorkflow.replace(
    command('supabase/migrations/20260802000000_shadow_ordering_foundation.sql'),
    'psql -h 127.0.0.1 -f supabase/migrations/20260802000000_shadow_ordering_foundation.sql',
  );
  const errors = validatePostgresCommands(unsafe);
  assert.ok(errors.some((error) => error.includes('not fail-fast')));
  assert.ok(errors.some((error) => error.includes('not transactional')));
});

test('requires the pinned full Supabase runtime gate', () => {
  assert.deepEqual(validateFullRuntimeGate(validWorkflow), []);
  const errors = validateFullRuntimeGate(
    validWorkflow.replace('version: 2.84.2', 'version: latest').replace('npm run test:db-runtime', 'echo skipped'),
  );
  assert.ok(errors.some((error) => error.includes('pinned')));
  assert.ok(errors.some((error) => error.includes('full database runtime gate')));
});

test('requires every action to use an immutable commit', () => {
  assert.deepEqual(validatePinnedActions(validWorkflow), []);
  const errors = validatePinnedActions(validWorkflow.replace(
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
    'actions/checkout@v6',
  ));
  assert.ok(errors.some((error) => error.includes('not pinned')));
});

test('requires privileged production maintenance coverage', () => {
  assert.deepEqual(validateMaintenanceGate(validWorkflow), []);
  assert.ok(validateMaintenanceGate(validWorkflow.replace('npm run test:maintenance-tools', 'echo skipped')).length > 0);
  assert.ok(validateMaintenanceGate(validWorkflow.replace(
    '  validate:',
    '  unrelated-job:\n      - run: npm run test:maintenance-tools\n  validate:',
  ).replace('      - name: Test production maintenance control plane\n        run: npm run test:maintenance-tools', '')).length > 0);
});

test('requires a fail-closed full-history secret scan with ephemeral redacted output', () => {
  assert.deepEqual(validateSecretHistoryGate(validWorkflow), []);
  for (const mutation of [
    ['fetch-depth: 0', 'fetch-depth: 1'],
    ['--results=verified,unknown --fail --fail-on-scan-errors', '--results=verified,unknown --fail-on-scan-errors'],
    ['--fail-on-scan-errors', '--no-verification-overlap'],
    ['7105f1cd6577f058a9e39d0578f1a99c8a1e481e4d3512cd8a09acfe22a0fdc0', '0'.repeat(64)],
    ['file://$GITHUB_WORKSPACE', 'https://github.com/example/repo'],
  ]) {
    assert.ok(validateSecretHistoryGate(validWorkflow.replace(...mutation)).length > 0);
  }
  assert.ok(validateSecretHistoryGate(validWorkflow.replace(
    '      contents: read\n    runs-on: ubuntu-latest',
    '      contents: read\n      issues: write\n    runs-on: ubuntu-latest',
  )).length > 0);
  assert.ok(validateSecretHistoryGate(validWorkflow.replace('  production-sbom:', '      continue-on-error: true\n  production-sbom:')).length > 0);
});

test('requires a commit-bound, narrowly uploaded production SBOM and its verifier tests', () => {
  assert.deepEqual(validateProductionSbomGate(validWorkflow), []);
  for (const mutation of [
    ['spottr-production-sbom-${{ github.sha }}', 'spottr-production-sbom-latest'],
    ['retention-days: 90', 'retention-days: 0'],
    ['spottr-production.cdx.json.sha256', '**/*'],
    ['npm run verify:production-sbom', 'echo skipped'],
    ['GITHUB_SHA: ${{ github.sha }}', 'GITHUB_SHA: deadbeef'],
  ]) {
    assert.ok(validateProductionSbomGate(validWorkflow.replace(...mutation)).length > 0);
  }
});

test('requires the security-fixed SBOM generator and lockfile identity', () => {
  const manifest = {
    devDependencies: { '@cyclonedx/cyclonedx-npm': '6.0.1' },
    overrides: { libxmljs2: '0.37.0', tar: '7.5.22' },
    scripts: {
      'generate:production-sbom': 'cyclonedx-npm --package-lock-only --omit dev --spec-version 1.6 --output-reproducible --output-format JSON --output-file spottr-production.cdx.json --validate',
      'verify:production-sbom': 'node scripts/verify-production-sbom.mjs spottr-production.cdx.json',
      'test:production-sbom-tools': 'node --test scripts/verify-production-sbom.test.mjs',
    },
  };
  const lockfile = { packages: {
    'node_modules/@cyclonedx/cyclonedx-npm': { version: '6.0.1', dev: true },
    'node_modules/libxmljs2': { version: '0.37.0' },
    'node_modules/tar': { version: '7.5.22' },
  } };
  assert.deepEqual(validateSbomPackageContract(manifest, lockfile), []);
  assert.ok(validateSbomPackageContract({ ...manifest, devDependencies: {} }, lockfile).length > 0);
  assert.ok(validateSbomPackageContract(manifest, { packages: {} }).length > 0);
  assert.ok(validateSbomPackageContract({ ...manifest, scripts: {} }, lockfile).length > 0);
});
