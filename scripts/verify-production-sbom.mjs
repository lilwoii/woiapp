import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_NPM_VERSION = '10.9.2';
export const EXPECTED_PACKAGE_MANAGER = `npm@${EXPECTED_NPM_VERSION}`;
export const CYCLONEDX_SCHEMA_URL = 'http://cyclonedx.org/schema/bom-1.5.schema.json';
export const COMMIT_PROPERTY = 'spottr:source-commit';
export const PACKAGE_PATH_PROPERTY = 'cdx:npm:package:path';

const SCHEMA_HASHES = Object.freeze({
  'bom-1.5.schema.json': '067f7824b08653839ea050ae9e09ca48375eadc2652b0e2a299476e7db90335b',
  'jsf-0.82.schema.json': '8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae',
  'spdx.schema.json': '4f6e2b05c05d26a4f2dc5879fbc2fca94b0a28db46289d0c51345621b71cfbfc',
});

const ALGORITHM_NAMES = Object.freeze({
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
});

const ALLOWED_DEV_ONLY_PEERS = new Set([
  '@testing-library/user-event\0@testing-library/dom',
  'react-native-worklets\0@react-native/metro-config',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function packageNameFromPath(packagePath) {
  const match = packagePath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  return match?.[1];
}

function packageIdentity(packagePath, entry) {
  return {
    name: entry.name ?? packageNameFromPath(packagePath),
    version: entry.version,
  };
}

function productionInventory(lockfile) {
  const packages = isRecord(lockfile?.packages) ? lockfile.packages : {};
  return new Map(Object.entries(packages)
    .filter(([packagePath, entry]) => packagePath.includes('node_modules/') && entry?.dev !== true));
}

function componentPath(component) {
  if (!Array.isArray(component?.properties)) return undefined;
  const matches = component.properties.filter((property) => property?.name === PACKAGE_PATH_PROPERTY);
  return matches.length === 1 && typeof matches[0].value === 'string' ? matches[0].value : undefined;
}

function integrityHash(integrity) {
  if (typeof integrity !== 'string') return undefined;
  const token = integrity.trim().split(/\s+/)[0];
  const separator = token.indexOf('-');
  if (separator <= 0) return undefined;
  const algorithm = token.slice(0, separator).toLowerCase();
  const encoded = token.slice(separator + 1).split('?')[0];
  const alg = ALGORITHM_NAMES[algorithm];
  if (!alg || !encoded) return undefined;
  try {
    return { alg, content: Buffer.from(encoded, 'base64').toString('hex') };
  } catch {
    return undefined;
  }
}

function compareCanonical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableReference(packagePath, entry) {
  const identity = packageIdentity(packagePath, entry);
  const digest = createHash('sha256')
    .update(`${packagePath}\0${identity.name}\0${identity.version}`)
    .digest('hex');
  return `urn:spottr:npm:${digest}`;
}

function parentPackagePath(packagePath) {
  const marker = packagePath.lastIndexOf('/node_modules/');
  return marker < 0 ? '' : packagePath.slice(0, marker);
}

function resolveDependencyPath(fromPath, dependencyName, packages) {
  if (!/^(?:@[^/]+\/)?[^/]+$/.test(dependencyName)) return undefined;
  let cursor = fromPath;
  while (true) {
    const candidate = cursor
      ? `${cursor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!cursor) return undefined;
    cursor = parentPackagePath(cursor);
  }
}

function expectedDependencyGraph(lockfile, references) {
  const errors = [];
  const packages = lockfile.packages;
  const productionPaths = new Set(['', ...productionInventory(lockfile).keys()]);
  const graph = new Map();

  for (const packagePath of productionPaths) {
    const entry = packages[packagePath];
    const sourceIdentity = packageIdentity(packagePath, entry);
    const dependencies = new Map();
    for (const [name] of Object.entries(entry.dependencies ?? {})) {
      dependencies.set(name, 'required');
    }
    for (const [name] of Object.entries(entry.optionalDependencies ?? {})) {
      dependencies.set(name, 'optional');
    }
    for (const [name] of Object.entries(entry.peerDependencies ?? {})) {
      if (!dependencies.has(name)) dependencies.set(name, 'peer');
    }

    const targets = new Set();
    for (const [name, kind] of dependencies) {
      const targetPath = resolveDependencyPath(packagePath, name, packages);
      const peerOptional = entry.peerDependenciesMeta?.[name]?.optional === true;
      if (targetPath === undefined) {
        if (kind !== 'optional' && !(kind === 'peer' && peerOptional)) {
          errors.push(`Production lock graph has an unresolved ${kind} dependency.`);
        }
        continue;
      }

      const target = packages[targetPath];
      if (target.dev === true) {
        const allowedPeer = kind === 'peer'
          && ALLOWED_DEV_ONLY_PEERS.has(`${sourceIdentity.name}\0${name}`);
        if (!allowedPeer && kind !== 'optional' && !(kind === 'peer' && peerOptional)) {
          errors.push('Production graph resolves a required dependency only from development scope.');
        }
        continue;
      }

      const targetReference = references.get(targetPath);
      if (!targetReference) {
        errors.push('Production dependency target has no stable SBOM reference.');
        continue;
      }
      targets.add(targetReference);
    }

    if (packagePath === '') {
      for (const [name] of Object.entries(entry.optionalDependencies ?? {})) {
        const targetPath = resolveDependencyPath('', name, packages);
        const targetReference = targetPath && references.get(targetPath);
        if (targetReference) targets.add(targetReference);
      }
    }
    graph.set(references.get(packagePath), [...targets].sort());
  }

  return { graph, errors };
}

function validateManifestAndLock(manifest, lockfile) {
  const errors = [];
  if (manifest?.packageManager !== EXPECTED_PACKAGE_MANAGER) {
    errors.push(`package.json must pin ${EXPECTED_PACKAGE_MANAGER}.`);
  }
  if (lockfile?.lockfileVersion !== 3 || !isRecord(lockfile.packages) || !isRecord(lockfile.packages[''])) {
    errors.push('Production SBOM requires a package-lock v3 root inventory.');
    return errors;
  }
  const root = lockfile.packages[''];
  if (root.name !== manifest?.name || root.version !== manifest?.version) {
    errors.push('Package manifest and lockfile root identities must match.');
  }
  const unsupported = Object.entries(lockfile.packages).filter(([packagePath, entry]) => (
    packagePath !== ''
    && entry?.dev !== true
    && !packagePath.includes('node_modules/')
  ));
  if (unsupported.length) errors.push('Production lockfile contains unsupported workspace or link paths.');

  for (const [packagePath, entry] of productionInventory(lockfile)) {
    const identity = packageIdentity(packagePath, entry);
    if (entry.link === true || !identity.name || typeof identity.version !== 'string' || !integrityHash(entry.integrity)) {
      errors.push('Every production lock component must have a stable name, version, integrity, and non-link path.');
      break;
    }
  }
  return errors;
}

function validateComponentInventory(sbom, manifest, lockfile) {
  const errors = [];
  const root = sbom?.metadata?.component;
  if (!isRecord(root) || root.type !== 'application' || root.name !== manifest.name || root.version !== manifest.version) {
    errors.push('Production SBOM root identity and type must match package.json.');
  }
  if (componentPath(root) !== '') errors.push('Production SBOM root must retain its empty npm package path.');

  const expected = productionInventory(lockfile);
  const observed = new Map();
  if (!Array.isArray(sbom?.components) || sbom.components.length === 0) {
    errors.push('Production SBOM must contain components.');
    return errors;
  }

  for (const component of sbom.components) {
    const packagePath = componentPath(component);
    if (packagePath === undefined || observed.has(packagePath)) {
      errors.push('Every SBOM component must have one unique npm package path.');
      continue;
    }
    observed.set(packagePath, component);
    const entry = expected.get(packagePath);
    if (!entry) {
      errors.push('SBOM contains a component outside the production lock inventory.');
      continue;
    }
    const identity = packageIdentity(packagePath, entry);
    if (component.name !== identity.name || component.version !== identity.version) {
      errors.push('SBOM component identity does not match its production lock path.');
    }
    const expectedHash = integrityHash(entry.integrity);
    const hashMatches = expectedHash && Array.isArray(component.hashes) && component.hashes.some((hash) => (
      hash?.alg === expectedHash?.alg
      && typeof hash.content === 'string'
      && hash.content.toLowerCase() === expectedHash.content
    ));
    if (!hashMatches) errors.push('SBOM component hash does not match package-lock integrity.');
    if (component.properties?.some((property) => (
      property?.name === 'cdx:npm:package:development' && property?.value === 'true'
    ))) {
      errors.push('Development-only components must not appear in the production SBOM.');
    }
  }

  if (observed.size !== expected.size || [...expected.keys()].some((packagePath) => !observed.has(packagePath))) {
    errors.push('SBOM component paths must exactly equal the production package-lock inventory.');
  }
  return errors;
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonicalize(item))
      .sort((left, right) => compareCanonical(JSON.stringify(left), JSON.stringify(right)));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .sort(compareCanonical)
    .map((key) => [key, canonicalize(value[key])]));
}

export function serializeCanonicalSbom(sbom) {
  return `${JSON.stringify(canonicalize(sbom), null, 2)}\n`;
}

export function buildDeterministicProductionSbom(rawSbom, manifest, lockfile, expectedCommit) {
  const errors = [
    ...validateManifestAndLock(manifest, lockfile),
    ...validateComponentInventory(rawSbom, manifest, lockfile),
  ];
  if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? '')) {
    errors.push('Expected commit must be an exact lowercase Git SHA.');
  }
  if (rawSbom?.bomFormat !== 'CycloneDX' || rawSbom?.specVersion !== '1.5' || rawSbom?.version !== 1) {
    errors.push('npm must emit CycloneDX 1.5 document version 1.');
  }
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));

  const sbom = structuredClone(rawSbom);
  delete sbom.serialNumber;
  delete sbom.metadata.timestamp;
  const existingProperties = Array.isArray(sbom.metadata.properties)
    ? sbom.metadata.properties.filter((property) => property?.name !== COMMIT_PROPERTY)
    : [];
  sbom.metadata.properties = [...existingProperties, { name: COMMIT_PROPERTY, value: expectedCommit }];

  const references = new Map();
  references.set('', stableReference('', lockfile.packages['']));
  for (const [packagePath, entry] of productionInventory(lockfile)) {
    references.set(packagePath, stableReference(packagePath, entry));
  }
  sbom.metadata.component['bom-ref'] = references.get('');
  for (const component of sbom.components) {
    component['bom-ref'] = references.get(componentPath(component));
  }

  const { graph, errors: graphErrors } = expectedDependencyGraph(lockfile, references);
  if (graphErrors.length) throw new Error([...new Set(graphErrors)].join('\n'));
  sbom.dependencies = [...graph].map(([ref, dependsOn]) => ({ ref, dependsOn }));

  const normalized = canonicalize(sbom);
  const normalizedErrors = validateProductionSbom(normalized, manifest, lockfile, expectedCommit);
  if (normalizedErrors.length) throw new Error(normalizedErrors.join('\n'));
  return normalized;
}

export function validateProductionSbom(sbom, manifest, lockfile, expectedCommit) {
  const errors = [
    ...validateManifestAndLock(manifest, lockfile),
    ...validateComponentInventory(sbom, manifest, lockfile),
  ];
  if (!isRecord(sbom)) return ['Production SBOM must be a JSON object.'];
  if (sbom.$schema !== CYCLONEDX_SCHEMA_URL || sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') {
    errors.push('Production SBOM must use the official CycloneDX 1.5 JSON schema.');
  }
  if (sbom.version !== 1) errors.push('Production SBOM document version must be 1.');
  if (Object.hasOwn(sbom, 'serialNumber') || Object.hasOwn(sbom.metadata ?? {}, 'timestamp')) {
    errors.push('Reproducible production SBOM must omit random serial numbers and timestamps.');
  }
  if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? '')) {
    errors.push('Expected commit must be an exact lowercase Git SHA.');
  }
  const commitProperties = (sbom.metadata?.properties ?? []).filter((property) => property?.name === COMMIT_PROPERTY);
  if (commitProperties.length !== 1 || commitProperties[0].value !== expectedCommit) {
    errors.push('Production SBOM must contain exactly one source-commit property for the workflow SHA.');
  }
  const npmTools = (sbom.metadata?.tools ?? []).filter((tool) => tool?.vendor === 'npm' && tool?.name === 'cli');
  if (npmTools.length !== 1 || npmTools[0].version !== EXPECTED_NPM_VERSION) {
    errors.push(`Production SBOM must identify npm ${EXPECTED_NPM_VERSION} as its generator.`);
  }

  const references = new Map();
  references.set('', stableReference('', lockfile.packages?.[''] ?? {}));
  for (const [packagePath, entry] of productionInventory(lockfile)) {
    references.set(packagePath, stableReference(packagePath, entry));
  }
  if (sbom.metadata?.component?.['bom-ref'] !== references.get('')) {
    errors.push('Production SBOM root reference is not stable and path-qualified.');
  }
  for (const component of sbom.components ?? []) {
    if (component['bom-ref'] !== references.get(componentPath(component))) {
      errors.push('Production SBOM component reference is not stable and path-qualified.');
      break;
    }
  }

  const allReferences = new Set([
    sbom.metadata?.component?.['bom-ref'],
    ...(sbom.components ?? []).map((component) => component?.['bom-ref']),
  ]);
  if (allReferences.has(undefined) || allReferences.size !== (sbom.components?.length ?? 0) + 1) {
    errors.push('Production SBOM references must be present and unique.');
  }
  const observedGraph = new Map();
  if (!Array.isArray(sbom.dependencies) || sbom.dependencies.length === 0) {
    errors.push('Production SBOM must contain dependency relationships.');
  } else {
    for (const dependency of sbom.dependencies) {
      if (!allReferences.has(dependency?.ref) || observedGraph.has(dependency?.ref)
        || !Array.isArray(dependency?.dependsOn)
        || dependency.dependsOn.some((reference) => !allReferences.has(reference))) {
        errors.push('Production SBOM dependency graph contains a duplicate or dangling reference.');
        continue;
      }
      observedGraph.set(dependency.ref, [...new Set(dependency.dependsOn)].sort());
    }
  }

  const { graph: expectedGraph, errors: graphErrors } = expectedDependencyGraph(lockfile, references);
  errors.push(...graphErrors);
  if (observedGraph.size !== expectedGraph.size || [...expectedGraph].some(([ref, targets]) => (
    JSON.stringify(observedGraph.get(ref)) !== JSON.stringify(targets)
  ))) {
    errors.push('Production SBOM dependency graph must exactly match production lockfile resolution.');
  }
  return [...new Set(errors)];
}

export async function validateAgainstOfficialSchema(sbom, schemaDirectory) {
  if (typeof schemaDirectory !== 'string' || schemaDirectory.length === 0) {
    throw new Error('CycloneDX schema directory is required.');
  }
  const schemas = [];
  for (const [filename, expectedHash] of Object.entries(SCHEMA_HASHES)) {
    const raw = await readFile(path.join(schemaDirectory, filename));
    const observedHash = createHash('sha256').update(raw).digest('hex');
    if (observedHash !== expectedHash) throw new Error(`CycloneDX schema checksum mismatch: ${filename}`);
    schemas.push(JSON.parse(raw.toString('utf8')));
  }

  const [{ default: Ajv }, { default: addFormats }, { default: addDraft2019Formats }] = await Promise.all([
    import('ajv'),
    import('ajv-formats'),
    import('ajv-formats-draft2019'),
  ]);
  const ajv = new Ajv({ strict: false, allErrors: true, schemas });
  addFormats(ajv);
  addDraft2019Formats(ajv);
  const validate = ajv.getSchema(CYCLONEDX_SCHEMA_URL);
  if (typeof validate !== 'function') throw new Error('Official CycloneDX schema did not compile.');
  if (!validate(sbom)) {
    const first = validate.errors?.[0];
    throw new Error(`Official CycloneDX schema rejected the SBOM (${validate.errors?.length ?? 0} issue(s); ${first?.instancePath ?? '/'} ${first?.keyword ?? 'unknown'}).`);
  }
}

export async function verifyProductionSbom(
  filePath,
  expectedCommit = process.env.GITHUB_SHA,
  schemaDirectory = process.env.SPOTTR_CYCLONEDX_SCHEMA_DIR,
) {
  const projectRoot = path.dirname(filePath);
  const [rawSbom, rawManifest, rawLockfile] = await Promise.all([
    readFile(filePath, 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'),
  ]);
  let sbom;
  let manifest;
  let lockfile;
  try {
    sbom = JSON.parse(rawSbom);
    manifest = JSON.parse(rawManifest);
    lockfile = JSON.parse(rawLockfile);
  } catch {
    throw new Error('Production SBOM, package manifest, and lockfile must contain valid JSON.');
  }
  const errors = validateProductionSbom(sbom, manifest, lockfile, expectedCommit);
  if (rawSbom !== serializeCanonicalSbom(sbom)) {
    errors.push('Production SBOM bytes must use deterministic canonical JSON and one final LF.');
  }
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
  await validateAgainstOfficialSchema(sbom, schemaDirectory);
  return { componentCount: sbom.components.length, relationshipCount: sbom.dependencies.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const filePath = path.resolve(process.argv[2] ?? 'spottr-production.cdx.json');
  verifyProductionSbom(filePath)
    .then(({ componentCount, relationshipCount }) => process.stdout.write(
      `Production CycloneDX SBOM verified (${componentCount} components; ${relationshipCount} graph nodes).\n`,
    ))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
