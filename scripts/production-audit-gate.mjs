import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedPackages = new Set([
  '@expo/cli',
  '@expo/metro',
  '@expo/metro-config',
  '@react-native/community-cli-plugin',
  'expo',
  'image-size',
  'metro',
  'metro-config',
  'metro-transform-worker',
  'react-native',
]);
const allowedAdvisories = new Set([1138808, 1138809]);

export function validateProductionAudit(report) {
  const errors = [];
  const vulnerabilities = report?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    return ['npm audit did not return a vulnerability object.'];
  }

  for (const [name, finding] of Object.entries(vulnerabilities)) {
    if (!finding || typeof finding !== 'object') {
      errors.push(`${name} has a malformed audit finding.`);
      continue;
    }
    const releaseBlocking = finding.severity === 'high' || finding.severity === 'critical';
    if (releaseBlocking && !allowedPackages.has(name)) {
      errors.push(`${name} is an unexpected ${finding.severity} production vulnerability.`);
      continue;
    }
    if (!releaseBlocking) continue;

    for (const cause of Array.isArray(finding.via) ? finding.via : []) {
      if (typeof cause === 'string') {
        if (!allowedPackages.has(cause)) errors.push(`${name} has an unexpected vulnerable dependency: ${cause}.`);
      } else if (!cause || !allowedAdvisories.has(cause.source)) {
        errors.push(`${name} contains an unapproved advisory source.`);
      }
    }
    for (const effect of Array.isArray(finding.effects) ? finding.effects : []) {
      if (!allowedPackages.has(effect)) errors.push(`${name} has an unexpected affected package: ${effect}.`);
    }
  }

  const critical = report?.metadata?.vulnerabilities?.critical;
  if (typeof critical === 'number' && critical > 0) errors.push('Production dependencies contain a critical vulnerability.');
  return errors;
}

function run() {
  const npmEntry = process.env.npm_execpath;
  if (!npmEntry) {
    process.stderr.write('Run the production audit gate through npm so its executable can be resolved safely.\n');
    process.exitCode = 1;
    return;
  }
  const audit = spawnSync(process.execPath, [npmEntry, 'audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (audit.error) {
    process.stderr.write(`npm audit could not start: ${audit.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    process.stderr.write('npm audit did not produce valid JSON.\n');
    process.exitCode = 1;
    return;
  }
  const errors = validateProductionAudit(report);
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const totals = report.metadata?.vulnerabilities ?? {};
  process.stdout.write(
    `Production audit gate passed (${totals.high ?? 0} documented high, ${totals.critical ?? 0} critical).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run();
}
