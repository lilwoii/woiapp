import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateProductionSbom(sbom, manifest, expectedCommit) {
  const errors = [];
  if (!sbom || typeof sbom !== 'object' || Array.isArray(sbom)) {
    return ['Production SBOM must be a JSON object.'];
  }
  if (sbom.bomFormat !== 'CycloneDX') errors.push('Production SBOM must use CycloneDX.');
  if (sbom.specVersion !== '1.6') errors.push('Production SBOM must use CycloneDX 1.6.');
  if (sbom.version !== 1) errors.push('Production SBOM document version must be 1.');
  const root = sbom.metadata?.component;
  if (root?.type !== 'application') errors.push('Production SBOM root must be an application.');
  if (root?.name !== manifest?.name || root?.version !== manifest?.version) {
    errors.push('Production SBOM root identity must match package.json.');
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    errors.push('Production SBOM must contain components.');
  }
  if (!Array.isArray(sbom.dependencies) || sbom.dependencies.length === 0) {
    errors.push('Production SBOM must contain dependency relationships.');
  }
  if (typeof expectedCommit !== 'string' || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    errors.push('Expected commit must be an exact lowercase Git SHA.');
  }
  return errors;
}

export async function verifyProductionSbom(filePath, expectedCommit = process.env.GITHUB_SHA) {
  const [rawSbom, rawManifest] = await Promise.all([
    readFile(filePath, 'utf8'),
    readFile(path.resolve(path.dirname(filePath), 'package.json'), 'utf8'),
  ]);
  let sbom;
  let manifest;
  try {
    sbom = JSON.parse(rawSbom);
    manifest = JSON.parse(rawManifest);
  } catch {
    throw new Error('Production SBOM and package manifest must contain valid JSON.');
  }
  const errors = validateProductionSbom(sbom, manifest, expectedCommit);
  if (errors.length) throw new Error(errors.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const filePath = path.resolve(process.argv[2] ?? 'spottr-production.cdx.json');
  verifyProductionSbom(filePath)
    .then(() => process.stdout.write('Production CycloneDX SBOM is valid and commit-bound by the release workflow.\n'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
