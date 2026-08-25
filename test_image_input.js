import assert from 'node:assert/strict';
import { normalizeReferenceImage } from './lib/image-input.js';

const dataUrl = 'data:image/png;base64,aGVsbG8=';
assert.deepEqual(normalizeReferenceImage({ image: dataUrl }), {
  mimeType: 'image/png',
  base64: 'aGVsbG8=',
});

assert.deepEqual(normalizeReferenceImage({
  referenceImage: { mimeType: 'image/jpeg', base64: 'YWJj' },
}), { mimeType: 'image/jpeg', base64: 'YWJj' });

assert.equal(normalizeReferenceImage({}), null);
assert.throws(
  () => normalizeReferenceImage({ image: 'https://example.com/file.jpg' }),
  /image must be a base64 data URL/,
);
assert.throws(
  () => normalizeReferenceImage({ image: 'data:text/plain;base64,aGVsbG8=' }),
  /image must use an image MIME type/,
);

console.log('5 image input tests passed');
