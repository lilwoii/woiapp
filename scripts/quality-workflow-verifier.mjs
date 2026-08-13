import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jobBody(workflow, jobName) {
  const start = workflow.search(new RegExp(`^  ${jobName}:\\s*$`, 'm'));
  if (start < 0) return '';
  const bodyStart = workflow.indexOf('\n', start);
  if (bodyStart < 0) return '';
  const remaining = workflow.slice(bodyStart + 1);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  return nextJob < 0 ? remaining : remaining.slice(0, nextJob);
}

function hasReadOnlyContentsPermission(job) {
  return /^    permissions:\r?\n      contents: read\r?\n(?=    \S)/m.test(job);
}

export function validatePostgresCommands(workflow) {
  const errors = [];
  const commands = workflow.split(/\r?\n/).filter((line) => /\bpsql\b/.test(line));
  if (commands.length < 4) errors.push('Quality workflow must exercise the fail-fast probe and three runtime SQL stages.');
  for (const command of commands) {
    if (!command.includes(' -X ')) errors.push(`psql command does not disable startup files: ${command.trim()}`);
    if (!command.includes(' -v ON_ERROR_STOP=1 ')) errors.push(`psql command is not fail-fast: ${command.trim()}`);
    if (!command.includes(' -1 ')) errors.push(`psql command is not transactional: ${command.trim()}`);
  }
  if (!workflow.includes('psql_fail_fast_probe.sql')) errors.push('Intentional psql failure probe is not executed.');
  if (!/if psql[^\n]+psql_fail_fast_probe\.sql; then[\s\S]+exit 1/.test(workflow)) {
    errors.push('Failure probe must fail the job if psql unexpectedly succeeds.');
  }
  return errors;
}

export function validateFullRuntimeGate(workflow) {
  const errors = [];
  if (!/^  full-supabase-db:\s*$/m.test(workflow)) {
    errors.push('Quality workflow must include the full Supabase database runtime job.');
  }
  if (!/uses: supabase\/setup-cli@[0-9a-f]{40}\s+# v2/.test(workflow)) {
    errors.push('Full database runtime must use the official Supabase CLI action.');
  }
  if (!/^\s+version: 2\.84\.2\s*$/m.test(workflow)) {
    errors.push('Supabase CLI runtime version must remain pinned to 2.84.2.');
  }
  if (!workflow.includes('run: npm run test:db-runtime')) {
    errors.push('Quality workflow must execute the full database runtime gate.');
  }
  return errors;
}

export function validatePinnedActions(workflow) {
  const errors = [];
  const actionLines = workflow.split(/\r?\n/).filter((line) => /\buses:\s*/.test(line));
  if (!actionLines.length) errors.push('Quality workflow must use reviewed GitHub Actions.');
  for (const line of actionLines) {
    if (!/\buses:\s*[^\s@]+@[0-9a-f]{40}(?:\s+#\s*[^\s]+)?\s*$/.test(line)) {
      errors.push(`GitHub Action is not pinned to an immutable commit: ${line.trim()}`);
    }
  }
  return errors;
}

export function validateMaintenanceGate(workflow) {
  const validateJob = jobBody(workflow, 'validate');
  return /^\s+- name: Test production maintenance control plane\s*$[\s\S]*?^\s+run: npm run test:maintenance-tools\s*$/m.test(validateJob)
    ? []
    : ['Quality workflow must test the privileged production maintenance control plane.'];
}

export function validateSecretHistoryGate(workflow) {
  const job = jobBody(workflow, 'secret-history');
  const errors = [];
  if (!job) return ['Quality workflow must include a secret-history job.'];
  if (!hasReadOnlyContentsPermission(job)) {
    errors.push('Secret-history job must use contents: read only.');
  }
  if (!/uses: actions\/checkout@[0-9a-f]{40} # v6[\s\S]*?fetch-depth: 0/.test(job)) {
    errors.push('Secret-history job must check out complete reachable history with an immutable action.');
  }
  const required = [
    ['v3.96.0/trufflehog_3.96.0_linux_amd64.tar.gz', 'pinned TruffleHog release'],
    ['7105f1cd6577f058a9e39d0578f1a99c8a1e481e4d3512cd8a09acfe22a0fdc0', 'reviewed TruffleHog checksum'],
    ["--proto '=https'", 'HTTPS-only download'],
    ['--tlsv1.2', 'TLS minimum'],
    ['sha256sum --check --status', 'archive checksum verification'],
    ['file://$GITHUB_WORKSPACE', 'local full-history source'],
    ['--results=verified,unknown', 'verified and unknown result coverage'],
    ['--fail-on-scan-errors', 'scan-error fail-closed behavior'],
    ['--no-update', 'disabled scanner self-update'],
    ['--github-actions', 'GitHub-aware scan mode'],
  ];
  for (const [token, label] of required) {
    if (!job.includes(token)) errors.push(`Secret-history job is missing required control: ${label}`);
  }
  if (!/(?:^|\s)--fail(?:\s|$)/m.test(job)) {
    errors.push('Secret-history job must fail when a potential credential is found.');
  }
  if (job.includes('continue-on-error')) errors.push('Secret-history job must fail closed.');
  if (job.includes('upload-artifact')) errors.push('Secret-history findings must never be uploaded as an artifact.');
  if (/\bset\s+-[^\n]*x/.test(job) || /\b(?:cat|tail|head)\s+"?\$output/.test(job)) {
    errors.push('Secret-history findings must never be echoed into the job log.');
  }
  if (!/>>?"\$output" 2>&1/.test(job) || !/trap 'rm -f "\$archive" "\$scanner" "\$output"' EXIT/.test(job)) {
    errors.push('Secret-history output must remain redacted and ephemeral.');
  }
  return errors;
}

export function validateProductionSbomGate(workflow) {
  const job = jobBody(workflow, 'production-sbom');
  const validateJob = jobBody(workflow, 'validate');
  const errors = [];
  if (!job) return ['Quality workflow must include a production-sbom job.'];
  if (!hasReadOnlyContentsPermission(job)) {
    errors.push('Production-SBOM job must use contents: read only.');
  }
  for (const command of ['run: npm ci', 'npm run generate:production-sbom', 'npm run verify:production-sbom']) {
    if (!job.includes(command)) errors.push(`Production-SBOM job is missing: ${command}`);
  }
  if (!/uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/.test(job)) {
    errors.push('Production SBOM must use the reviewed immutable artifact action.');
  }
  if (!/uses: actions\/checkout@[0-9a-f]{40} # v6/.test(job) || !/uses: actions\/setup-node@[0-9a-f]{40} # v6/.test(job)) {
    errors.push('Production SBOM must use immutable checkout and Node setup actions.');
  }
  if (!/^          GITHUB_SHA: \$\{\{ github\.sha \}\}\s*$/m.test(job)) {
    errors.push('Production SBOM verification must receive the exact workflow commit SHA.');
  }
  if (!/^          sha256sum spottr-production\.cdx\.json > spottr-production\.cdx\.json\.sha256\s*$/m.test(job)) {
    errors.push('Production SBOM must include a SHA-256 sidecar.');
  }
  const artifactContract = [
    'name: spottr-production-sbom-${{ github.sha }}',
    'spottr-production.cdx.json',
    'spottr-production.cdx.json.sha256',
    'if-no-files-found: error',
    'retention-days: 90',
    'overwrite: false',
    'include-hidden-files: false',
  ];
  for (const token of artifactContract) {
    if (!job.includes(token)) errors.push(`Production-SBOM artifact contract is missing: ${token}`);
  }
  if (!/^          path: \|\r?\n            spottr-production\.cdx\.json\r?\n            spottr-production\.cdx\.json\.sha256\r?$/m.test(job)) {
    errors.push('Production-SBOM upload must contain exactly the SBOM and checksum files.');
  }
  if (job.includes('continue-on-error')) errors.push('Production-SBOM job must fail closed.');
  if (!validateJob.includes('run: npm run test:production-sbom-tools')) {
    errors.push('Validate job must test the production SBOM verifier.');
  }
  return errors;
}

export function validateSbomPackageContract(manifest, lockfile) {
  const errors = [];
  const expectedGenerator = 'cyclonedx-npm --package-lock-only --omit dev --spec-version 1.6 --output-reproducible --output-format JSON --output-file spottr-production.cdx.json --validate';
  if (manifest?.devDependencies?.['@cyclonedx/cyclonedx-npm'] !== '6.0.1') {
    errors.push('CycloneDX npm generator must remain exactly pinned to 6.0.1.');
  }
  if (manifest?.scripts?.['generate:production-sbom'] !== expectedGenerator
    || manifest?.scripts?.['verify:production-sbom'] !== 'node scripts/verify-production-sbom.mjs spottr-production.cdx.json'
    || manifest?.scripts?.['test:production-sbom-tools'] !== 'node --test scripts/verify-production-sbom.test.mjs') {
    errors.push('Production SBOM generation and verification scripts must remain fail-closed and reproducible.');
  }
  if (manifest?.overrides?.libxmljs2 !== '0.37.0' || manifest?.overrides?.tar !== '7.5.22') {
    errors.push('SBOM generator transitive security overrides must remain pinned.');
  }
  const locked = lockfile?.packages?.['node_modules/@cyclonedx/cyclonedx-npm'];
  if (locked?.version !== '6.0.1' || locked?.dev !== true) {
    errors.push('Lockfile must contain the exact CycloneDX development dependency.');
  }
  if (lockfile?.packages?.['node_modules/libxmljs2']?.version !== '0.37.0'
    || lockfile?.packages?.['node_modules/tar']?.version !== '7.5.22') {
    errors.push('Lockfile must retain the reviewed SBOM-generator transitive versions.');
  }
  return errors;
}

export async function verifyQualityWorkflow(projectRoot = PROJECT_ROOT) {
  const [workflow, rawManifest, rawLockfile] = await Promise.all([
    readFile(path.join(projectRoot, '.github', 'workflows', 'quality.yml'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'),
  ]);
  const errors = [
    ...validatePostgresCommands(workflow),
    ...validateFullRuntimeGate(workflow),
    ...validatePinnedActions(workflow),
    ...validateMaintenanceGate(workflow),
    ...validateSecretHistoryGate(workflow),
    ...validateProductionSbomGate(workflow),
    ...validateSbomPackageContract(JSON.parse(rawManifest), JSON.parse(rawLockfile)),
  ];
  if (errors.length) throw new Error(errors.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  verifyQualityWorkflow()
    .then(() => process.stdout.write('Quality workflow is fail-fast, immutable, scans history, and emits a verified production SBOM.\n'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
