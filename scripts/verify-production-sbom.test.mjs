import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProductionSbom } from './verify-production-sbom.mjs';

const manifest = { name: 'spottr-food', version: '0.2.0' };
const commit = 'a'.repeat(40);
const valid = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: { component: { type: 'application', name: manifest.name, version: manifest.version } },
  components: [{ type: 'library', name: 'react', version: '19.2.3' }],
  dependencies: [{ ref: 'spottr-food@0.2.0', dependsOn: ['react@19.2.3'] }],
};

test('accepts a populated CycloneDX 1.6 application SBOM bound to an exact commit', () => {
  assert.deepEqual(validateProductionSbom(valid, manifest, commit), []);
});

test('rejects wrong format, identity, document version, and malformed commit evidence', () => {
  const errors = validateProductionSbom({
    ...valid,
    bomFormat: 'SPDX',
    specVersion: '1.5',
    version: 2,
    metadata: { component: { type: 'library', name: 'another-app', version: '9.9.9' } },
  }, manifest, 'main');
  assert.ok(errors.some((error) => error.includes('CycloneDX')));
  assert.ok(errors.some((error) => error.includes('1.6')));
  assert.ok(errors.some((error) => error.includes('document version')));
  assert.ok(errors.some((error) => error.includes('application')));
  assert.ok(errors.some((error) => error.includes('package.json')));
  assert.ok(errors.some((error) => error.includes('Git SHA')));
});

test('rejects empty or malformed component and dependency inventories', () => {
  assert.ok(validateProductionSbom({ ...valid, components: [], dependencies: [] }, manifest, commit).length >= 2);
  assert.ok(validateProductionSbom(null, manifest, commit).length > 0);
});
