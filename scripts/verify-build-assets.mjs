import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_ROOTS = ['assets', 'public'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_RASTER_DIMENSION = 4096;
const ALLOWED_EXTENSIONS = new Set(['.js', '.png', '.ttf', '.webmanifest']);
const FORBIDDEN_IMAGE_EXTENSIONS = new Set(['.avif', '.heic', '.heif', '.icns', '.jxl']);

function pngDimensions(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function validateAssetBuffer(relativePath, buffer) {
  const errors = [];
  const normalized = relativePath.replaceAll('\\', '/');
  const extension = path.extname(normalized).toLowerCase();
  for (const segment of normalized.split('/')) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..') {
      errors.push(`${normalized}: asset path contains an unsafe segment.`);
      break;
    }
  }
  if (FORBIDDEN_IMAGE_EXTENSIONS.has(extension)) {
    errors.push(`${normalized}: parser-risk image format is forbidden.`);
  } else if (!ALLOWED_EXTENSIONS.has(extension)) {
    errors.push(`${normalized}: unsupported build asset extension ${extension || '(none)'}.`);
  }
  if (buffer.length === 0) errors.push(`${normalized}: asset is empty.`);
  if (buffer.length > MAX_FILE_BYTES) errors.push(`${normalized}: asset exceeds 5 MiB.`);

  if (extension === '.png') {
    const dimensions = pngDimensions(buffer);
    if (!dimensions) {
      errors.push(`${normalized}: PNG signature or IHDR is invalid.`);
    } else if (
      dimensions.width < 1 || dimensions.height < 1 ||
      dimensions.width > MAX_RASTER_DIMENSION || dimensions.height > MAX_RASTER_DIMENSION
    ) {
      errors.push(`${normalized}: PNG dimensions are outside 1-4096 pixels.`);
    }
  } else if (extension === '.ttf') {
    const signature = buffer.subarray(0, 4);
    const valid = signature.equals(Buffer.from([0, 1, 0, 0])) ||
      ['OTTO', 'true'].includes(signature.toString('ascii'));
    if (!valid) errors.push(`${normalized}: font signature is invalid.`);
  } else if (extension === '.webmanifest') {
    try {
      JSON.parse(buffer.toString('utf8'));
    } catch {
      errors.push(`${normalized}: web manifest is not valid JSON.`);
    }
  } else if (extension === '.js' && buffer.includes(0)) {
    errors.push(`${normalized}: JavaScript asset contains a NUL byte.`);
  }
  return errors;
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${path.relative(root, target)}: symlinked assets are forbidden.`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, target));
    else if (entry.isFile()) files.push(target);
    else throw new Error(`${path.relative(root, target)}: unsupported filesystem entry.`);
  }
  return files;
}

export async function verifyBuildAssets(projectRoot = PROJECT_ROOT) {
  const digest = createHash('sha256');
  const errors = [];
  let totalBytes = 0;
  let fileCount = 0;
  for (const rootName of ASSET_ROOTS) {
    const root = path.join(projectRoot, rootName);
    for (const file of await collectFiles(root)) {
      const relativePath = path.relative(projectRoot, file).replaceAll('\\', '/');
      const details = await stat(file);
      const buffer = await readFile(file);
      if (details.size !== buffer.length) errors.push(`${relativePath}: file changed while being verified.`);
      errors.push(...validateAssetBuffer(relativePath, buffer));
      totalBytes += buffer.length;
      fileCount += 1;
      digest.update(relativePath).update('\0').update(buffer).update('\0');
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) errors.push('Combined project build assets exceed 25 MiB.');
  if (errors.length) throw new Error(errors.join('\n'));
  return { fileCount, totalBytes, sha256: digest.digest('hex') };
}

async function main() {
  const result = await verifyBuildAssets();
  process.stdout.write(
    `Build assets verified (${result.fileCount} files, ${result.totalBytes} bytes, sha256 ${result.sha256}).\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
