import assert from 'node:assert/strict';
import { normalizeImageInput, ImageInputError } from './lib/images.js';

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

assert.deepEqual(
  normalizeImageInput(`data:image/png;base64,${tinyPng}`),
  { mimeType: 'image/png', base64: tinyPng },
  'data URL should normalize',
);

assert.deepEqual(
  normalizeImageInput({ mimeType: 'image/jpeg', base64: '/9j/4AAQ' }),
  { mimeType: 'image/jpeg', base64: '/9j/4AAQ' },
  'object input should remain compatible',
);

assert.equal(normalizeImageInput(null), null, 'empty image should remain optional');
assert.throws(
  () => normalizeImageInput('https://example.com/a.png'),
  error => error instanceof ImageInputError && /data URL/i.test(error.message),
);
assert.throws(() => normalizeImageInput('data:image/svg+xml;base64,PHN2Zz4='), /JPEG, PNG, atau WebP/i);
assert.throws(() => normalizeImageInput({ mimeType: 'image/png', base64: 'not base64!' }), /base64/i);

const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
assert.throws(() => normalizeImageInput({ mimeType: 'image/png', base64: oversized }), /10 MB/i);

console.log('7 image normalization tests passed');
