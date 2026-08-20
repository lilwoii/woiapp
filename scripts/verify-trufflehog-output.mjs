import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_SCAN_OUTPUT_BYTES = 10 * 1024 * 1024;
const FINDINGS_EXIT_CODE = 183;
const APPROVED_CONFIG_FILE = 'scripts/verify-production-config-gate.mjs';
const APPROVED_LINK_TEST_FILE = 'lib/__tests__/links.test.ts';
const APPROVED_FILES = new Set([APPROVED_CONFIG_FILE, APPROVED_LINK_TEST_FILE]);
const APPROVED_FINDING_GROUPS = new Map([
  ['f6ed53c894e8cf577d965314ffc8d3b2a115fe80:scripts/verify-production-config-gate.mjs:87:a7f6887e112e6db66533958fb2ebe693c12ac696c52839a917103046ea3d5409', 'config-f6ed53c'],
  ['f6ed53c894e8cf577d965314ffc8d3b2a115fe80:scripts/verify-production-config-gate.mjs:90:c40d05f65009500bb1583fba187eb601f44faa2ba20a948c971f7ba1869478fa', 'config-f6ed53c'],
  ['59ed1ca33d55dcd3c8df19adb3cc09fc9ca58d63:scripts/verify-production-config-gate.mjs:87:a7f6887e112e6db66533958fb2ebe693c12ac696c52839a917103046ea3d5409', 'config-59ed1ca'],
  ['59ed1ca33d55dcd3c8df19adb3cc09fc9ca58d63:scripts/verify-production-config-gate.mjs:90:c40d05f65009500bb1583fba187eb601f44faa2ba20a948c971f7ba1869478fa', 'config-59ed1ca'],
  ['ef8c8780ea4d447b4a91a5cf0ec94cf6672db6e8:lib/__tests__/links.test.ts:7:8d3331ee208c72c30fba199e4e2b8a65d69a5034e49875a2f20dbea3a4f2f976', 'links-ef8c878'],
]);
export const REVIEWED_TRUFFLEHOG_FINDING_COUNT = APPROVED_FINDING_GROUPS.size;
export const REVIEWED_TRUFFLEHOG_REQUIRED_GROUP_COUNT = new Set(APPROVED_FINDING_GROUPS.values()).size;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function safeFindingDiagnostic(finding, git) {
  const commit = typeof git?.commit === 'string' && /^[0-9a-f]{40}$/u.test(git.commit) ? git.commit : 'invalid';
  const line = Number.isInteger(git?.line) ? String(git.line) : 'invalid';
  const detector = typeof finding?.DetectorName === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(finding.DetectorName)
    ? finding.DetectorName : 'invalid';
  const decoder = typeof finding?.DecoderName === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(finding.DecoderName)
    ? finding.DecoderName : 'invalid';
  const rawHash = typeof finding?.RawV2 === 'string' ? sha256(finding.RawV2) : 'missing';
  return [
    `commit=${commit}`,
    `line=${line}`,
    `file=${APPROVED_FILES.has(git?.file) ? 'approved' : 'other'}`,
    `detector=${detector}`,
    `decoder=${decoder}`,
    `verified=${finding?.Verified === false ? 'false' : 'other'}`,
    `rawv2sha256=${rawHash}`,
  ].join(';');
}

export function validateTruffleHogOutput({
  stdout,
  stderr,
  exitCode,
  findingGroups = APPROVED_FINDING_GROUPS,
}) {
  const errors = [];
  if (typeof stdout !== 'string' || typeof stderr !== 'string' || !Number.isInteger(exitCode)
    || !(findingGroups instanceof Map) || findingGroups.size === 0
    || [...findingGroups.values()].some((group) => typeof group !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(group))) {
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
  const seenGroups = new Set();
  const requiredGroups = new Set(findingGroups.values());
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
      || typeof git.file !== 'string'
      || typeof git.commit !== 'string'
      || !Number.isInteger(git.line)
      || typeof finding.RawV2 !== 'string') {
      errors.push(`Secret-history scanner reported an unapproved finding (${safeFindingDiagnostic(finding, git)}).`);
      continue;
    }
    const key = `${git.commit}:${git.file}:${git.line}:${sha256(finding.RawV2)}`;
    if (!findingGroups.has(key)) {
      errors.push(`Secret-history scanner reported an unapproved finding (${safeFindingDiagnostic(finding, git)}).`);
      continue;
    }
    if (seen.has(key)) {
      errors.push('Secret-history scanner reported a duplicate approved fixture.');
      continue;
    }
    seen.add(key);
    seenGroups.add(findingGroups.get(key));
  }
  if (seenGroups.size !== requiredGroups.size) {
    errors.push('Secret-history scanner did not report every required reviewed fixture group.');
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
