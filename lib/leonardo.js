/**
 * Leonardo GPT Image — engine untuk Gen Console.
 *
 * Sumber logika diambil dari RupaAI:
 *   - server/leonardoGpt.js  (graphql calls: Generate, status, images, upload ref)
 *   - server/leonardoStore.js (pool sesi, round-robin, exhausted logic)
 *
 * Sumber JWT: pool milik Leonardo sendiri (leonardo.azkazamdigital.com → :3130).
 * Gen Console TIDAK menyentuh RupaAI — dibaca dari hub pool Leonardo via HTTP.
 */
import fs from 'node:fs';
import { LeonardoError } from './leonardo-pool.js';
// ✅ PENTING (27 Sep'26): schema version WAJIB di-discover, bukan di-hardcode.
// Leonardo mengganti versi skema tanpa pemberitahuan; versi usang dijawab error
// SAMAR "An error occurred." (INTERNAL_SERVER_ERROR) — pesan yang sama sekali
// tidak memberi petunjuk. Inilah penyebab menu GPT Image selalu gagal.
// Sekarang schema diambil dari modul video (sudah punya discovery + cache 15 mnt).
import { discoverSchemaVersion, activeSchemaVersion } from './leo-video.js';

export { LeonardoError };

// Video (Hailuo 03 / MiniMax H3) via pool Leonardo — modul terpisah agar MCP bisa reuse.
export { LEO_VIDEO_MODEL, LEO_VIDEO_RESOLUTIONS, LEO_VIDEO_QUALITIES,
         LEO_VIDEO_DURATIONS, LEO_VIDEO_RATIOS, videoDimensions,
         coerceQualityResolution, toMp4Url,
         createVideoGeneration, getGenerationVideo, generateVideo } from './leo-video.js';

const LEO_API_BASE = 'https://api.leonardo.ai';
// JANGAN dipakai untuk request — hanya nilai awal sebelum discovery jalan.
// Versi skema aktif diambil dari activeSchemaVersion() (lihat leo-video.js).
const LEO_SCHEMA_FALLBACK = '1.321.0';
const DEFAULT_MODEL = 'openai/gpt-image-2.5-sunburst';

// Leonardo hanya menerima set dimensi tertentu. Nilai di luar daftar ini ditolak
// dengan: "parameters.width must be one of: ...". Rumus skala UI (1 / 1.48 / 2.63)
// menghasilkan angka mentah (mis. 2036x1137) yang TIDAK ada di daftar -> wajib di-snap.
export const LEO_WIDTHS = [768, 832, 848, 864, 896, 928, 1024, 1088, 1136, 1152, 1184, 1200, 1248, 1264, 1344, 1376, 1536, 1584, 1648, 1696, 1792, 1856, 2016, 2048, 2336, 2448, 2560, 2880, 3200, 3264, 3504, 3584, 3808];
export const LEO_HEIGHTS = [640, 672, 768, 832, 848, 864, 896, 928, 1024, 1136, 1152, 1184, 1200, 1248, 1264, 1280, 1344, 1376, 1536, 1584, 1632, 1648, 1696, 1792, 1824, 1856, 1920, 2016, 2048, 2336, 2448, 2560, 2880, 3200, 3264, 3504, 3584];

/** Snap ke dimensi terdekat yang didukung Leonardo. Dipakai agar ukuran dari
 *  rumus skala UI (rasio x faktor) selalu valid sebelum dikirim ke GraphQL. */
export function snapDimension(value, axis = 'width') {
  const bank = axis === 'height' ? LEO_HEIGHTS : LEO_WIDTHS;
  const n = Number(value);
  if (!Number.isFinite(n)) return bank[0];
  return bank.reduce((best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best), bank[0]);
}

/** Snap pasangan dimensi sekaligus, menjaga rasio sedekat mungkin. */
export function snapSize({ width, height }) {
  return { width: snapDimension(width, 'width'), height: snapDimension(height, 'height') };
}

const DEFAULT_STYLE_ID = '111dc692-d470-4eec-b791-3475abac4c46';

// Sumber pool: hub Leonardo (leonardo.azkazamdigital.com → :3130). Bukan RupaAI lagi.
// Fallback terakhir: baca file pool yang di-push hub ke disk lokal.
const LEO_POOL_URL = process.env.LEO_POOL_URL || 'http://127.0.0.1:3130/api/pool';
const LEO_POOL_KEY_FILE = process.env.LEO_POOL_KEY_FILE || '/home/ubuntu/leo-dashboard/data/pool-auth-key';
const LEO_POOL_FALLBACK_FILE = process.env.LEO_POOL_FALLBACK_FILE || '/home/ubuntu/work/gemini-proxy/mcp-state/leonardo-pool.json';

function leoPoolKey() {
  if (process.env.LEO_POOL_KEY) return process.env.LEO_POOL_KEY;
  try { return fs.readFileSync(LEO_POOL_KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

/** Ambil pool dari hub Leonardo. Gagal → fallback snapshot lokal (yang di-push hub). */
async function fetchPoolFromHub() {
  const key = leoPoolKey();
  const r = await fetch(LEO_POOL_URL, {
    headers: key ? { 'x-pool-key': key } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`hub HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data?.sessions)) throw new Error('hub: sessions tidak valid');
  return data;
}

function readPoolFallback() {
  try { return JSON.parse(fs.readFileSync(LEO_POOL_FALLBACK_FILE, 'utf8')); } catch { return null; }
}

const WIT_OFFSET_MS = 9 * 60 * 60 * 1000;
const witDay = (ms) => Math.floor((ms + WIT_OFFSET_MS) / 86400000);

function decodeJwtExp(token) {
  try {
    const part = String(token).split('.')[1];
    const pad = part + '='.repeat((4 - (part.length % 4)) % 4);
    return Number(JSON.parse(Buffer.from(pad, 'base64url').toString()).exp) || 0;
  } catch { return 0; }
}

export function leoHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    // Pakai versi skema yang SEDANG aktif (di-discover otomatis), bukan konstanta mati.
    'x-leo-schema-version': activeSchemaVersion() || '1.321.0',
    Origin: 'https://app.leonardo.ai',
    Referer: 'https://app.leonardo.ai/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  };
}

/** Deteksi "error samar" khas skema usang (sama seperti video):
 *  { message:'An error occurred.', code:'INTERNAL_SERVER_ERROR', statusCode:500 }
 *  Bentuk ini BUKAN tanda server rusak — sinyalnya skema kita sudah usang. */
function isOpaqueSchemaError(detail, err0) {
  const code = String(err0?.extensions?.code || '');
  const text = String(detail || err0?.message || '');
  return code === 'INTERNAL_SERVER_ERROR' || /^(an error occurred\.?|oops, something went wrong)/i.test(text.trim());
}

async function leoGraphql(accessToken, body, _retried = false) {
  const resp = await fetch(`${LEO_API_BASE}/v1/graphql`, {
    method: 'POST',
    headers: leoHeaders(accessToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.message || data?.error || `Leonardo HTTP ${resp.status}`;
    // Pertahankan status asli (402 kredit habis, 429 rate limit) supaya lapisan pool
    // bisa mencoba akun berikutnya. Hanya 5xx yang dipetakan ke 502.
    const status = resp.status === 402 || resp.status === 429 || resp.status === 401 || resp.status === 403
      ? resp.status
      : (resp.status >= 500 ? 502 : 400);
    throw new LeonardoError(msg, { status });
  }
  if (data?.errors?.length) {
    const err0 = data.errors[0];
    const detail =
      err0?.extensions?.details?.errors?.[0]?.message ||
      err0?.extensions?.details?.message ||
      err0?.message ||
      'Leonardo GraphQL error';

    // ── AUTO-RECOVERY SKEMA USANG ───────────────────────────────────────────
    // Kalau dapat error samar "An error occurred.", cari versi skema terbaru
    // lalu ULANGI request yang sama SEKALI. Ini yang membuat GPT Image hidup lagi.
    if (isOpaqueSchemaError(detail, err0) && !_retried) {
      const before = activeSchemaVersion();
      const next = await discoverSchemaVersion({ force: true });
      if (next && next !== before) {
        console.log(`[Leonardo] skema usang ${before} → ${next}, ulangi request`);
        return leoGraphql(accessToken, body, true);
      }
    }

    // GraphQL kadang mengembalikan HTTP 200 dengan error di body — status asli
    // ada di extensions.statusCode. Hormati itu supaya rotasi akun tetap jalan.
    const ext = err0?.extensions || {};
    const raw = Number(ext.statusCode ?? ext.status ?? 0);
    const status = raw === 402 || raw === 429 || raw === 401 || raw === 403
      ? raw
      : (raw >= 500 ? 502 : 400);
    throw new LeonardoError(detail, { status });
  }
  return data;
}

// ─── Pool sesi (dibaca dari sumber JWT Leonardo) ─────────────────────

let poolCache = { at: 0, raw: null };
const POOL_TTL_MS = 15000;

export async function loadLeonardoPool({ force = false } = {}) {
  if (!force && poolCache.raw && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.raw;
  try {
    const data = await fetchPoolFromHub();
    poolCache = { at: Date.now(), raw: data };
    return data;
  } catch (e) {
    // Hub tidak tersedia → pakai snapshot terakhir yang di-push hub (pool tidak pernah bolong).
    const fb = readPoolFallback();
    if (fb && Array.isArray(fb.sessions)) {
      poolCache = { at: Date.now(), raw: { ...fb, _stale: true, _hubError: String(e.message).slice(0, 120) } };
      return poolCache.raw;
    }
    throw new LeonardoError(`Tidak bisa membaca pool dari hub Leonardo: ${String(e.message).slice(0, 160)}`, { status: 503 });
  }
}

function isSessionFresh(s, bufferMs = 120000) {
  if (!s?.accessToken) return false;
  if (s.invalid) return false;
  if (s.exhaustedAt && witDay(Date.now()) <= witDay(Number(s.exhaustedAt))) return false;
  const exp = Number(s.tokenExp) || decodeJwtExp(s.accessToken);
  return exp * 1000 > Date.now() + bufferMs;
}

/** Daftar sesi yang siap dipakai (fresh, belum habis). */
export async function listFreshSessions() {
  const pool = await loadLeonardoPool();
  return (pool.sessions || []).filter((s) => isSessionFresh(s));
}

export function poolSummary(pool) {
  const now = Date.now();
  const sessions = pool?.sessions || [];
  return {
    total: sessions.length,
    fresh: sessions.filter((s) => isSessionFresh(s)).length,
    exhausted: sessions.filter((s) => s.exhaustedAt && witDay(now) <= witDay(Number(s.exhaustedAt))).length,
    expired: sessions.filter((s) => !isSessionFresh(s) && !(s.exhaustedAt && witDay(now) <= witDay(Number(s.exhaustedAt)))).length,
    resetAt: new Date(Math.floor((now + WIT_OFFSET_MS) / 86400000) * 86400000 - WIT_OFFSET_MS + 86400000).toISOString(),
  };
}

/**
 * Jalankan fn(accessToken) dengan rotasi round-robin + failover otomatis.
 * Sesi yang gagal auth/limit dilewati sampai jumlah percobaan habis.
 */
export async function withLeonardoSession(fn, { maxAttempts = 5, preferEmail = null } = {}) {
  const pool = await loadLeonardoPool();
  const sessions = (pool.sessions || []).filter((s) => isSessionFresh(s));
  if (!sessions.length) throw new LeonardoError('Tidak ada akun Leonardo yang siap (semua expired/habis)', { status: 503 });

  const start = Number(pool.cursor) || 0;
  const ordered = preferEmail
    ? [...sessions.filter((s) => s.email === preferEmail), ...sessions.filter((s) => s.email !== preferEmail)]
    : [...sessions.slice(start % sessions.length), ...sessions.slice(0, start % sessions.length)];

  let lastErr = null;
  for (let i = 0; i < Math.min(maxAttempts, ordered.length); i++) {
    const s = ordered[i];
    try {
      return await fn(s.accessToken, s);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || '');
      const retryable = e?.status === 429 || e?.status === 401 || e?.status === 403 || /credit|token|quota|limit|unauthor|expired/i.test(msg);
      if (!retryable) throw e;
    }
  }
  throw lastErr || new LeonardoError('Semua akun Leonardo gagal', { status: 502 });
}

// ─── GraphQL operations (port dari RupaAI leonardoGpt.js) ────────────

export async function createGeneration(accessToken, params) {
  const body = {
    operationName: 'Generate',
    variables: {
      request: {
        model: params.model || DEFAULT_MODEL,
        public: params.public ?? true,
        parameters: {
          height: params.height || 1376,
          width: params.width || 768,
          prompt_enhance: params.imageReference ? 'OFF' : params.promptEnhance || 'AUTO',
          quality: params.quality || 'LOW',
          quantity: params.quantity || 1,
          style_ids: params.styleIds || [DEFAULT_STYLE_ID],
          prompt: params.prompt,
          ...(params.imageReference
            ? {
                guidances: {
                  image_reference: [
                    {
                      image: {
                        id: params.imageReference.id,
                        type: params.imageReference.type || 'UPLOADED',
                      },
                      strength: params.imageReference.strength || 'MID',
                    },
                  ],
                },
              }
            : {}),
        },
      },
    },
    query: `mutation Generate($request: CreateGenerationRequest!) {
  generate(request: $request) {
    apiCreditCost
    generationId
    __typename
  }
}`,
  };
  const data = await leoGraphql(accessToken, body);
  const generationId = data.data?.generate?.generationId;
  if (!generationId) throw new LeonardoError('Leonardo tidak mengembalikan generationId');
  return { generationId, apiCreditCost: data.data?.generate?.apiCreditCost ?? null };
}

export async function pollStatus(accessToken, generationId) {
  const data = await leoGraphql(accessToken, {
    operationName: 'GetAIGenerationFeedStatuses',
    variables: { where: { id: { _in: [generationId] }, status: { _in: ['PENDING', 'COMPLETE', 'FAILED'] } } },
    query: `query GetAIGenerationFeedStatuses($where: generations_bool_exp = {}) {
  generations(where: $where) { id status __typename }
}`,
  });
  return data.data?.generations?.[0]?.status || 'PENDING';
}

export async function getGenerationImages(accessToken, generationId) {
  const data = await leoGraphql(accessToken, {
    operationName: 'GetGenerationImages',
    variables: { id: generationId },
    query: `query GetGenerationImages($id: uuid!) {
  generations_by_pk(id: $id) {
    id status
    generated_images(order_by: [{url: desc}]) { id url image_width image_height __typename }
    __typename
  }
}`,
  });
  const imgs = data.data?.generations_by_pk?.generated_images || [];
  return imgs.map((i) => ({ id: i.id, url: i.url, width: i.image_width, height: i.image_height }));
}

export async function getUserTokens(accessToken, userSub) {
  if (!userSub) return null;
  const data = await leoGraphql(accessToken, {
    operationName: 'GetUserTokensFromSub',
    variables: { sub: userSub },
    query: `query GetUserTokensFromSub($sub: String) {
  user_details(where: {cognitoId: {_eq: $sub}}) {
    id plan subscriptionGptTokens paidTokens subscriptionTokens rolloverTokens __typename
  }
}`,
  });
  return data.data?.user_details?.[0] || null;
}

/** Upload gambar referensi (untuk img2img) — port dari RupaAI. */
export async function uploadReferenceFromBuffer(accessToken, buffer, mimeType = 'image/jpeg') {
  const mimeToExt = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const ext = mimeToExt[mimeType] || 'jpg';

  const initData = await leoGraphql(accessToken, {
    operationName: 'UploadImage',
    variables: { uploadImageInput: { uploadType: 'INIT', extension: ext } },
    query: `mutation UploadImage($uploadImageInput: UploadImageInput!) {
  uploadImage(arg1: $uploadImageInput) { uploadId url fields __typename }
}`,
  });
  const info = initData.data?.uploadImage;
  if (!info?.uploadId || !info?.url) throw new LeonardoError('Gagal mendapat URL upload Leonardo');

  const fields = typeof info.fields === 'string' ? JSON.parse(info.fields) : info.fields || {};
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('file', new Blob([buffer], { type: mimeType }), `image.${ext}`);

  const up = await fetch(info.url, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    throw new LeonardoError(`Upload S3 gagal (${up.status}): ${text.slice(0, 160)}`, { status: 502 });
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const modData = await leoGraphql(accessToken, {
      operationName: 'GetInitImageModeration',
      variables: { akUUID: info.uploadId },
      query: `query GetInitImageModeration($akUUID: uuid!) {
  init_image_moderation(where: {akUUID: {_eq: $akUUID}}) {
    akUUID initImageId checkStatus
    init_image { imageWidth: image_width imageHeight: image_height __typename }
    __typename
  }
}`,
    });
    const rec = modData.data?.init_image_moderation?.[0];
    if (rec?.checkStatus === 'Accepted' && rec.initImageId) {
      return { id: rec.initImageId, type: 'UPLOADED', width: rec.init_image?.imageWidth || 0, height: rec.init_image?.imageHeight || 0 };
    }
    if (rec?.checkStatus === 'Rejected') throw new LeonardoError('Gambar referensi ditolak moderasi', { status: 400 });
  }
  throw new LeonardoError('Timeout moderasi gambar referensi', { status: 504 });
}

/** Generate lengkap: buat job → poll → ambil URL gambar. */
export async function generateImage({ prompt, width = 768, height = 1376, quantity = 1, quality = 'LOW', promptEnhance = 'AUTO', model = DEFAULT_MODEL, imageBase64 = null, mimeType = 'image/jpeg', timeoutMs = 300000 }) {
  // Pastikan versi skema sudah yang terbaru sebelum kirim (cached 15 menit, tanpa kredit).
  // Tanpa ini, generate gambar kena error samar "An error occurred." begitu Leonardo
  // menaikkan versi skema (persis seperti yang terjadi pada menu GPT Image).
  await discoverSchemaVersion().catch(() => {});

  return withLeonardoSession(async (token, session) => {
    let imageReference = null;
    if (imageBase64) {
      const buf = Buffer.from(String(imageBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      imageReference = await uploadReferenceFromBuffer(token, buf, mimeType);
    }

    const { generationId } = await createGeneration(token, {
      prompt, width, height, quantity, quality,
      promptEnhance: imageReference ? 'OFF' : promptEnhance,
      model, imageReference,
    });

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await pollStatus(token, generationId);
      if (status === 'COMPLETE') {
        const images = await getGenerationImages(token, generationId);
        if (!images.length) throw new LeonardoError('Gambar tidak tersedia setelah selesai');
        return { generationId, images, account: session?.email || null };
      }
      if (status === 'FAILED') throw new LeonardoError('Generate gagal di sisi Leonardo', { status: 502 });
    }
    throw new LeonardoError('Timeout menunggu gambar selesai', { status: 504 });
  });
}

export const LEONARDO_DEFAULTS = { DEFAULT_MODEL, DEFAULT_STYLE_ID };
