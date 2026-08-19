import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  parsePrivacyAccessRequirements,
  validateArtifactMetadata,
  validateNativeConfiguration,
  verifyArtifact,
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

test('native artifact verifier rejects fixture state in a non-bundle asset', async (context) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'spottr-native-purity-'));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const outputRoot = path.join(projectRoot, 'dist-ios');
  const bundlePath = path.join(outputRoot, 'bundles', 'app.hbc');
  const assetPath = path.join(outputRoot, 'assets', 'icon.txt');
  await Promise.all([
    mkdir(path.dirname(bundlePath), { recursive: true }),
    mkdir(path.dirname(assetPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(bundlePath, Buffer.alloc(100_001, 0x61)),
    writeFile(assetPath, 'spottr-fixture.supabase.co'),
    writeFile(path.join(outputRoot, 'metadata.json'), JSON.stringify({
      bundler: 'metro',
      fileMetadata: {
        ios: {
          bundle: 'bundles/app.hbc',
          assets: [{ path: 'assets/icon.txt' }],
        },
      },
    })),
  ]);

  await assert.rejects(
    verifyArtifact(projectRoot, 'ios'),
    /production output contains synthetic fixture state/,
  );
});
