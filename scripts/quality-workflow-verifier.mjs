import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const validateStart = workflow.search(/^  validate:\s*$/m);
  if (validateStart < 0) {
    return ['Quality workflow must test the privileged production maintenance control plane.'];
  }
  const bodyStart = workflow.indexOf('\n', validateStart);
  const remaining = bodyStart < 0 ? '' : workflow.slice(bodyStart + 1);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  const validateJob = nextJob < 0 ? remaining : remaining.slice(0, nextJob);
  return /^\s+- name: Test production maintenance control plane\s*$[\s\S]*?^\s+run: npm run test:maintenance-tools\s*$/m.test(validateJob)
    ? []
    : ['Quality workflow must test the privileged production maintenance control plane.'];
}

export async function verifyQualityWorkflow(projectRoot = PROJECT_ROOT) {
  const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'quality.yml'), 'utf8');
  const errors = [
    ...validatePostgresCommands(workflow),
    ...validateFullRuntimeGate(workflow),
    ...validatePinnedActions(workflow),
    ...validateMaintenanceGate(workflow),
  ];
  if (errors.length) throw new Error(errors.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  verifyQualityWorkflow()
    .then(() => process.stdout.write('Quality workflow is fail-fast, immutable, and covers privileged maintenance.\n'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
