import assert from 'node:assert/strict';
import test from 'node:test';

import {
  orderedMigrationNames,
  psqlArguments,
  runtimeSupabaseConfig,
} from './database-runtime-gate.mjs';

test('orders timestamped migrations and rejects duplicate timestamps', () => {
  assert.deepEqual(
    orderedMigrationNames([
      '20260803000000_second.sql',
      'README.md',
      '20260802000000_first.sql',
    ]),
    ['20260802000000_first.sql', '20260803000000_second.sql'],
  );
  assert.throws(
    () => orderedMigrationNames(['20260802000000_first.sql', '20260802000000_second.sql']),
    /Duplicate migration timestamp/,
  );
});

test('rejects malformed SQL migration names', () => {
  assert.throws(() => orderedMigrationNames(['not_timestamped.sql']), /Invalid migration filename/);
  assert.throws(() => orderedMigrationNames([]), /No SQL migrations/);
});

test('builds fail-fast isolated transactional psql arguments', () => {
  const args = psqlArguments('/tmp/migration.sql');
  assert.ok(args.includes('-X'));
  assert.deepEqual(args.slice(args.indexOf('-v'), args.indexOf('-v') + 2), ['-v', 'ON_ERROR_STOP=1']);
  assert.ok(args.includes('-1'));
  assert.equal(args.at(-1), '/tmp/migration.sql');
  assert.equal(psqlArguments('/tmp/contract.sql', false).includes('-1'), false);
});

test('isolates the temporary Supabase database on an available host port', () => {
  const inserted = runtimeSupabaseConfig(
    'project_id = "spottr"\n\n[functions.example]\nverify_jwt = true\n',
    'spottr-runtime-123',
    61234,
  );
  assert.match(inserted, /^project_id = "spottr-runtime-123"$/m);
  assert.match(inserted, /^\[db\]\nport = 61234$/m);

  const replaced = runtimeSupabaseConfig(
    'project_id = "spottr"\n\n[db]\nport = 54322\nmajor_version = 17\n\n[studio]\nport = 54323\n',
    'spottr-runtime-456',
    61235,
  );
  assert.equal((replaced.match(/^\[db\]$/gm) ?? []).length, 1);
  assert.match(replaced, /^port = 61235$/m);
  assert.match(replaced, /^major_version = 17$/m);
  assert.match(replaced, /^\[studio\]\nport = 54323$/m);
  assert.throws(() => runtimeSupabaseConfig('project_id = "spottr"', 'unsafe id', 61234));
  assert.throws(() => runtimeSupabaseConfig('project_id = "spottr"', 'safe-id', 80));
});
