// parser.js — Parse response dari Gemini batchexecute RPC

/**
 * Parse text/image response dari Gemini batchexecute.
 * Response format: )]}'  lalu baris-baris JSON berlapis.
 *
 * @returns {{ image: null|{mimeType,base64,dataUrl}, text: null|string, raw: null|string }}
 */
export function parseGeminiResponse(text) {
  const result = { image: null, text: null, raw: null };

  try {
    let cleaned = text;
    if (cleaned.startsWith("')]}'")) {
      cleaned = cleaned.substring(4).trim();
    }

    const lines = cleaned.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('[')) continue;

      try {
        const data = JSON.parse(trimmed);
        if (!Array.isArray(data) || !data[0]) continue;

        const rpcData = data[0][2];
        if (typeof rpcData !== 'string') continue;

        let inner = JSON.parse(rpcData);
        if (Array.isArray(inner)) {
          inner = inner[0];
        }
        if (typeof inner === 'string') {
          inner = JSON.parse(inner);
        }

        if (inner && inner.candidates) {
          for (const candidate of inner.candidates) {
            if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                if (part.inlineData && part.inlineData.data) {
                  const mime = part.inlineData.mimeType || 'image/jpeg';
                  result.image = {
                    mimeType: mime,
                    base64: part.inlineData.data,
                    dataUrl: `data:${mime};base64,${part.inlineData.data}`,
                  };
                }
                if (part.text) {
                  result.text = part.text;
                }
              }
            }
          }
        }
      } catch {
        // skip non-JSON lines
      }
    }
  } catch (e) {
    result.raw = text.substring(0, 500);
  }

  return result;
}

/**
 * Parse audio data dari response Gemini TTS.
 * Audio datang sebagai inlineData dengan mimeType audio/L16;rate=24000
 *
 * @returns {{ data: string, mimeType: string, rate: number } | null}
 */
export function extractAudioFromResponse(text) {
  try {
    let cleaned = text;
    if (cleaned.startsWith("')]}'")) {
      cleaned = cleaned.substring(4).trim();
    }

    const lines = cleaned.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('[')) continue;

      try {
        const data = JSON.parse(trimmed);
        if (!Array.isArray(data) || !data[0]) continue;

        const rpcData = data[0][2];
        if (typeof rpcData !== 'string') continue;

        let inner = JSON.parse(rpcData);
        if (Array.isArray(inner)) inner = inner[0];
        if (typeof inner === 'string') inner = JSON.parse(inner);

        if (inner && inner.candidates) {
          for (const candidate of inner.candidates) {
            if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                if (part.inlineData && part.inlineData.data) {
                  const rateMatch = (part.inlineData.mimeType || '').match(/rate=(\d+)/);
                  return {
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                    rate: rateMatch ? Number(rateMatch[1]) : 24000,
                  };
                }
              }
            }
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Convert PCM base64 → WAV base64 (dengan header RIFF/WAVE yang benar).
 * Gemini TTS mengembalikan raw PCM 16-bit mono, kita bungkus jadi WAV.
 */
export function pcmToWavBase64(pcmBase64, rate = 24000) {
  const ch = 1;       // mono
  const bps = 16;      // 16-bit
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const dataSize = pcmBuffer.byteLength;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);           // PCM format
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * (bps / 8), 28);  // byte rate
  buf.writeUInt16LE(ch * (bps / 8), 32);         // block align
  buf.writeUInt16LE(bps, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buf, 44);

  return buf.toString('base64');
}
