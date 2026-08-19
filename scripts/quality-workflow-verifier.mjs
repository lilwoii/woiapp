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

export function validateTextIntegrityGate(workflow, manifest) {
  const validateJob = jobBody(workflow, 'validate');
  const errors = [];
  for (const command of ['npm run verify:text-integrity', 'npm run test:text-integrity-tools']) {
    if (!validateJob.includes(`run: ${command}`)) {
      errors.push(`Validate job must execute the source text-integrity control: ${command}.`);
    }
    if (!manifest?.scripts?.validate?.includes(command)) {
      errors.push(`Aggregate validation must retain the source text-integrity control: ${command}.`);
    }
  }
  if (manifest?.scripts?.['verify:text-integrity'] !== 'node scripts/verify-text-integrity.mjs'
    || manifest?.scripts?.['test:text-integrity-tools'] !== 'node --test scripts/verify-text-integrity.test.mjs') {
    errors.push('Source text-integrity scripts must remain fail-closed and repository-owned.');
  }
  return errors;
}

export function validateSecretHistoryGate(workflow, manifest) {
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
    ['--no-verification', 'detector verification and credentialed lookups disabled'],
    ['--results=unverified,unknown', 'unverified and unknown result coverage'],
    ['--fail-on-scan-errors', 'scan-error fail-closed behavior'],
    ['--no-update', 'disabled scanner self-update'],
    ['--log-level=-1', 'quiet scanner logging'],
    ['--json', 'machine-readable scanner output'],
    ['scanner_status=0', 'preserved scanner status'],
    ['|| scanner_status=$?', 'preserved scanner status on findings/errors'],
    ['node scripts/verify-trufflehog-output.mjs "$output" "$scanner_error" "$scanner_status"', 'repository-owned fail-closed parser'],
  ];
  for (const [token, label] of required) {
    if (!job.includes(token)) errors.push(`Secret-history job is missing required control: ${label}`);
  }
  if (!/(?:^|\s)--fail(?:\s|$)/m.test(job)) {
    errors.push('Secret-history job must fail when a potential credential is found.');
  }
  if (job.includes('continue-on-error')) errors.push('Secret-history job must fail closed.');
  if (job.includes('upload-artifact')) errors.push('Secret-history findings must never be uploaded as an artifact.');
  if (/\bset\s+-[^\n]*x/.test(job) || /\b(?:cat|tail|head)\s+[^\n]*(?:\$output|\$scanner_error|trufflehog)/.test(job)) {
    errors.push('Secret-history findings must never be echoed into the job log.');
  }
  if (/--exclude-(?:detectors|paths|globs)/.test(job)) {
    errors.push('Secret-history job must scan the complete repository without TruffleHog exclusions.');
  }
  if (!/>"\$output" 2>"\$scanner_error"/.test(job) || !/trap 'rm -f "\$archive" "\$scanner" "\$output" "\$scanner_error"' EXIT/.test(job)) {
    errors.push('Secret-history output must remain redacted and ephemeral.');
  }
  const validateJob = jobBody(workflow, 'validate');
  if (!validateJob.includes('npm run test:secret-history-tools')
    || manifest?.scripts?.['test:secret-history-tools'] !== 'node --test scripts/verify-trufflehog-output.test.mjs'
    || !manifest?.scripts?.validate?.includes('test:secret-history-tools')) {
    errors.push('validate must run the exact repository-owned secret-history parser test through package.json');
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
  if (!/^          SPOTTR_CYCLONEDX_SCHEMA_DIR: \$\{\{ runner\.temp \}\}\/cyclonedx-schema-1\.5\s*$/m.test(job)) {
    errors.push('Production SBOM verification must use the isolated official-schema directory.');
  }
  const schemaContract = [
    'CycloneDX/specification/c320fc0f0b46873864927d9d5684eea7ba439728/schema',
    '067f7824b08653839ea050ae9e09ca48375eadc2652b0e2a299476e7db90335b',
    '8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae',
    '4f6e2b05c05d26a4f2dc5879fbc2fca94b0a28db46289d0c51345621b71cfbfc',
    "--proto '=https'",
    '--tlsv1.2',
    'sha256sum --check --status',
  ];
  for (const token of schemaContract) {
    if (!job.includes(token)) errors.push(`Production-SBOM schema contract is missing: ${token}`);
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
  const expectedGenerator = 'node scripts/generate-production-sbom.mjs spottr-production.cdx.json';
  if (manifest?.packageManager !== 'npm@10.9.2') {
    errors.push('Production SBOM package manager must remain exactly pinned to npm 10.9.2.');
  }
  if (manifest?.devDependencies?.['@cyclonedx/cyclonedx-npm'] !== undefined
    || lockfile?.packages?.['node_modules/@cyclonedx/cyclonedx-npm'] !== undefined) {
    errors.push('The crashing third-party CycloneDX generator must not return to the release path.');
  }
  if (manifest?.devDependencies?.ajv !== '8.20.0'
    || manifest?.devDependencies?.['ajv-formats'] !== '3.0.1'
    || manifest?.devDependencies?.['ajv-formats-draft2019'] !== '1.6.1') {
    errors.push('Official CycloneDX schema validators must remain exactly pinned.');
  }
  if (manifest?.devDependencies?.['@react-native/metro-config'] !== '0.86.2'
    || manifest?.devDependencies?.['@testing-library/dom'] !== '10.4.1'
    || manifest?.dependencies?.['react-native-gesture-handler'] !== '~2.32.0') {
    errors.push('Production dependency graph peers must remain present in their reviewed runtime/tooling scopes.');
  }
  if (manifest?.scripts?.['generate:production-sbom'] !== expectedGenerator
    || manifest?.scripts?.['verify:production-sbom'] !== 'node scripts/verify-production-sbom.mjs spottr-production.cdx.json'
    || manifest?.scripts?.['test:production-sbom-tools'] !== 'node --test scripts/verify-production-sbom.test.mjs') {
    errors.push('Production SBOM generation and verification scripts must remain fail-closed and reproducible.');
  }
  if (manifest?.overrides?.libxmljs2 !== undefined || manifest?.overrides?.tar !== undefined
    || lockfile?.packages?.['node_modules/libxmljs2'] !== undefined
    || lockfile?.packages?.['node_modules/tar'] !== undefined) {
    errors.push('Obsolete third-party generator dependencies and overrides must remain absent.');
  }
  const ajv = lockfile?.packages?.['node_modules/ajv'];
  const ajvFormats = lockfile?.packages?.['node_modules/ajv-formats'];
  const draftFormats = lockfile?.packages?.['node_modules/ajv-formats-draft2019'];
  if (ajv?.version !== '8.20.0' || ajv?.dev !== true
    || ajvFormats?.version !== '3.0.1' || ajvFormats?.dev !== true
    || draftFormats?.version !== '1.6.1' || draftFormats?.dev !== true) {
    errors.push('Lockfile must retain exact schema-validator versions.');
  }
  const metro = lockfile?.packages?.['node_modules/@react-native/metro-config'];
  const testingDom = lockfile?.packages?.['node_modules/@testing-library/dom'];
  const gestureHandler = lockfile?.packages?.['node_modules/react-native-gesture-handler'];
  if (metro?.version !== '0.86.2' || metro?.dev !== true
    || testingDom?.version !== '10.4.1' || testingDom?.dev !== true
    || gestureHandler?.version !== '2.32.0' || gestureHandler?.dev === true) {
    errors.push('Lockfile must satisfy the reviewed production graph peers without moving tooling into runtime scope.');
  }
  return errors;
}

export function validateSbomImplementationContract(generator, verifier) {
  const errors = [];
  const generatorControls = [
    'spawnSync(process.execPath',
    "'sbom'",
    "'--package-lock-only'",
    "'--omit=dev'",
    "'--sbom-format=cyclonedx'",
    "'--sbom-type=application'",
    'maxBuffer: MAX_OUTPUT_BYTES',
    'result.stderr.trim().length > 0',
    'buildDeterministicProductionSbom',
    'validateAgainstOfficialSchema',
  ];
  for (const token of generatorControls) {
    if (!generator.includes(token)) errors.push(`Production SBOM generator is missing: ${token}`);
  }
  if (/--(?:force|ignore-npm-errors)|shell:\s*true|\bexec(?:File)?Sync\s*\(/.test(generator)) {
    errors.push('Production SBOM generator must not bypass npm errors or invoke a shell.');
  }
  const verifierControls = [
    'spottr:source-commit',
    'productionInventory',
    'expectedDependencyGraph',
    'stableReference',
    'validateAgainstOfficialSchema',
    'SBOM component paths must exactly equal the production package-lock inventory.',
    'Production SBOM dependency graph must exactly match production lockfile resolution.',
    '067f7824b08653839ea050ae9e09ca48375eadc2652b0e2a299476e7db90335b',
    '8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae',
    '4f6e2b05c05d26a4f2dc5879fbc2fca94b0a28db46289d0c51345621b71cfbfc',
  ];
  for (const token of verifierControls) {
    if (!verifier.includes(token)) errors.push(`Production SBOM verifier is missing: ${token}`);
  }
  return errors;
}

export async function verifyQualityWorkflow(projectRoot = PROJECT_ROOT) {
  const [workflow, rawManifest, rawLockfile, generator, verifier] = await Promise.all([
    readFile(path.join(projectRoot, '.github', 'workflows', 'quality.yml'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'generate-production-sbom.mjs'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'verify-production-sbom.mjs'), 'utf8'),
  ]);
  const manifest = JSON.parse(rawManifest);
  const lockfile = JSON.parse(rawLockfile);
  const errors = [
    ...validatePostgresCommands(workflow),
    ...validateFullRuntimeGate(workflow),
    ...validatePinnedActions(workflow),
    ...validateMaintenanceGate(workflow),
    ...validateTextIntegrityGate(workflow, manifest),
    ...validateSecretHistoryGate(workflow, manifest),
    ...validateProductionSbomGate(workflow),
    ...validateSbomPackageContract(manifest, lockfile),
    ...validateSbomImplementationContract(generator, verifier),
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
