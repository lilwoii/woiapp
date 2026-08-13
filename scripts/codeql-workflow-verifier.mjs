import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEQL_COMMIT = '5595ccaf912efad79be6eef63a5619ff05969be3';

export function validateCodeqlWorkflow(workflow) {
  const errors = [];
  const required = [
    ['name: CodeQL', 'stable workflow name'],
    ['  pull_request:', 'pull-request scans'],
    ['  push:', 'push scans'],
    ['      - main', 'main-branch scans'],
    ['  schedule:', 'recurring scans'],
    ['    - cron: "23 11 * * 2"', 'reviewed weekly schedule'],
    ['  workflow_dispatch:', 'manual scans'],
    ['  contents: read', 'read-only default permission'],
    ['      security-events: write', 'SARIF upload permission'],
    ['    timeout-minutes: 20', 'bounded execution'],
    ['      fail-fast: false', 'complete language-matrix analysis'],
    ['          - javascript-typescript', 'JavaScript and TypeScript analysis'],
    ['          - actions', 'GitHub Actions workflow analysis'],
    ['          languages: ${{ matrix.language }}', 'matrix language selection'],
    ['          build-mode: none', 'interpreted-language build mode'],
    ['          queries: security-extended', 'extended security query suite'],
    ['          category: "/language:${{ matrix.language }}"', 'stable result category'],
  ];
  for (const [token, label] of required) {
    if (!workflow.includes(token)) errors.push(`CodeQL workflow is missing ${label}.`);
  }
  const permissionLines = workflow.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:actions|checks|contents|deployments|discussions|id-token|issues|packages|pages|pull-requests|repository-projects|security-events|statuses): (?:read|write|none)$/.test(line))
    .sort();
  const expectedPermissions = [
    'contents: read',
    'contents: read',
    'packages: read',
    'security-events: write',
  ].sort();
  if (JSON.stringify(permissionLines) !== JSON.stringify(expectedPermissions)) {
    errors.push('CodeQL permissions must remain exactly least privilege.');
  }

  const actionLines = workflow.split(/\r?\n/).filter((line) => /\buses:\s*/.test(line));
  if (actionLines.length !== 3) errors.push('CodeQL workflow must use exactly checkout, init, and analyze actions.');
  for (const line of actionLines) {
    if (!/\buses:\s*[^\s@]+@[0-9a-f]{40}\s+#\s*[^\s]+\s*$/.test(line)) {
      errors.push(`CodeQL action is not pinned to an immutable commit: ${line.trim()}`);
    }
  }
  if (!workflow.includes(`github/codeql-action/init@${CODEQL_COMMIT} # v4`)
    || !workflow.includes(`github/codeql-action/analyze@${CODEQL_COMMIT} # v4`)) {
    errors.push('CodeQL init and analyze must use the same reviewed v4 commit.');
  }
  if (!workflow.includes('actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6')) {
    errors.push('CodeQL must use the reviewed immutable checkout action.');
  }
  if (/continue-on-error:|pull_request_target:|\bsecrets\./.test(workflow)) {
    errors.push('CodeQL must fail closed, avoid privileged pull-request execution, and use no repository secrets.');
  }
  return errors;
}

export async function verifyCodeqlWorkflow(projectRoot = PROJECT_ROOT) {
  const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'codeql.yml'), 'utf8');
  const errors = validateCodeqlWorkflow(workflow);
  if (errors.length) throw new Error(errors.join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  verifyCodeqlWorkflow()
    .then(() => process.stdout.write('CodeQL scans application and workflow code with immutable, least-privilege controls.\n'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
