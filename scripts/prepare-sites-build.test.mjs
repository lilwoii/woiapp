import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareSitesBuild } from './prepare-sites-build.mjs';

async function createFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'spottr-sites-package-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist', '_expo'), { recursive: true });
  await mkdir(path.join(root, 'hosting'), { recursive: true });
  await mkdir(path.join(root, '.openai'), { recursive: true });
  await mkdir(path.join(root, 'assets', 'images'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'index.html'), '<main>Spottr</main>');
  await writeFile(path.join(root, 'dist', '_expo', 'entry.js'), 'export {};');
  await writeFile(path.join(root, 'hosting', 'worker.js'), 'export default {};');
  await writeFile(
    path.join(root, 'hosting', 'wrangler.json'),
    '{"main":"index.js","assets":{"directory":"../client","binding":"ASSETS","run_worker_first":true}}',
  );
  await writeFile(path.join(root, 'hosting', 'assetsignore'), '.env\n');
  await writeFile(
    path.join(root, 'hosting', 'headers'),
    "/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'self'\n",
  );
  await writeFile(path.join(root, '.openai', 'hosting.json'), '{"project_id":"test"}');
  await writeFile(path.join(root, 'assets', 'images', 'spottr-icon.png'), 'icon');
  await writeFile(path.join(root, 'assets', 'images', 'spottr-icon-maskable.png'), 'mask');
  return root;
}

test('Sites packaging emits the standard client, server, and metadata layout', async (context) => {
  const root = await createFixture(context);
  await prepareSitesBuild(root);

  assert.equal(await readFile(path.join(root, 'dist', 'client', 'index.html'), 'utf8'), '<main>Spottr</main>');
  assert.equal(await readFile(path.join(root, 'dist', 'server', 'index.js'), 'utf8'), 'export default {};');
  const workerConfig = JSON.parse(
    await readFile(path.join(root, 'dist', 'server', 'wrangler.json'), 'utf8'),
  );
  assert.deepEqual(workerConfig.assets, {
    directory: '../client',
    binding: 'ASSETS',
    run_worker_first: true,
  });
  assert.equal(
    await readFile(path.join(root, 'dist', '.openai', 'hosting.json'), 'utf8'),
    '{"project_id":"test"}',
  );
  await access(path.join(root, 'dist', 'client', 'spottr-icon.png'));
  await access(path.join(root, 'dist', 'client', 'spottr-icon-maskable.png'));
  assert.equal(await readFile(path.join(root, 'dist', 'client', '.assetsignore'), 'utf8'), '.env\n');
  assert.match(
    await readFile(path.join(root, 'dist', 'client', '_headers'), 'utf8'),
    /X-Frame-Options: DENY/u,
  );
  assert.match(
    await readFile(path.join(root, 'dist', '_headers'), 'utf8'),
    /Content-Security-Policy: default-src 'self'/u,
  );
  await assert.rejects(access(path.join(root, 'dist', 'index.html')));
});

test('Sites packaging fails closed instead of mixing stale reserved output', async (context) => {
  const root = await createFixture(context);
  await mkdir(path.join(root, 'dist', 'server'));

  await assert.rejects(
    prepareSitesBuild(root),
    /reserved output already exists: server/u,
  );
});
