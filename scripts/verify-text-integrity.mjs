import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['app', 'components', 'context', 'docs', 'lib', 'scripts', 'supabase'];
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.sql', '.ts', '.tsx', '.toml', '.yml', '.yaml']);
const FORBIDDEN_TEXT = [
  { pattern: /\uFFFD/u, reason: 'Unicode replacement character' },
  { pattern: /[\u0080-\u009F]/u, reason: 'C1 control character' },
  { pattern: /(?:\u00C3[\u0080-\u00BF]|\u00C2[\u0080-\u00BF]|\u00E2(?:\u0080|\u0082|\u20AC|\u201A))/u, reason: 'likely UTF-8 mojibake' },
];

export function validateText(relativePath, text) {
  const errors = [];
  if (text.includes('\0')) errors.push(`${relativePath}: contains a NUL character.`);
  for (const { pattern, reason } of FORBIDDEN_TEXT) {
    if (pattern.test(text)) errors.push(`${relativePath}: contains ${reason}.`);
  }
  return errors;
}

async function collectTextFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${target}: symlinked source entries are forbidden.`);
    if (entry.isDirectory()) files.push(...await collectTextFiles(root, target));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(target);
  }
  return files;
}

export async function verifyTextIntegrity(projectRoot = PROJECT_ROOT) {
  const errors = [];
  let fileCount = 0;
  for (const rootName of SOURCE_ROOTS) {
    const root = path.join(projectRoot, rootName);
    for (const file of await collectTextFiles(root)) {
      const relativePath = path.relative(projectRoot, file).replaceAll('\\', '/');
      errors.push(...validateText(relativePath, await readFile(file, 'utf8')));
      fileCount += 1;
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { fileCount };
}

async function main() {
  const result = await verifyTextIntegrity();
  process.stdout.write(`Text integrity verified (${result.fileCount} files).\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
