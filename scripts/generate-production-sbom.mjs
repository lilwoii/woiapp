import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildDeterministicProductionSbom,
  EXPECTED_NPM_VERSION,
  serializeCanonicalSbom,
  validateAgainstOfficialSchema,
} from './verify-production-sbom.mjs';

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const OUTPUT_FILENAME = 'spottr-production.cdx.json';

export function assertPinnedNpmVersion(version) {
  if (version !== EXPECTED_NPM_VERSION) {
    throw new Error(`Production SBOM requires npm ${EXPECTED_NPM_VERSION}; received ${version || 'no version'}.`);
  }
}

export function parseNpmSbomOutput(output) {
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error('npm SBOM returned no JSON output.');
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('npm SBOM returned malformed or partial JSON output.');
  }
}

function runNpmCli(npmExecPath, args) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`Pinned npm SBOM command failed closed (status ${result.status ?? 'none'}).`);
  }
  if (result.stderr.trim().length > 0) {
    throw new Error(`Pinned npm SBOM command emitted unexpected diagnostics (${Buffer.byteLength(result.stderr)} bytes).`);
  }
  return result.stdout;
}

export async function generateProductionSbom(
  outputPath,
  expectedCommit = process.env.GITHUB_SHA,
  schemaDirectory = process.env.SPOTTR_CYCLONEDX_SCHEMA_DIR,
  npmExecPath = process.env.npm_execpath,
) {
  const expectedOutput = path.resolve(OUTPUT_FILENAME);
  if (path.resolve(outputPath) !== expectedOutput) {
    throw new Error(`Production SBOM output must be ${OUTPUT_FILENAME} in the project root.`);
  }
  if (typeof npmExecPath !== 'string' || !path.isAbsolute(npmExecPath)
    || path.basename(npmExecPath).toLowerCase() !== 'npm-cli.js') {
    throw new Error('Production SBOM must run through the npm CLI supplied by the pinned npm script.');
  }

  const version = runNpmCli(npmExecPath, ['--version']).trim();
  assertPinnedNpmVersion(version);
  const rawOutput = runNpmCli(npmExecPath, [
    'sbom',
    '--package-lock-only',
    '--omit=dev',
    '--sbom-format=cyclonedx',
    '--sbom-type=application',
    '--loglevel=error',
  ]);
  const rawSbom = parseNpmSbomOutput(rawOutput);
  const [manifest, lockfile] = await Promise.all([
    readFile(path.resolve('package.json'), 'utf8').then(JSON.parse),
    readFile(path.resolve('package-lock.json'), 'utf8').then(JSON.parse),
  ]);
  const sbom = buildDeterministicProductionSbom(rawSbom, manifest, lockfile, expectedCommit);
  await validateAgainstOfficialSchema(sbom, schemaDirectory);
  await writeFile(expectedOutput, serializeCanonicalSbom(sbom), { encoding: 'utf8', mode: 0o600 });
  return { componentCount: sbom.components.length, relationshipCount: sbom.dependencies.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputPath = path.resolve(process.argv[2] ?? OUTPUT_FILENAME);
  generateProductionSbom(outputPath)
    .then(({ componentCount, relationshipCount }) => process.stdout.write(
      `Generated deterministic production SBOM (${componentCount} components; ${relationshipCount} graph nodes).\n`,
    ))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
