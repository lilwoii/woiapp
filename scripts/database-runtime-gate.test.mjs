import assert from 'node:assert/strict';
import test from 'node:test';

import { orderedMigrationNames, psqlArguments } from './database-runtime-gate.mjs';

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
