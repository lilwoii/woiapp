import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  assertPinnedNpmVersion,
  parseNpmSbomOutput,
} from './generate-production-sbom.mjs';
import {
  buildDeterministicProductionSbom,
  CYCLONEDX_SCHEMA_URL,
  EXPECTED_PACKAGE_MANAGER,
  serializeCanonicalSbom,
  validateProductionSbom,
} from './verify-production-sbom.mjs';

const commit = 'a'.repeat(40);
const manifest = {
  name: 'spottr-fixture',
  version: '1.0.0',
  packageManager: EXPECTED_PACKAGE_MANAGER,
};

function integrity(byte) {
  return `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
}

function hash(byte) {
  return Buffer.alloc(64, byte).toString('hex');
}

const lockfile = {
  name: manifest.name,
  version: manifest.version,
  lockfileVersion: 3,
  packages: {
    '': {
      name: manifest.name,
      version: manifest.version,
      dependencies: { alpha: '1.0.0', shared: '1.0.0' },
      devDependencies: { devtool: '9.0.0' },
    },
    'node_modules/alpha': {
      version: '1.0.0',
      integrity: integrity(1),
      dependencies: { shared: '1.0.0' },
    },
    'node_modules/alpha/node_modules/shared': {
      version: '1.0.0',
      integrity: integrity(2),
    },
    'node_modules/shared': {
      version: '1.0.0',
      integrity: integrity(3),
    },
    'node_modules/devtool': {
      version: '9.0.0',
      integrity: integrity(9),
      dev: true,
    },
  },
};

function component(name, packagePath, byte) {
  return {
    'bom-ref': `${name}@1.0.0`,
    type: 'library',
    name,
    version: '1.0.0',
    hashes: [{ alg: 'SHA-512', content: hash(byte) }],
    properties: [{ name: 'cdx:npm:package:path', value: packagePath }],
  };
}

function rawSbom(serial = 'one', timestamp = '2026-01-01T00:00:00.000Z') {
  return {
    $schema: CYCLONEDX_SCHEMA_URL,
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: 'npm', name: 'cli', version: '10.9.2' }],
      component: {
        'bom-ref': `${manifest.name}@${manifest.version}`,
        type: 'application',
        name: manifest.name,
        version: manifest.version,
        properties: [{ name: 'cdx:npm:package:path', value: '' }],
      },
    },
    components: [
      component('shared', 'node_modules/shared', 3),
      component('alpha', 'node_modules/alpha', 1),
      component('shared', 'node_modules/alpha/node_modules/shared', 2),
    ],
    dependencies: [
      { ref: `${manifest.name}@${manifest.version}`, dependsOn: ['alpha@1.0.0', 'shared@1.0.0'] },
    ],
  };
}

test('normalizes random npm fields and duplicate name/version references deterministically', () => {
  const first = buildDeterministicProductionSbom(rawSbom('one'), manifest, lockfile, commit);
  const second = buildDeterministicProductionSbom(
    rawSbom('two', '2030-02-03T04:05:06.000Z'),
    manifest,
    lockfile,
    commit,
  );
  assert.equal(serializeCanonicalSbom(first), serializeCanonicalSbom(second));
  assert.equal(new Set(first.components.map((item) => item['bom-ref'])).size, 3);
  assert.equal(validateProductionSbom(first, manifest, lockfile, commit).length, 0);
  assert.ok(serializeCanonicalSbom(first).endsWith('\n'));
});

test('restores omitted cross-platform components and strips injected development-only components', () => {
  const missing = rawSbom();
  missing.components.pop();
  const restored = buildDeterministicProductionSbom(missing, manifest, lockfile, commit);
  assert.equal(restored.components.length, 3);

  const injected = rawSbom();
  injected.components.push({
    ...component('devtool', 'node_modules/devtool', 9),
    properties: [
      { name: 'cdx:npm:package:path', value: 'node_modules/devtool' },
      { name: 'cdx:npm:package:development', value: 'true' },
    ],
  });
  const stripped = buildDeterministicProductionSbom(injected, manifest, lockfile, commit);
  assert.equal(stripped.components.length, 3);
  assert.ok(stripped.components.every((item) => item.name !== 'devtool'));
});

test('rejects malformed commits, unresolved lock dependencies, and npm version drift', () => {
  assert.throws(() => buildDeterministicProductionSbom(rawSbom(), manifest, lockfile, 'main'), /Git SHA/);
  const unresolved = structuredClone(lockfile);
  unresolved.packages[''].dependencies.missing = '1.0.0';
  assert.throws(
    () => buildDeterministicProductionSbom(rawSbom(), manifest, unresolved, commit),
    /unresolved required dependency/,
  );
  assert.doesNotThrow(() => assertPinnedNpmVersion('10.9.2'));
  assert.throws(() => assertPinnedNpmVersion('latest'), /requires npm 10\.9\.2/);
});

test('rejects dangling graph references, duplicate references, and malformed npm JSON', () => {
  const sbom = buildDeterministicProductionSbom(rawSbom(), manifest, lockfile, commit);
  const dangling = structuredClone(sbom);
  dangling.dependencies[0].dependsOn.push('urn:spottr:npm:missing');
  assert.ok(validateProductionSbom(dangling, manifest, lockfile, commit)
    .some((error) => error.includes('dangling')));

  const duplicate = structuredClone(sbom);
  duplicate.components[0]['bom-ref'] = duplicate.metadata.component['bom-ref'];
  assert.ok(validateProductionSbom(duplicate, manifest, lockfile, commit)
    .some((error) => error.includes('unique')));

  assert.deepEqual(parseNpmSbomOutput('{"ok":true}'), { ok: true });
  assert.throws(() => parseNpmSbomOutput(''), /no JSON/);
  assert.throws(() => parseNpmSbomOutput('{"partial"'), /malformed or partial/);
});
