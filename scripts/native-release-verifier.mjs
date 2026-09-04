import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateProductionArtifactContent } from './production-artifact-purity.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const REQUIRED_BLOCKED_ANDROID_PERMISSIONS = new Set([
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
]);

const ALLOWED_ANDROID_PERMISSIONS = new Set([
  'ACCESS_COARSE_LOCATION',
  'ACCESS_FINE_LOCATION',
]);

const HIGH_RISK_FEATURE_FLAGS = [
  'EXPO_PUBLIC_HOME_KITCHENS_ENABLED',
  'EXPO_PUBLIC_MEDIA_UPLOADS_ENABLED',
  'EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED',
  'EXPO_PUBLIC_PICKUP_ORDERING_ENABLED',
  'EXPO_PUBLIC_INTERNAL_SHADOW_ORDERING_ENABLED',
  'EXPO_PUBLIC_IN_APP_NAVIGATION_ENABLED',
  'EXPO_PUBLIC_BUSINESS_CLAIMS_ENABLED',
  'EXPO_PUBLIC_SPONSORED_PLACEMENTS_ENABLED',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function walkFiles(directory) {
  const output = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return output;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

export function parsePrivacyAccessRequirements(xml) {
  const requirements = new Map();
  const entryPattern = /<dict>\s*<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>\s*<\/dict>/g;
  for (const match of xml.matchAll(entryPattern)) {
    const category = match[1].trim();
    const reasons = [...match[2].matchAll(/<string>([^<]+)<\/string>/g)]
      .map((reason) => reason[1].trim())
      .filter(Boolean);
    const existing = requirements.get(category) ?? new Set();
    for (const reason of reasons) existing.add(reason);
    requirements.set(category, existing);
  }
  return requirements;
}

function mergeRequirements(target, incoming) {
  for (const [category, reasons] of incoming) {
    const existing = target.get(category) ?? new Set();
    for (const reason of reasons) existing.add(reason);
    target.set(category, existing);
  }
}

export async function collectDirectDependencyPrivacyRequirements(
  projectRoot = PROJECT_ROOT,
) {
  const packageJson = await readJson(path.join(projectRoot, 'package.json'));
  const requirements = new Map();
  const manifests = [];
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    const dependencyRoot = path.join(projectRoot, 'node_modules', ...dependency.split('/'));
    const files = await walkFiles(dependencyRoot);
    for (const file of files) {
      if (path.basename(file) !== 'PrivacyInfo.xcprivacy') continue;
      const xml = await readFile(file, 'utf8');
      mergeRequirements(requirements, parsePrivacyAccessRequirements(xml));
      manifests.push(path.relative(projectRoot, file).replaceAll('\\', '/'));
    }
  }
  return { manifests, requirements };
}

function findPlugin(plugins, name) {
  return plugins.find((entry) => entry === name || (Array.isArray(entry) && entry[0] === name));
}

function configuredPrivacyRequirements(privacyManifests) {
  const requirements = new Map();
  for (const entry of privacyManifests?.NSPrivacyAccessedAPITypes ?? []) {
    if (!isRecord(entry) || typeof entry.NSPrivacyAccessedAPIType !== 'string') continue;
    requirements.set(
      entry.NSPrivacyAccessedAPIType,
      new Set(Array.isArray(entry.NSPrivacyAccessedAPITypeReasons)
        ? entry.NSPrivacyAccessedAPITypeReasons.filter((reason) => typeof reason === 'string')
        : []),
    );
  }
  return requirements;
}

function validateUsageDescription(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length < 40) {
    errors.push(`${label} must be a specific user-facing explanation of at least 40 characters.`);
  }
}

export function validateNativeConfiguration(appBase, eas, sdkRequirements) {
  const errors = [];
  const expo = appBase?.expo;
  if (!isRecord(expo)) return ['app.base.json must contain an expo object.'];

  if (expo.name !== 'Spottr') errors.push('The native display name must be Spottr.');
  if (!/^[a-z][a-z0-9-]{4,}$/.test(expo.slug ?? '')) errors.push('Expo slug is invalid.');
  if (!/^[a-z][a-z0-9+.-]*$/.test(expo.scheme ?? '')) errors.push('Deep-link scheme is invalid.');
  if (!/^\d+\.\d+\.\d+$/.test(expo.version ?? '')) errors.push('App version must be numeric semver.');
  if (expo.runtimeVersion?.policy !== 'appVersion') {
    errors.push('runtimeVersion.policy must be appVersion for deterministic native compatibility.');
  }

  const ios = expo.ios ?? {};
  const android = expo.android ?? {};
  const identifierPattern = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/;
  if (!identifierPattern.test(ios.bundleIdentifier ?? '')) errors.push('iOS bundle identifier is invalid.');
  if (!identifierPattern.test(android.package ?? '')) errors.push('Android package identifier is invalid.');
  if (ios.bundleIdentifier !== android.package) {
    errors.push('iOS and Android identifiers must remain aligned unless the release runbook records an exception.');
  }
  if (!/^\d+$/.test(ios.buildNumber ?? '') || Number(ios.buildNumber) < 1) {
    errors.push('iOS buildNumber must be a positive integer string.');
  }
  if (!Number.isInteger(android.versionCode) || android.versionCode < 1) {
    errors.push('Android versionCode must be a positive integer.');
  }

  validateUsageDescription(
    ios.infoPlist?.NSLocationWhenInUseUsageDescription,
    'NSLocationWhenInUseUsageDescription',
    errors,
  );
  const photoUsageDescription = ios.infoPlist?.NSPhotoLibraryUsageDescription;
  validateUsageDescription(
    photoUsageDescription,
    'NSPhotoLibraryUsageDescription',
    errors,
  );
  if (ios.infoPlist?.ITSAppUsesNonExemptEncryption !== false) {
    errors.push('ITSAppUsesNonExemptEncryption must remain explicitly false unless export counsel changes it.');
  }

  const permissions = new Set(android.permissions ?? []);
  for (const permission of permissions) {
    if (!ALLOWED_ANDROID_PERMISSIONS.has(permission)) {
      errors.push(`Unexpected Android permission: ${permission}`);
    }
  }
  for (const permission of ALLOWED_ANDROID_PERMISSIONS) {
    if (!permissions.has(permission)) errors.push(`Missing Android permission: ${permission}`);
  }
  const blockedPermissions = new Set(android.blockedPermissions ?? []);
  for (const permission of REQUIRED_BLOCKED_ANDROID_PERMISSIONS) {
    if (!blockedPermissions.has(permission)) errors.push(`Android must explicitly block ${permission}.`);
  }

  const locationPlugin = findPlugin(expo.plugins ?? [], 'expo-location');
  const locationOptions = Array.isArray(locationPlugin) ? locationPlugin[1] : null;
  for (const option of [
    'locationAlwaysPermission',
    'locationAlwaysAndWhenInUsePermission',
    'isIosBackgroundLocationEnabled',
    'isAndroidBackgroundLocationEnabled',
    'isAndroidForegroundServiceEnabled',
  ]) {
    if (locationOptions?.[option] !== false) errors.push(`expo-location ${option} must remain false.`);
  }
  const pickerPlugin = findPlugin(expo.plugins ?? [], 'expo-image-picker');
  const pickerOptions = Array.isArray(pickerPlugin) ? pickerPlugin[1] : null;
  if (pickerOptions?.photosPermission !== photoUsageDescription) {
    errors.push('iOS photo-library and image-picker permission descriptions must remain identical.');
  }
  for (const purpose of ['profile', 'banner', 'business', 'review']) {
    if (!photoUsageDescription?.toLocaleLowerCase('en-US').includes(purpose)) {
      errors.push(`Photo permission description must disclose the ${purpose} image purpose.`);
    }
  }
  if (pickerOptions?.cameraPermission !== false || pickerOptions?.microphonePermission !== false) {
    errors.push('Image picker camera and microphone permissions must remain disabled.');
  }
  if (!findPlugin(expo.plugins ?? [], 'expo-notifications')) {
    errors.push('expo-notifications must remain explicitly configured for native device registration.');
  }
  if ((ios.infoPlist?.UIBackgroundModes ?? []).includes('remote-notification')) {
    errors.push('Background remote notifications must remain disabled until separately reviewed.');
  }

  const privacyManifests = ios.privacyManifests;
  if (privacyManifests?.NSPrivacyTracking !== false) {
    errors.push('The app-level iOS privacy manifest must explicitly disable tracking.');
  }
  const configured = configuredPrivacyRequirements(privacyManifests);
  for (const [category, reasons] of sdkRequirements) {
    const configuredReasons = configured.get(category) ?? new Set();
    for (const reason of reasons) {
      if (!configuredReasons.has(reason)) {
        errors.push(`iOS privacy manifest is missing ${category} reason ${reason}.`);
      }
    }
  }

  if (eas?.cli?.appVersionSource !== 'remote') errors.push('EAS appVersionSource must be remote.');
  const production = eas?.build?.production;
  if (production?.autoIncrement !== true) errors.push('Production EAS builds must auto-increment.');
  if (production?.channel !== 'production') errors.push('Production EAS channel must be production.');
  if (production?.environment !== 'production') errors.push('Production EAS environment must be production.');
  if (production?.env?.EXPO_PUBLIC_APP_ENV !== 'production') {
    errors.push('Production EAS builds must set EXPO_PUBLIC_APP_ENV=production.');
  }
  for (const name of HIGH_RISK_FEATURE_FLAGS) {
    if (production?.env?.[name] !== 'false') {
      errors.push(`Production EAS builds must explicitly set ${name}=false.`);
    }
  }
  if (!isRecord(eas?.submit?.production)) errors.push('A production EAS submit profile is required.');

  return errors;
}

function safeArtifactPath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return null;
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  const resolved = path.resolve(root, normalized);
  const prefix = `${path.resolve(root)}${path.sep}`;
  return resolved.startsWith(prefix) ? resolved : null;
}

export function validateArtifactMetadata(metadata, platform) {
  const errors = [];
  if (metadata?.bundler !== 'metro') errors.push(`${platform} export must use Metro.`);
  const platformMetadata = metadata?.fileMetadata?.[platform];
  if (!isRecord(platformMetadata)) return [...errors, `${platform} metadata is missing.`];
  if (!safeArtifactPath('/artifact-root', platformMetadata.bundle)) {
    errors.push(`${platform} bundle path is unsafe.`);
  }
  if (!/\.hbc$/.test(platformMetadata.bundle ?? '')) {
    errors.push(`${platform} production bundle must be Hermes bytecode (.hbc).`);
  }
  if (!Array.isArray(platformMetadata.assets) || platformMetadata.assets.length === 0) {
    errors.push(`${platform} export contains no assets.`);
  }
  for (const asset of platformMetadata.assets ?? []) {
    if (!safeArtifactPath('/artifact-root', asset?.path)) {
      errors.push(`${platform} contains an unsafe asset path.`);
    }
  }
  return errors;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function verifyArtifact(projectRoot, platform) {
  const outputRoot = path.join(projectRoot, `dist-${platform}`);
  const metadataPath = path.join(outputRoot, 'metadata.json');
  const metadata = await readJson(metadataPath);
  const errors = validateArtifactMetadata(metadata, platform);
  const platformMetadata = metadata?.fileMetadata?.[platform];
  const paths = [platformMetadata?.bundle, ...(platformMetadata?.assets ?? []).map((asset) => asset.path)];
  for (const relativePath of paths) {
    const filePath = safeArtifactPath(outputRoot, relativePath);
    if (!filePath) continue;
    try {
      const details = await stat(filePath);
      if (!details.isFile() || details.size === 0) errors.push(`${platform} artifact is empty: ${relativePath}`);
    } catch {
      errors.push(`${platform} artifact is missing: ${relativePath}`);
    }
  }
  for (const artifactFile of await walkFiles(outputRoot)) {
    const relativePath = path.relative(outputRoot, artifactFile).replaceAll('\\', '/');
    try {
      errors.push(...validateProductionArtifactContent(
        `${platform} production artifact ${relativePath}`,
        await readFile(artifactFile),
      ));
    } catch {
      errors.push(`${platform} artifact could not be inspected: ${relativePath}`);
    }
  }
  const bundlePath = safeArtifactPath(outputRoot, platformMetadata?.bundle);
  if (bundlePath) {
    try {
      const bundle = await readFile(bundlePath);
      if (bundle.length < 100_000) errors.push(`${platform} bundle is unexpectedly small.`);
    } catch {
      // Missing file already reported above.
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    platform,
    bundle: platformMetadata.bundle.replaceAll('\\', '/'),
    bundleSha256: await sha256(bundlePath),
    metadataSha256: await sha256(metadataPath),
    assetCount: platformMetadata.assets.length,
  };
}

export async function verifyNativeConfiguration(projectRoot = PROJECT_ROOT) {
  const [appBase, eas, dependencyPrivacy] = await Promise.all([
    readJson(path.join(projectRoot, 'app.base.json')),
    readJson(path.join(projectRoot, 'eas.json')),
    collectDirectDependencyPrivacyRequirements(projectRoot),
  ]);
  if (dependencyPrivacy.manifests.length === 0) {
    throw new Error('No direct-dependency iOS privacy manifests were found; locked dependencies may be incomplete.');
  }
  const errors = validateNativeConfiguration(appBase, eas, dependencyPrivacy.requirements);
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    dependencyManifestCount: dependencyPrivacy.manifests.length,
    requiredApiCategoryCount: dependencyPrivacy.requirements.size,
  };
}

async function main() {
  const mode = process.argv[2] ?? '--config';
  if (!['--config', '--artifacts', '--all'].includes(mode)) {
    throw new Error('Usage: node scripts/native-release-verifier.mjs [--config|--artifacts|--all]');
  }
  if (mode === '--config' || mode === '--all') {
    const result = await verifyNativeConfiguration(PROJECT_ROOT);
    process.stdout.write(
      `Native config verified (${result.dependencyManifestCount} SDK manifests, ${result.requiredApiCategoryCount} required API categories).\n`,
    );
  }
  if (mode === '--artifacts' || mode === '--all') {
    const results = await Promise.all([
      verifyArtifact(PROJECT_ROOT, 'ios'),
      verifyArtifact(PROJECT_ROOT, 'android'),
    ]);
    for (const result of results) {
      process.stdout.write(
        `${result.platform}: ${result.assetCount} assets, bundle sha256 ${result.bundleSha256}, metadata sha256 ${result.metadataSha256}\n`,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
