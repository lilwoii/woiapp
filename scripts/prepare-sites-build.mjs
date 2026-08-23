import { copyFile, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareSitesBuild(projectRoot = resolve(import.meta.dirname, '..')) {
  const webOutputDir = resolve(projectRoot, 'dist');
  const clientOutputDir = resolve(webOutputDir, 'client');
  const serverOutputDir = resolve(webOutputDir, 'server');
  const hostingMetadataDir = resolve(webOutputDir, '.openai');
  const exportedEntries = await readdir(webOutputDir, { withFileTypes: true });
  const reservedEntries = exportedEntries.filter((entry) =>
    ['client', 'server', '.openai'].includes(entry.name)
  );

  if (reservedEntries.length) {
    throw new Error(
      `Refusing to package an ambiguous Sites export; reserved output already exists: ${reservedEntries
        .map((entry) => entry.name)
        .join(', ')}.`,
    );
  }

  await mkdir(clientOutputDir, { recursive: false });
  for (const entry of exportedEntries) {
    await rename(resolve(webOutputDir, entry.name), resolve(clientOutputDir, entry.name));
  }

  await mkdir(serverOutputDir, { recursive: false });
  await mkdir(hostingMetadataDir, { recursive: false });
  await copyFile(resolve(projectRoot, 'hosting', 'worker.js'), resolve(serverOutputDir, 'index.js'));
  await copyFile(
    resolve(projectRoot, 'hosting', 'wrangler.json'),
    resolve(serverOutputDir, 'wrangler.json'),
  );
  await copyFile(
    resolve(projectRoot, 'hosting', 'assetsignore'),
    resolve(clientOutputDir, '.assetsignore'),
  );
  await copyFile(
    resolve(projectRoot, '.openai', 'hosting.json'),
    resolve(hostingMetadataDir, 'hosting.json'),
  );
  await copyFile(
    resolve(projectRoot, 'assets', 'images', 'spottr-icon.png'),
    resolve(clientOutputDir, 'spottr-icon.png'),
  );
  await copyFile(
    resolve(projectRoot, 'assets', 'images', 'spottr-icon-maskable.png'),
    resolve(clientOutputDir, 'spottr-icon-maskable.png'),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  prepareSitesBuild().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
