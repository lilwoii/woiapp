import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDir = resolve(projectRoot, 'dist', 'server');
const webOutputDir = resolve(projectRoot, 'dist');

await mkdir(outputDir, { recursive: true });
await copyFile(resolve(projectRoot, 'hosting', 'worker.js'), resolve(outputDir, 'index.js'));
await copyFile(
  resolve(projectRoot, 'assets', 'images', 'spottr-icon.png'),
  resolve(webOutputDir, 'spottr-icon.png')
);
await copyFile(
  resolve(projectRoot, 'assets', 'images', 'spottr-icon-maskable.png'),
  resolve(webOutputDir, 'spottr-icon-maskable.png')
);
