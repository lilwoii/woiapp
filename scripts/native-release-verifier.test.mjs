import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  parsePrivacyAccessRequirements,
  validateArtifactMetadata,
  validateNativeConfiguration,
} from './native-release-verifier.mjs';

const require = createRequire(import.meta.url);
const appBase = require('../app.base.json');
const eas = require('../eas.json');

test('privacy manifest parser extracts every reason for each API category', () => {
  const parsed = parsePrivacyAccessRequirements(`
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryDiskSpace</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>E174.1</string><string>85F4.1</string></array>
    </dict>
  `);
  assert.deepEqual([...parsed.get('NSPrivacyAccessedAPICategoryDiskSpace')], ['E174.1', '85F4.1']);
});

test('native configuration fails closed when an SDK privacy reason is absent', () => {
  const requirements = new Map([
    ['NSPrivacyAccessedAPICategoryUserDefaults', new Set(['CA92.1', 'MISSING.1'])],
  ]);
  const errors = validateNativeConfiguration(appBase, eas, requirements);
  assert.ok(errors.some((error) => error.includes('MISSING.1')));
});

test('native configuration rejects newly introduced privileged permissions', () => {
  const changed = structuredClone(appBase);
  changed.expo.android.permissions.push('android.permission.CAMERA');
  const errors = validateNativeConfiguration(changed, eas, new Map());
  assert.ok(errors.some((error) => error.includes('Unexpected Android permission')));
});

test('artifact metadata rejects traversal and non-Hermes bundles', () => {
  const errors = validateArtifactMetadata({
    bundler: 'metro',
    fileMetadata: {
      ios: {
        bundle: '../outside.js',
        assets: [{ path: 'assets/good.png' }],
      },
    },
  }, 'ios');
  assert.ok(errors.some((error) => error.includes('unsafe')));
  assert.ok(errors.some((error) => error.includes('Hermes')));
});
