import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_SCAN_OUTPUT_BYTES = 10 * 1024 * 1024;
const FINDINGS_EXIT_CODE = 183;
const APPROVED_FILE = 'scripts/verify-production-config-gate.mjs';
const APPROVED_FINDINGS = new Set([
  'f6ed53c894e8cf577d965314ffc8d3b2a115fe80:87:a7f6887e112e6db66533958fb2ebe693c12ac696c52839a917103046ea3d5409',
  'f6ed53c894e8cf577d965314ffc8d3b2a115fe80:90:a04013df5bdedd975d85f54e9144c19e353bdf4752b8b965318d864e8c76a523',
  '59ed1ca33d55dcd3c8df19adb3cc09fc9ca58d63:87:a7f6887e112e6db66533958fb2ebe693c12ac696c52839a917103046ea3d5409',
  '59ed1ca33d55dcd3c8df19adb3cc09fc9ca58d63:90:a04013df5bdedd975d85f54e9144c19e353bdf4752b8b965318d864e8c76a523',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validateTruffleHogOutput({ stdout, stderr, exitCode }) {
  const errors = [];
  if (typeof stdout !== 'string' || typeof stderr !== 'string' || !Number.isInteger(exitCode)) {
    return ['Secret-history scanner evidence is malformed.'];
  }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SCAN_OUTPUT_BYTES) {
    errors.push('Secret-history scanner evidence exceeds the review limit.');
  }
  if (stderr.length > 0) {
    errors.push('Secret-history scanner emitted unexpected diagnostic output.');
  }

  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const seen = new Set();
  for (const line of lines) {
    let finding;
    try {
      finding = JSON.parse(line);
    } catch {
      errors.push('Secret-history scanner evidence contains malformed JSON.');
      continue;
    }
    const git = finding?.SourceMetadata?.Data?.Git;
    if (!isRecord(finding) || !isRecord(git)
      || finding.DetectorName !== 'URI'
      || finding.DecoderName !== 'PLAIN'
      || finding.Verified !== false
      || git.file !== APPROVED_FILE
      || typeof git.commit !== 'string'
      || !Number.isInteger(git.line)
      || typeof finding.RawV2 !== 'string') {
      errors.push('Secret-history scanner reported an unapproved finding.');
      continue;
    }
    const key = `${git.commit}:${git.line}:${sha256(finding.RawV2)}`;
    if (!APPROVED_FINDINGS.has(key)) {
      errors.push('Secret-history scanner reported an unapproved finding.');
      continue;
    }
    if (seen.has(key)) {
      errors.push('Secret-history scanner reported a duplicate approved fixture.');
      continue;
    }
    seen.add(key);
  }
  if (seen.size !== APPROVED_FINDINGS.size) {
    errors.push('Secret-history scanner did not report the complete reviewed fixture set.');
  }

  if (lines.length === 0 && exitCode !== 0) {
    errors.push('Secret-history scanner failed without findings.');
  }
  if (lines.length > 0 && exitCode !== FINDINGS_EXIT_CODE) {
    errors.push('Secret-history scanner returned an unexpected finding status.');
  }
  return errors;
}

async function readBoundedFile(filePath) {
  const details = await stat(filePath);
  if (!details.isFile() || details.size > MAX_SCAN_OUTPUT_BYTES) {
    throw new Error('Secret-history scanner evidence is missing or oversized.');
  }
  return readFile(filePath, 'utf8');
}

export async function verifyTruffleHogFiles(outputPath, errorPath, rawExitCode) {
  if (!/^\d{1,3}$/u.test(rawExitCode ?? '')) {
    throw new Error('Secret-history scanner status is malformed.');
  }
  const [stdout, stderr] = await Promise.all([
    readBoundedFile(outputPath),
    readBoundedFile(errorPath),
  ]);
  const errors = validateTruffleHogOutput({
    stdout,
    stderr,
    exitCode: Number(rawExitCode),
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [, , outputPath, errorPath, exitCode] = process.argv;
  if (!outputPath || !errorPath || exitCode === undefined) {
    console.error('Secret-history scanner evidence arguments are missing.');
    process.exitCode = 1;
  } else {
    verifyTruffleHogFiles(outputPath, errorPath, exitCode)
      .then(() => process.stdout.write('Secret-history findings matched the reviewed fixture policy.\n'))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : 'Secret-history verification failed.');
        process.exitCode = 1;
      });
  }
}
