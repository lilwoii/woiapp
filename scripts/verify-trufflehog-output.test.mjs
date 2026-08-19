import assert from 'node:assert/strict';
import test from 'node:test';

import { validateTruffleHogOutput } from './verify-trufflehog-output.mjs';

const appFixture = ['https://', 'user:', 'secret', '@release-check.spottr.app'].join('');
const mapHostFixture = ['https://', 'token:', 'secret', '@tiles-release-check.spottr.app'].join('');
const mapFixture = `${mapHostFixture}/style.json`;

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
  });
}

function approvedFindings() {
  return [
    finding(),
    finding({ line: 90, raw: mapHostFixture, rawV2: mapFixture }),
    finding({ commit: 'f6ed53c894e8cf577d965314ffc8d3b2a115fe80' }),
    finding({ commit: 'f6ed53c894e8cf577d965314ffc8d3b2a115fe80', line: 90, raw: mapHostFixture, rawV2: mapFixture }),
  ];
}

test('accepts exactly the complete immutable synthetic URI fixture set', () => {
  assert.deepEqual(validate(approvedFindings()), []);
  assert.ok(validate([]).some((error) => error.includes('complete reviewed fixture set')));
  assert.ok(validate(approvedFindings().slice(0, 3)).some((error) => error.includes('complete reviewed fixture set')));
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
});
