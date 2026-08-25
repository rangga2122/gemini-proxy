const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class ImageInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageInputError';
    this.statusCode = 400;
  }
}

/** Normalize a public image input into the internal { mimeType, base64 } shape. */
export function normalizeImageInput(input) {
  if (input == null || input === '') return null;

  let mimeType;
  let base64;

  if (typeof input === 'string') {
    const match = input.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new ImageInputError('image must be a base64 data URL or { mimeType, base64 } object');
    mimeType = match[1].toLowerCase();
    base64 = match[2].replace(/\s/g, '');
  } else if (typeof input === 'object') {
    mimeType = String(input.mimeType || '').toLowerCase();
    base64 = String(input.base64 || '').replace(/\s/g, '');
  } else {
    throw new ImageInputError('image must be a base64 data URL or { mimeType, base64 } object');
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ImageInputError('image must be JPEG, PNG, atau WebP');
  }
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ImageInputError('image contains invalid base64 data');
  }

  const bytes = Buffer.from(base64, 'base64').length;
  if (!bytes) throw new ImageInputError('image contains invalid base64 data');
  if (bytes > MAX_IMAGE_BYTES) throw new ImageInputError('image maximum size is 10 MB');

  return { mimeType, base64 };
}

export const IMAGE_LIMITS = {
  mimeTypes: [...ALLOWED_MIME_TYPES],
  maxBytes: MAX_IMAGE_BYTES,
};
