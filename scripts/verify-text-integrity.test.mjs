import assert from 'node:assert/strict';
import test from 'node:test';

import { validateText } from './verify-text-integrity.mjs';

test('accepts valid Unicode punctuation', () => {
  assert.deepEqual(validateText('docs/example.md', '\u201cSpottr\u201d uses an en dash \u2013 and an em dash \u2014.'), []);
});

test('rejects common UTF-8 mojibake', () => {
  const brokenQuote = String.fromCodePoint(0x00e2, 0x20ac, 0x0153);
  const brokenDash = String.fromCodePoint(0x00c3, 0x00a2);
  assert.match(validateText('docs/example.md', `${brokenQuote}Deleted account`)[0], /mojibake/);
  assert.match(validateText('docs/example.md', `16${brokenDash}128`)[0], /mojibake/);
});

test('rejects replacement, control, and NUL characters', () => {
  assert.match(validateText('lib/example.ts', `bad ${String.fromCodePoint(0xfffd)} text`)[0], /replacement/);
  assert.match(validateText('lib/example.ts', `bad ${String.fromCodePoint(0x81)} text`)[0], /control/);
  assert.match(validateText('lib/example.ts', 'bad\0text')[0], /NUL/);
});
