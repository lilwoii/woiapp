import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const modulesRoot = path.resolve(import.meta.dirname, '..', 'node_modules');
let patched = 0;

function visit(directory, depth = 0) {
  if (depth > 9 || !fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.cache') continue;
    const child = path.join(directory, entry.name);
    if (entry.name !== 'minimatch') {
      visit(child, depth + 1);
      continue;
    }

    const packagePath = path.join(child, 'package.json');
    const implementationPath = path.join(child, 'minimatch.js');
    if (!fs.existsSync(packagePath) || !fs.existsSync(implementationPath)) continue;
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!String(packageJson.version).startsWith('3.')) continue;

    const original = fs.readFileSync(implementationPath, 'utf8');
    const legacyImport = "var expand = require('brace-expansion')";
    const compatibleImport =
      "var braceExpansion = require('brace-expansion')\n" +
      'var expand = braceExpansion.expand || braceExpansion';
    if (original.includes(compatibleImport)) continue;
    if (!original.includes(legacyImport)) {
      throw new Error(`Unsupported minimatch 3 import shape at ${implementationPath}`);
    }
    fs.writeFileSync(
      implementationPath,
      original.replace(legacyImport, compatibleImport),
      'utf8'
    );
    patched += 1;
  }
}

visit(modulesRoot);

function verify(directory, depth = 0) {
  if (depth > 9 || !fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.cache') continue;
    const child = path.join(directory, entry.name);
    if (entry.name !== 'minimatch') {
      verify(child, depth + 1);
      continue;
    }
    const packagePath = path.join(child, 'package.json');
    if (!fs.existsSync(packagePath)) continue;
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!String(packageJson.version).startsWith('3.')) continue;
    const require = createRequire(packagePath);
    const matcher = require('./minimatch.js');
    if (typeof matcher !== 'function' || !matcher('spottr.js', '*.js')) {
      throw new Error(`minimatch compatibility verification failed at ${child}`);
    }
  }
}

verify(modulesRoot);
console.warn(
  `Verified patched brace-expansion 5 compatibility for ${patched} newly installed minimatch 3 file(s).`
);
