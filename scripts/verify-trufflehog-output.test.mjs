import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REVIEWED_TRUFFLEHOG_FINDING_COUNT,
  REVIEWED_TRUFFLEHOG_REQUIRED_GROUP_COUNT,
  readBoundedFile,
  validateTruffleHogOutput,
} from './verify-trufflehog-output.mjs';

const appFixture = ['https://', 'user:', 'secret', '@release-check.spottr.app'].join('');
const mapHostFixture = ['https://', 'token:', 'secret', '@tiles-release-check.spottr.app'].join('');
const mapFixture = `${mapHostFixture}/style.json`;
const linkFixture = ['https://', 'blocked:', 'secret', '@links-release-check.spottr.app/path'].join('');

function finding({
  commit = '59ed1ca33d55dcd3c8df19adb3cc09fc9ca58d63',
  file = 'scripts/verify-production-config-gate.mjs',
  line = 87,
  raw = appFixture,
  rawV2 = raw,
  verified = false,
  detector = 'URI',
  decoder = 'PLAIN',
} = {}) {
  return {
    SourceMetadata: { Data: { Git: { commit, file, line } } },
    DetectorName: detector,
    DecoderName: decoder,
    Verified: verified,
    Raw: raw,
    RawV2: rawV2,
  };
}

function validate(records, exitCode = records.length > 0 ? 183 : 0, stderr = '') {
  return validateTruffleHogOutput({
    stdout: records.map((record) => JSON.stringify(record)).join('\n'),
    stderr,
    exitCode,
    findingGroups: approvedFindingPolicy(),
  });
}

function approvedFindings() {
  return [
    finding(),
    finding({ line: 90, raw: mapHostFixture, rawV2: mapFixture }),
    finding({ commit: 'f6ed53c894e8cf577d965314ffc8d3b2a115fe80' }),
    finding({ commit: 'f6ed53c894e8cf577d965314ffc8d3b2a115fe80', line: 90, raw: mapHostFixture, rawV2: mapFixture }),
    finding({
      commit: 'ef8c8780ea4d447b4a91a5cf0ec94cf6672db6e8',
      file: 'lib/__tests__/links.test.ts',
      line: 7,
      raw: linkFixture,
      rawV2: linkFixture,
    }),
  ];
}

function findingKey(record) {
  const git = record.SourceMetadata.Data.Git;
  const rawHash = createHash('sha256').update(record.RawV2, 'utf8').digest('hex');
  return `${git.commit}:${git.file}:${git.line}:${record.DecoderName}:${rawHash}`;
}

function approvedFindingPolicy() {
  return new Map(approvedFindings().map((record) => {
    const git = record.SourceMetadata.Data.Git;
    const groupType = git.file === 'lib/__tests__/links.test.ts' ? 'links' : 'config';
    return [findingKey(record), `${groupType}-${git.commit}`];
  }));
}

test('pins the production policy to nine exact findings across six required groups', () => {
  assert.equal(REVIEWED_TRUFFLEHOG_FINDING_COUNT, 9);
  assert.equal(REVIEWED_TRUFFLEHOG_REQUIRED_GROUP_COUNT, 6);
  assert.ok(validateTruffleHogOutput({
    stdout: JSON.stringify(finding()),
    stderr: '',
    exitCode: 183,
  }).length > 0);
});

test('accepts exact alternatives while requiring every reviewed fixture group', () => {
  const records = approvedFindings();
  assert.deepEqual(validate(records), []);
  assert.deepEqual(validate([records[0], records[2], records[4]]), []);
  assert.ok(validate([]).some((error) => error.includes('every required reviewed fixture group')));
  assert.ok(validate(records.slice(0, 2)).some((error) => error.includes('every required reviewed fixture group')));
});

test('rejects verified, changed, moved, duplicated, or differently decoded findings', () => {
  for (const record of [
    finding({ verified: true }),
    finding({ rawV2: `${appFixture}/changed` }),
    finding({ line: 90, raw: mapHostFixture, rawV2: `${mapFixture}?changed` }),
    finding({ commit: '0'.repeat(40) }),
    finding({ file: 'app/config.ts' }),
    finding({ line: 88 }),
    finding({ detector: 'Generic' }),
    finding({ decoder: 'BASE64' }),
  ]) {
    assert.ok(validate([record]).length > 0);
  }
  assert.ok(validate([finding(), finding()]).some((error) => error.includes('duplicate')));
});

test('binds an approved HTML-decoded fixture to its exact decoder', () => {
  const htmlFinding = finding({ decoder: 'HTML' });
  const findingGroups = new Map([[findingKey(htmlFinding), 'html-exact']]);
  const validateExact = (record) => validateTruffleHogOutput({
    stdout: JSON.stringify(record),
    stderr: '',
    exitCode: 183,
    findingGroups,
  });

  assert.deepEqual(validateExact(htmlFinding), []);
  assert.ok(validateExact(finding()).length > 0);
});

test('rejects malformed output, stderr, and mismatched scanner status', () => {
  assert.ok(validateTruffleHogOutput({ stdout: '{', stderr: '', exitCode: 183 }).length > 0);
  assert.ok(validate([finding()], 0).length > 0);
  assert.ok(validate([], 183).length > 0);
  assert.ok(validate([finding()], 183, 'scanner warning').length > 0);
  assert.ok(validateTruffleHogOutput({ stdout: '', stderr: '', exitCode: Number.NaN }).length > 0);
});

test('errors never echo a raw or redacted finding value', () => {
  const errors = validate([finding({ raw: `${appFixture}/unexpected` })]);
  const message = errors.join('\n');
  assert.equal(message.includes(appFixture), false);
  assert.equal(message.includes('user:secret'), false);
  assert.match(
    message,
    /commit=[0-9a-f]{40};line=87;file=approved;detector=URI;decoder=PLAIN;verified=false;rawv2sha256=[0-9a-f]{64}/u,
  );
});

test('verifies bounded scanner evidence through stable file handles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spottr-secret-evidence-'));
  const outputPath = join(directory, 'scanner.jsonl');
  try {
    await writeFile(outputPath, 'bounded evidence\n', 'utf8');
    assert.equal(await readBoundedFile(outputPath), 'bounded evidence\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
