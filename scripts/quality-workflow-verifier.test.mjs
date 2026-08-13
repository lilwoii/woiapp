import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateFullRuntimeGate,
  validateMaintenanceGate,
  validatePinnedActions,
  validatePostgresCommands,
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
  '  validate:',
  '      - name: Test production maintenance control plane',
  '        run: npm run test:maintenance-tools',
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
