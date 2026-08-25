// gemini.js — Core engine: kirim request ke Gemini web batchexecute
import { parseGeminiResponse, extractAudioFromResponse, pcmToWavBase64 } from './parser.js';
import { getConfig, hasTokens } from './tokens.js';

const GEMINI_BASE = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';

// Model ID internal Gemini
const MODEL_3_FLASH = 'fbb127bbb056c959';
const MODEL_TTS = 'gemini-2.5-flash-preview-tts';

// Voice tersedia untuk TTS
export const TTS_VOICES = [
  { name: 'Leda',         label: 'Mentari [P] — muda & segar' },
  { name: 'Aoede',        label: 'Melati [P] — ringan & santai' },
  { name: 'Callirrhoe',   label: 'Sari [P] — ramah & luwes' },
  { name: 'Algieba',      label: 'Laras [P] — halus & lembut' },
  { name: 'Sadachbia',    label: 'Intan [P] — hidup & ceria' },
  { name: 'Zephyr',       label: 'Bintang [L] — cerah & jelas' },
  { name: 'Puck',         label: 'Fajar [L] — ceria & semangat' },
  { name: 'Charon',       label: 'Satria [L] — formal & berwibawa' },
  { name: 'Orus',         label: 'Baskara [L] — tegas & dewasa' },
  { name: 'Umbriel',      label: 'Dimas [L] — ramah & santai' },
];

/**
 * Generate single image dari prompt.
 *
 * @param {object} opts
 * @param {string} opts.prompt    — deskripsi gambar
 * @param {string} opts.ratio     — rasio aspek ('1:1', '16:9', '9:16', dll)
 * @param {number} opts.seed      — seed random untuk variasi
 * @param {{base64,mimeType}} opts.referenceImage — gambar referensi opsional
 * @param {Array<{base64,mimeType}>} opts.extraImages — gambar tambahan opsional
 * @returns {Promise<{seed, image, text, status}>}
 */
export async function generateImage(opts) {
  const cfg = getConfig();
  const {
    prompt,
    ratio = '1:1',
    seed = Math.floor(Math.random() * 999999),
    referenceImage = null,
    extraImages = [],
    reqId = Math.floor(Math.random() * 9999999),
  } = opts;

  const promptFull = `${prompt}\n\nInstruksi Wajib: Buatkan gambar dengan rasio aspek persis ${ratio}. \n\n[Variasi Seed: ${seed}]`;

  const parts = [{ text: promptFull }];
  if (referenceImage?.base64 && referenceImage?.mimeType) {
    parts.push({ inlineData: { mimeType: referenceImage.mimeType, data: referenceImage.base64 } });
  }
  for (const img of extraImages) {
    if (img?.base64 && img?.mimeType) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
  }

  const innerJson = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const fReq = JSON.stringify([
    [['q4uTj', JSON.stringify([null, innerJson, 4, cfg.shareId]), null, 'generic']],
  ]);

  const params = new URLSearchParams({
    rpcids: 'q4uTj',
    'source-path': `/share/${cfg.shareId}`,
    bl: cfg.bl,
    'f.sid': cfg.fSid,
    hl: cfg.hl,
    _reqid: String(reqId),
    rt: 'c',
  });

  const body = new URLSearchParams({ 'f.req': fReq, at: cfg.at });
  const headers = buildHeaders(cfg);

  const url = `${GEMINI_BASE}?${params.toString()}`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GEMINI_IMAGE_TIMEOUT_MS || 45000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Gemini image request timeout after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const parsed = parseGeminiResponse(text);

  return {
    seed,
    image: parsed.image,
    text: parsed.text,
    status: response.status,
  };
}

/**
 * Generate multiple images secara paralel (beda seed).
 *
 * @param {object} opts — sama seperti generateImage + count
 * @returns {Promise<Array>}
 */
export async function generateImagesParallel(opts) {
  const { count = 4, ...rest } = opts;
  const baseReqId = Math.floor(Math.random() * 9999999);

  const promises = Array.from({ length: count }, (_, i) => {
    const seed = Math.floor(Math.random() * 999999);
    const reqId = baseReqId + i * 100000;
    return generateImage({ ...rest, seed, reqId }).then(
      (result) => ({ slot: i + 1, ...result }),
      (error) => ({ slot: i + 1, error: error.message }),
    );
  });

  return Promise.all(promises);
}

/**
 * Text-only chat (bisa dengan analisa gambar).
 * Pakai model 3 Flash dengan responseModalities TEXT.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {{base64,mimeType}} opts.referenceImage — opsional, untuk vision/analisa gambar
 * @param {Array<{base64,mimeType}>} opts.extraImages — opsional, multiple gambar
 * @returns {Promise<{text, status}>}
 */
export async function generateText(opts) {
  const cfg = getConfig();
  const {
    prompt,
    referenceImage = null,
    extraImages = [],
    reqId = Math.floor(Math.random()  * 9999999),
  } = opts;

  const parts = [{ text: prompt }];
  const validImages = [referenceImage, ...(Array.isArray(extraImages) ? extraImages : [])]
    .filter(img => img?.base64 && img?.mimeType)
    .slice(0, 8);

  validImages.forEach((img, index) => {
    if (validImages.length > 1) parts.push({ text: `KANDIDAT GAMBAR #${index + 1} (indeks ${index})` });
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  });

  const innerJson = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT'] },
    model: MODEL_3_FLASH,
  });

  const fReq = JSON.stringify([
    [['q4uTj', JSON.stringify([null, innerJson, 4, cfg.shareId]), null, 'generic']],
  ]);

  const params = new URLSearchParams({
    rpcids: 'q4uTj',
    'source-path': `/share/${cfg.shareId}`,
    bl: cfg.bl,
    'f.sid': cfg.fSid,
    hl: cfg.hl,
    _reqid: String(reqId),
    rt: 'c',
  });

  const body = new URLSearchParams({ 'f.req': fReq, at: cfg.at });
  const headers = buildHeaders(cfg);

  const url = `${GEMINI_BASE}?${params.toString()}`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GEMINI_TEXT_TIMEOUT_MS || 30000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Gemini text request timeout after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const parsed = parseGeminiResponse(text);

  return {
    text: parsed.text,
    status: response.status,
  };
}

/**
 * Text-to-Speech: ubah teks menjadi audio WAV.
 * Pakai model gemini-2.5-flash-preview-tts dengan responseModalities AUDIO.
 *
 * @param {string} text — teks yang akan dibacakan
 * @param {string} voiceName — nama voice (default: 'Charon')
 * @returns {Promise<{audio: {base64, mimeType, dataUrl}, voice, textLength}>}
 */
export async function generateTTS(text, voice = 'Charon') {
  const cfg = getConfig();

  const innerJson = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      temperature: 1,
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
    model: MODEL_TTS,
  });

  // Parameter 5 = TTS mode (4 = image mode)
  const fReq = JSON.stringify([
    [['q4uTj', JSON.stringify([null, innerJson, 5, cfg.shareId]), null, 'generic']],
  ]);

  const params = new URLSearchParams({
    rpcids: 'q4uTj',
    'source-path': `/share/${cfg.shareId}`,
    bl: cfg.bl,
    'f.sid': cfg.fSid,
    hl: cfg.hl || 'id',
    _reqid: String(Math.floor(Math.random() * 9999999)),
    rt: 'c',
  });

  const body = new URLSearchParams({ 'f.req': fReq, at: cfg.at });
  const headers = buildHeaders(cfg);

  const url = `${GEMINI_BASE}?${params.toString()}`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GEMINI_TTS_TIMEOUT_MS || 30000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Gemini TTS request timeout after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const respText = await response.text();
  const audioData = extractAudioFromResponse(respText);

  if (!audioData) {
    throw new Error('TTS gagal. Audio tidak ditemukan di response Gemini.');
  }

  const wavBase64 = pcmToWavBase64(audioData.data, audioData.rate || 24000);

  return {
    audio: {
      base64: wavBase64,
      mimeType: 'audio/wav',
      dataUrl: `data:audio/wav;base64,${wavBase64}`,
    },
    voice,
    textLength: text.length,
  };
}

/**
 * Build headers untuk request ke Gemini web.
 */
function buildHeaders(cfg) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'x-same-domain': '1',
    Referer: 'https://gemini.google.com/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  };
  if (cfg.cookies) {
    headers.Cookie = cfg.cookies;
  }
  return headers;
}
