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

export async function verifyQualityWorkflow(projectRoot = PROJECT_ROOT) {
  const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'quality.yml'), 'utf8');
  const errors = validatePostgresCommands(workflow);
  if (errors.length) throw new Error(errors.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  verifyQualityWorkflow()
    .then(() => process.stdout.write('Quality workflow SQL execution is fail-fast and transactional.\n'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
