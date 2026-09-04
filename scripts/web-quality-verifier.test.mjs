import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  validateBundleBudgets,
  validateRouteHtml,
  validateProductionArtifactTree,
  validateStaticHeaderPolicy,
} from './web-quality-verifier.mjs';
import { validateProductionArtifactContent } from './production-artifact-purity.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const VALID_HTML = `<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Spottr route">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; object-src 'none'">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <style>@media (prefers-reduced-motion: reduce) { * { transition: none; } }</style>
  </head><body><main role="main"><h1>Spottr</h1><button>Open</button></main></body></html>`;

test('route verifier accepts a zoomable semantic document', () => {
  assert.deepEqual(validateRouteHtml('index.html', VALID_HTML), []);
});

test('route verifier accepts React-encoded CSP directive quotes', () => {
  const encoded = VALID_HTML.replace(
    "object-src 'none'",
    'object-src &#x27;none&#x27;',
  );
  assert.deepEqual(validateRouteHtml('index.html', encoded), []);
});

test('route verifier rejects zoom locks and focusable role-less divs', () => {
  const invalid = VALID_HTML
    .replace('initial-scale=1', 'initial-scale=1, maximum-scale=1, user-scalable=no')
    .replace('<button>Open</button>', '<div tabindex="0">Open</div>');
  const errors = validateRouteHtml('index.html', invalid);
  assert.ok(errors.some((error) => error.includes('disable zoom')));
  assert.ok(errors.some((error) => error.includes('semantic role')));
});

test('route verifier requires main and H1 landmarks', () => {
  const invalid = VALID_HTML.replace('<main role="main"><h1>', '<div><h2>').replace('</h1>', '</h2>');
  const errors = validateRouteHtml('profile.html', invalid);
  assert.ok(errors.some((error) => error.includes('main landmark')));
  assert.ok(errors.some((error) => error.includes('route-level H1')));
});

test('bundle budgets fail closed when a JavaScript regression crosses a ceiling', () => {
  const errors = validateBundleBudgets({
    routeCount: 30,
    entryBytes: 3_300_001,
    entryGzipBytes: 700_000,
    mapBytes: 900_000,
    mapGzipBytes: 250_000,
    allJsBytes: 4_100_000,
    allJsGzipBytes: 1_000_000,
    allCssBytes: 80_000,
    largestRouteBytes: 60_000,
    largestRouteGzipBytes: 14_000,
    allRouteBytes: 1_500_000,
    allRouteGzipBytes: 420_000,
  });
  assert.ok(errors.some((error) => error.includes('entry JavaScript exceeds')));
});

test('route HTML aggregate budget scales only with verified route count', () => {
  const metrics = {
    routeCount: 30,
    entryBytes: 3_000_000,
    entryGzipBytes: 700_000,
    mapBytes: 900_000,
    mapGzipBytes: 250_000,
    allJsBytes: 4_100_000,
    allJsGzipBytes: 1_000_000,
    allCssBytes: 80_000,
    largestRouteBytes: 60_000,
    largestRouteGzipBytes: 14_000,
    allRouteBytes: 1_866_001,
    allRouteGzipBytes: 440_000,
  };
  assert.ok(
    validateBundleBudgets(metrics).some((error) => error.includes('all route HTML exceeds')),
  );
  assert.ok(
    !validateBundleBudgets({ ...metrics, routeCount: 31 }).some((error) =>
      error.includes('all route HTML exceeds'),
    ),
  );
  assert.ok(
    validateBundleBudgets({ ...metrics, routeCount: 0 }).some((error) =>
      error.includes('route count'),
    ),
  );
});

test('static header policy verifier rejects missing browser protections', () => {
  const errors = validateStaticHeaderPolicy("/*\n  X-Content-Type-Options: nosniff\n");
  assert.ok(errors.some((error) => error.includes('Content-Security-Policy')));
  assert.ok(errors.some((error) => error.includes('X-Frame-Options')));
  assert.ok(errors.some((error) => error.includes('/_expo/static/*')));
});

test('repository static header policy contains every required protection', async () => {
  const policy = await readFile(path.join(PROJECT_ROOT, 'hosting', 'headers'), 'utf8');
  assert.deepEqual(validateStaticHeaderPolicy(policy), []);
});

test('production artifact verifier rejects isolated browser-fixture state', () => {
  for (const marker of [
    'https://spottr-fixture.supabase.co',
    'spottr-public-fixture-anon-key',
    'Fixture-password-123!',
    'owner@spottr.test',
    'customer@spottr.test',
    'spottr_fixture_role',
    'fixture-refresh-customer',
    'preview-sponsored-copper-coyote',
    'cc-review-1',
  ]) {
    const errors = validateProductionArtifactContent(
      '_expo/static/js/web/entry-release.js',
      Buffer.from(`release-prefix:${marker}:release-suffix`),
    );
    assert.equal(errors.length, 1, marker);
    assert.match(errors[0], /synthetic fixture state/u);
  }
});

test('production artifact verifier accepts ordinary release content', () => {
  assert.deepEqual(
    validateProductionArtifactContent('index.html', '<main>Live local food, mapped.</main>'),
    [],
  );
});

test('production artifact tree rejects fixture state outside HTML and JavaScript', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'spottr-web-purity-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const nestedAsset = path.join(root, 'assets', 'release-manifest.json');
  await mkdir(path.dirname(nestedAsset), { recursive: true });
  await writeFile(nestedAsset, '{"endpoint":"https://spottr-fixture.supabase.co"}');

  const errors = await validateProductionArtifactTree(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /production output contains synthetic fixture state/u);
});
