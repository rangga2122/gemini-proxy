// Normalize image-to-image input while preserving the existing referenceImage contract.
export function normalizeReferenceImage(body = {}) {
  if (body.referenceImage?.base64 && body.referenceImage?.mimeType) {
    return {
      mimeType: body.referenceImage.mimeType,
      base64: body.referenceImage.base64,
    };
  }

  if (!body.image) return null;
  if (typeof body.image !== 'string') {
    throw new Error('image must be a base64 data URL');
  }

  const match = body.image.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error('image must be a base64 data URL');
  if (!match[1].startsWith('image/')) throw new Error('image must use an image MIME type');

  return { mimeType: match[1], base64: match[2].replace(/\s/g, '') };
}
