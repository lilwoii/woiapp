import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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

test('native configuration rejects enabled or implicit high-risk production features', () => {
  const enabledFeature = structuredClone(eas);
  enabledFeature.build.production.env.EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED = 'true';
  assert.ok(
    validateNativeConfiguration(appBase, enabledFeature, new Map())
      .some((error) => error.includes('EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED=false')),
  );

  const missingFeature = structuredClone(eas);
  delete missingFeature.build.production.env.EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED;
  assert.ok(
    validateNativeConfiguration(appBase, missingFeature, new Map())
      .some((error) => error.includes('EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED=false')),
  );
});

test('native configuration keeps photo permission disclosures complete and aligned', () => {
  const drifted = structuredClone(appBase);
  const driftedPicker = drifted.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker');
  driftedPicker[1].photosPermission = 'Spottr uses your photos for review images, but this text has drifted from iOS.';
  assert.ok(
    validateNativeConfiguration(drifted, eas, new Map())
      .some((error) => error.includes('must remain identical')),
  );

  const incomplete = structuredClone(appBase);
  const incompleteText = 'Spottr uses photo access for business and review images when you choose them.';
  incomplete.expo.ios.infoPlist.NSPhotoLibraryUsageDescription = incompleteText;
  const incompletePicker = incomplete.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker');
  incompletePicker[1].photosPermission = incompleteText;
  const errors = validateNativeConfiguration(incomplete, eas, new Map());
  assert.ok(errors.some((error) => error.includes('profile image purpose')));
  assert.ok(errors.some((error) => error.includes('banner image purpose')));
});

test('native notification configuration requires the plugin without background delivery', () => {
  const missingPlugin = structuredClone(appBase);
  missingPlugin.expo.plugins = missingPlugin.expo.plugins.filter((plugin) =>
    plugin !== 'expo-notifications' && !(Array.isArray(plugin) && plugin[0] === 'expo-notifications')
  );
  assert.ok(
    validateNativeConfiguration(missingPlugin, eas, new Map())
      .some((error) => error.includes('expo-notifications must remain explicitly configured')),
  );

  const backgroundEnabled = structuredClone(appBase);
  backgroundEnabled.expo.ios.infoPlist.UIBackgroundModes = ['remote-notification'];
  assert.ok(
    validateNativeConfiguration(backgroundEnabled, eas, new Map())
      .some((error) => error.includes('Background remote notifications')),
  );
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

test('native artifact verifier rejects fictional listing data in a bundle', async (context) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'spottr-native-demo-purity-'));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const outputRoot = path.join(projectRoot, 'dist-ios');
  const bundlePath = path.join(outputRoot, 'bundles', 'app.hbc');
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await Promise.all([
    writeFile(bundlePath, Buffer.concat([
      Buffer.alloc(100_001, 0x61),
      Buffer.from('preview-sponsored-copper-coyote'),
    ])),
    writeFile(path.join(outputRoot, 'metadata.json'), JSON.stringify({
      bundler: 'metro',
      fileMetadata: { ios: { bundle: 'bundles/app.hbc', assets: [] } },
    })),
  ]);

  await assert.rejects(
    verifyArtifact(projectRoot, 'ios'),
    /production output contains synthetic fixture state/,
  );
});
