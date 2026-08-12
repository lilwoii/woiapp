import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProductionAudit } from './production-audit-gate.mjs';

const report = (vulnerabilities, critical = 0) => ({
  vulnerabilities,
  metadata: { vulnerabilities: { critical } },
});

test('accepts only the documented Metro image parser advisory chain', () => {
  assert.deepEqual(validateProductionAudit(report({
    'image-size': {
      severity: 'high',
      via: [{ source: 1138808 }, { source: 1138809 }],
      effects: ['metro'],
    },
    metro: { severity: 'high', via: ['image-size'], effects: ['@expo/metro'] },
    expo: { severity: 'high', via: ['@expo/metro'], effects: [] },
  })), []);
});

test('rejects new advisories, packages, effects, and all critical findings', () => {
  const errors = validateProductionAudit(report({
    'image-size': { severity: 'high', via: [{ source: 9999999 }], effects: ['unknown-runtime'] },
    'new-package': { severity: 'high', via: [], effects: [] },
  }, 1));
  assert.ok(errors.some((error) => error.includes('unapproved advisory')));
  assert.ok(errors.some((error) => error.includes('unexpected affected package')));
  assert.ok(errors.some((error) => error.includes('new-package')));
  assert.ok(errors.some((error) => error.includes('critical vulnerability')));
});
