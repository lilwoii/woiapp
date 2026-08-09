import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { validateAssetBuffer } from './verify-build-assets.mjs';

function png(width = 1024, height = 1024) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('project PNG validation accepts bounded dimensions and a real signature', () => {
  assert.deepEqual(validateAssetBuffer('assets/images/icon.png', png()), []);
});

test('project asset validation rejects parser-risk formats before Metro', () => {
  const errors = validateAssetBuffer('assets/images/untrusted.heif', Buffer.from('payload'));
  assert.ok(errors.some((error) => error.includes('parser-risk')));
});

test('project asset validation rejects bad PNG headers and decompression-scale dimensions', () => {
  assert.ok(validateAssetBuffer('public/bad.png', Buffer.from('not a png')).length > 0);
  assert.ok(validateAssetBuffer('public/huge.png', png(50_000, 50_000)).length > 0);
});

test('project asset validation rejects unsafe paths and malformed manifests', () => {
  assert.ok(validateAssetBuffer('assets/../escape.png', png()).length > 0);
  assert.ok(validateAssetBuffer('public/manifest.webmanifest', Buffer.from('{')).length > 0);
});
