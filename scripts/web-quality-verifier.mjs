import { gzipSync } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ROUTE_BYTES = 64 * 1024;
const MAX_ALL_ROUTES_BYTES = 1_700_000;
const MAX_ENTRY_BYTES = 3_200_000;
const MAX_ENTRY_GZIP_BYTES = 800_000;
const MAX_MAP_BYTES = 1_100_000;
const MAX_MAP_GZIP_BYTES = 320_000;
const MAX_ALL_JS_BYTES = 4_300_000;
const MAX_ALL_JS_GZIP_BYTES = 1_100_000;
const MAX_ALL_CSS_BYTES = 100_000;

const REQUIRED_ROUTES = [
  'index.html',
  'auth.html',
  'saved.html',
  'studio.html',
  'profile.html',
  'place/[id].html',
  'navigation/[id].html',
  'messages/index.html',
  'messages/[id].html',
  'business-onboarding.html',
  'business-setup.html',
  'business-profile.html',
  'business-team.html',
  'business-marketplace.html',
  'privacy.html',
  'safety.html',
  'legal.html',
  'security.html',
  'account-data.html',
];

export function validateRouteHtml(relativePath, html) {
  if (relativePath.endsWith('_sitemap.html')) return [];
  const errors = [];
  if (!/<html\s+[^>]*lang="en"/i.test(html)) errors.push(`${relativePath}: missing English document language.`);
  if (!/<meta\s+name="viewport"/i.test(html)) errors.push(`${relativePath}: missing viewport metadata.`);
  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i.test(html)) {
    errors.push(`${relativePath}: viewport must not disable zoom.`);
  }
  if (!/<meta\s+name="description"/i.test(html)) errors.push(`${relativePath}: missing description metadata.`);
  if (!/<main\s+role="main"/i.test(html)) errors.push(`${relativePath}: missing main landmark.`);
  if (!/<h1(?:\s|>)/i.test(html)) errors.push(`${relativePath}: missing route-level H1.`);
  const semanticlessFocusableDivs = html.match(/<div(?=[^>]*tabindex="0")(?![^>]*\srole=)[^>]*>/gi) ?? [];
  if (semanticlessFocusableDivs.length) {
    errors.push(`${relativePath}: ${semanticlessFocusableDivs.length} focusable div(s) lack a semantic role.`);
  }
  if (!html.includes('@media (prefers-reduced-motion: reduce)')) {
    errors.push(`${relativePath}: missing reduced-motion CSS.`);
  }
  return errors;
}

export function validateBundleBudgets(metrics) {
  const errors = [];
  const checks = [
    ['entry JavaScript', metrics.entryBytes, MAX_ENTRY_BYTES],
    ['entry JavaScript gzip', metrics.entryGzipBytes, MAX_ENTRY_GZIP_BYTES],
    ['map JavaScript', metrics.mapBytes, MAX_MAP_BYTES],
    ['map JavaScript gzip', metrics.mapGzipBytes, MAX_MAP_GZIP_BYTES],
    ['all JavaScript', metrics.allJsBytes, MAX_ALL_JS_BYTES],
    ['all JavaScript gzip', metrics.allJsGzipBytes, MAX_ALL_JS_GZIP_BYTES],
    ['all CSS', metrics.allCssBytes, MAX_ALL_CSS_BYTES],
    ['largest route HTML', metrics.largestRouteBytes, MAX_ROUTE_BYTES],
    ['all route HTML', metrics.allRouteBytes, MAX_ALL_ROUTES_BYTES],
  ];
  for (const [label, actual, maximum] of checks) {
    if (!Number.isFinite(actual) || actual > maximum) {
      errors.push(`${label} exceeds budget (${actual} > ${maximum} bytes).`);
    }
  }
  return errors;
}

async function collectFiles(root, extension) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(target, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(target);
  }
  return files;
}

export async function verifyWebQuality(projectRoot = PROJECT_ROOT) {
  const dist = path.join(projectRoot, 'dist');
  const errors = [];
  for (const route of REQUIRED_ROUTES) {
    try {
      if (!(await stat(path.join(dist, ...route.split('/')))).isFile()) throw new Error('not a file');
    } catch {
      errors.push(`Missing required static route: ${route}.`);
    }
  }

  const htmlFiles = await collectFiles(dist, '.html');
  let allRouteBytes = 0;
  let largestRouteBytes = 0;
  for (const file of htmlFiles) {
    const buffer = await readFile(file);
    const relative = path.relative(dist, file).replaceAll('\\', '/');
    allRouteBytes += buffer.length;
    largestRouteBytes = Math.max(largestRouteBytes, buffer.length);
    errors.push(...validateRouteHtml(relative, buffer.toString('utf8')));
  }

  const jsRoot = path.join(dist, '_expo', 'static', 'js', 'web');
  const jsFiles = await collectFiles(jsRoot, '.js');
  const cssFiles = await collectFiles(path.join(dist, '_expo', 'static', 'css'), '.css');
  const sourceMapFiles = await collectFiles(dist, '.map');
  if (sourceMapFiles.length) errors.push('Production web output must not include source maps.');
  const entryFile = jsFiles.find((file) => path.basename(file).startsWith('entry-'));
  const mapFile = jsFiles.find((file) => path.basename(file).startsWith('maplibre-map-'));
  if (!entryFile) errors.push('Web entry bundle is missing.');
  if (!mapFile) errors.push('Lazy MapLibre bundle is missing.');

  let allJsBytes = 0;
  let allJsGzipBytes = 0;
  let entryBytes = 0;
  let entryGzipBytes = 0;
  let mapBytes = 0;
  let mapGzipBytes = 0;
  for (const file of jsFiles) {
    const buffer = await readFile(file);
    const compressed = gzipSync(buffer, { level: 9 }).length;
    allJsBytes += buffer.length;
    allJsGzipBytes += compressed;
    if (file === entryFile) {
      entryBytes = buffer.length;
      entryGzipBytes = compressed;
    }
    if (file === mapFile) {
      mapBytes = buffer.length;
      mapGzipBytes = compressed;
    }
  }
  let allCssBytes = 0;
  for (const file of cssFiles) allCssBytes += (await stat(file)).size;

  const metrics = {
    routeCount: htmlFiles.length,
    allRouteBytes,
    largestRouteBytes,
    entryBytes,
    entryGzipBytes,
    mapBytes,
    mapGzipBytes,
    allJsBytes,
    allJsGzipBytes,
    allCssBytes,
  };
  errors.push(...validateBundleBudgets(metrics));
  if (errors.length) throw new Error(errors.join('\n'));
  return metrics;
}

async function main() {
  const metrics = await verifyWebQuality();
  process.stdout.write(
    `Web quality verified (${metrics.routeCount} routes; JS ${metrics.allJsBytes}/${metrics.allJsGzipBytes} gzip bytes; CSS ${metrics.allCssBytes} bytes).\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
