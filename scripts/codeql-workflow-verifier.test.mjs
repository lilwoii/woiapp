import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCodeqlWorkflow } from './codeql-workflow-verifier.mjs';

const commit = '5595ccaf912efad79be6eef63a5619ff05969be3';
const workflow = `name: CodeQL
on:
  pull_request:
  push:
    branches:
      - main
  schedule:
    - cron: "23 11 * * 2"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  analyze:
    permissions:
      contents: read
      packages: read
      security-events: write
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        language:
          - javascript-typescript
          - actions
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
      - uses: github/codeql-action/init@${commit} # v4
        with:
          languages: \${{ matrix.language }}
          build-mode: none
          queries: security-extended
      - uses: github/codeql-action/analyze@${commit} # v4
        with:
          category: "/language:\${{ matrix.language }}"
`;

test('accepts the immutable least-privilege application and workflow scan', () => {
  assert.deepEqual(validateCodeqlWorkflow(workflow), []);
});

test('rejects mutable, narrowed, privileged, or non-blocking analysis', () => {
  for (const [from, to] of [
    [`init@${commit}`, 'init@v4'],
    ['          - actions', '          - ruby'],
    ['queries: security-extended', 'queries: security-and-quality'],
    ['  pull_request:', '  pull_request_target:'],
    ['    timeout-minutes: 20', '    timeout-minutes: 0'],
    ['      fail-fast: false', '      continue-on-error: true'],
    ['      packages: read', '      packages: read\n      actions: write'],
  ]) {
    assert.ok(validateCodeqlWorkflow(workflow.replace(from, to)).length > 0);
  }
});
