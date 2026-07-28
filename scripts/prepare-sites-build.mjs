import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDir = resolve(projectRoot, 'dist', 'server');

await mkdir(outputDir, { recursive: true });
await copyFile(resolve(projectRoot, 'hosting', 'worker.js'), resolve(outputDir, 'index.js'));

