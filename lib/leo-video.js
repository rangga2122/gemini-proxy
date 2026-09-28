/**
 * lib/leo-video.js — Generate VIDEO via pool Leonardo (Hailuo 03 / MiniMax H3).
 *
 * Model resmi Leonardo: custom_models "Hailuo 03" (id 2bec8cd2-a7dc-4a16-b27b-104344910b16),
 * public: true, motionModel HAILUO03. Dipakai untuk t2v (text→video) & i2v (image→video).
 *
 * ── HASIL REVERSE-ENGINEERING (26 Sep 2026, dari UI app.leonardo.ai) ────────────
 * Payload PERSIS yang dikirim UI (tangkap via Xvfb+Camoofox, skema 1.320.1):
 *   request: { model:'hailuo-03', public:true, parameters:{
 *     height, width, duration, quality, quantity:1, prompt, resolution,
 *     motion_has_audio:true,
 *     guidances:{ start_frame:[{ image:{ id, type:'GENERATED'|'UPLOADED' } }] }   // i2v
 *   }}
 * Respons: { data.generate: { generationId, cost:{ amount, unit:'CREDITS' } } }
 *
 * 3 JEBOLAN UTAMA yang wajib benar (kalau salah → 402 "Insufficient tokens" walau saldo ADA):
 *   1. header `x-leo-schema-version` HARUS 1.320.1 (versi publik terbaru). Nilai lama
 *      1.299.0 membuat server menolak video dgn 402 seolah token kurang.
 *   2. `motion_has_audio: true` wajib ada di parameters.
 *   3. guidance gambar untuk i2v = `start_frame`, BUKAN `image_reference`
 *      (rules: hailuo_0_3_turbo_disables_high_res_and_refs).
 *
 * BIAYA TOKEN (dari leo:cost_config + leo:cost_modifier di skema resmi):
 *   base 65 token/detik-5  ×  modifier kualitas  ×  faktor durasi
 *   TURBO        → ×0.1846  (paling murah)
 *   ACCELERATED  → ×0.3385
 *   STANDARD     → ×1.0
 *   Terukur nyata: TURBO 480p d6 = 72 kredit | TURBO 480p d10 = 120 kredit | TURBO 768p d10 = 150 kredit
 *
 * ATURAN KERAS LEONARDO: TURBO DILARANG di resolusi 2K/4K (1440/2160)
 *   ($id hailuo_0_3_turbo_disables_high_res_and_refs → job langsung FAILED).
 *   768p HD DIIZINKAN untuk TURBO (terbukti E2E 768x1344 d10 COMPLETE).
 *   Kalau kualitas TURBO diminta dengan 2K/4K, resolusi otomatis diturunkan.
 *
 * CATATAN UI (26 Sep'26, permintaan Azka): menu Video Mini hanya menyediakan
 *   resolusi 480p & 768p (dilabel "720p HD") + durasi tetap 10 detik + kualitas
 *   TURBO. Leonardo TIDAK punya bank resolusi 720 — 720p dipetakan ke 768p.
 *
 * Pool sesi dari hub Leonardo (:3130), rotasi round-robin + failover otomatis.
 */
import fs from 'node:fs';
import { withLeonardoSession, LeonardoError } from './leonardo-pool.js';
// Pool VIDEO terpisah (akun 150 kredit utuh, 1 akun = 1 video). Direservasi di hub
// supaya tidak bentrok dengan generate gambar dan tidak dobel pakai.
import { withVideoSession } from './leo-video-pool.js';

const LEO_API_BASE = 'https://api.leonardo.ai';

// Versi skema publik Leonardo. JANGAN di-hardcode mati.
// ── Temuan penting 27 Sep'26 ────────────────────────────────────────────────
// Leonardo MENGGANTI versi rilis skema mereka tanpa pemberitahuan (1.320.1 →
// 1.321.0 hanya dalam ~14 jam). Versi usang TIDAK dijawab "schema version tidak
// didukung", melainkan error SAMAR:
//     HTTP 200 { data:null, errors:[{ message:"An error occurred.",
//                extensions:{ code:"INTERNAL_SERVER_ERROR", statusCode:500 }}] }
// Efeknya: semua generate video gagal ("An error occurred") padahal akun &
// kredit sehat — dan pesan errornya tidak memberi petunjuk apa pun.
// Solusi: versi aktif di-DISCOVER otomatis dari registry publik Leonardo
// (`publicJsonSchemaRegistry.release(id)` — bisa diakses tanpa auth), di-cache
// 15 menit, plus auto-retry sekali kalau generate tetap kena error samar itu.
const LEO_SCHEMA_PIN = process.env.LEO_SCHEMA_VERSION || ''; // opsional: pin manual
const LEO_SCHEMA_FALLBACK = '1.321.0';
const SCHEMA_CACHE_TTL_MS = 15 * 60 * 1000;
const SCHEMA_CACHE_FILE = process.env.LEO_SCHEMA_CACHE_FILE || '/tmp/leo-schema-version.json';

let ACTIVE_SCHEMA = LEO_SCHEMA_PIN || LEO_SCHEMA_FALLBACK;
let schemaCacheAt = 0;

export function activeSchemaVersion() {
  return ACTIVE_SCHEMA;
}

function readSchemaCacheFile() {
  try {
    const j = JSON.parse(fs.readFileSync(SCHEMA_CACHE_FILE, 'utf8'));
    if (j?.version && Number(j.at) > 0) { ACTIVE_SCHEMA = j.version; schemaCacheAt = Number(j.at); }
  } catch { /* belum ada cache — normal */ }
}

function writeSchemaCacheFile() {
  try { fs.writeFileSync(SCHEMA_CACHE_FILE, JSON.stringify({ version: ACTIVE_SCHEMA, at: schemaCacheAt })); } catch { /* /tmp selalu bisa ditulis; abaikan */ }
}

/**
 * Cari versi skema ACTIVE terbaru dari registry publik Leonardo.
 * Tanpa auth, tanpa kredit. Hasil di-cache 15 menit (memori + file, tahan restart).
 */
export async function discoverSchemaVersion({ force = false } = {}) {
  if (LEO_SCHEMA_PIN) return LEO_SCHEMA_PIN;
  if (!schemaCacheAt) readSchemaCacheFile();
  if (!force && Date.now() - schemaCacheAt < SCHEMA_CACHE_TTL_MS) return ACTIVE_SCHEMA;

  const [maj, min] = ACTIVE_SCHEMA.split('.').map(Number);
  const cands = [];
  for (let m = Math.max(0, min - 4); m <= min + 10; m++) for (let p = 0; p <= 3; p++) cands.push(`${maj}.${m}.${p}`);

  const check = async (v) => {
    try {
      const r = await fetch(`${LEO_API_BASE}/v1/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-leo-schema-version': '1.299.0', Origin: 'https://app.leonardo.ai', Referer: 'https://app.leonardo.ai/' },
        body: JSON.stringify({ query: `{ publicJsonSchemaRegistry { release(id:"${v}") { id status releasedAt } } }` }),
        signal: AbortSignal.timeout(12000),
      });
      const d = await r.json().catch(() => ({}));
      const rel = d?.data?.publicJsonSchemaRegistry?.release;
      return rel?.id && rel.status === 'ACTIVE' ? rel : null;
    } catch { return null; }
  };

  let best = null;
  for (let i = 0; i < cands.length; i += 8) {
    const batch = await Promise.all(cands.slice(i, i + 8).map(check));
    for (const rel of batch) {
      if (rel && (!best || String(rel.releasedAt) > String(best.releasedAt))) best = rel;
    }
  }

  if (best?.id) {
    const changed = best.id !== ACTIVE_SCHEMA;
    ACTIVE_SCHEMA = best.id;
    schemaCacheAt = Date.now();
    writeSchemaCacheFile();
    if (changed) console.log(`[LeoVideo] schema version → ${best.id} (rilis ${best.releasedAt})`);
  } else {
    schemaCacheAt = Date.now(); // jangan hammering registry kalau registry down
  }
  return ACTIVE_SCHEMA;
}
// Biaya video Leonardo = 15 kredit/detik (independen resolusi). Dipakai untuk menghitung
// biaya NYATA, karena `apiCreditCost` dari API hanyalah tarif kuota (selalu 150).
const VIDEO_COST_PER_SEC = 15;

export const LEO_VIDEO_MODEL = 'hailuo-03';
export const LEO_VIDEO_RESOLUTIONS = ['480p', '768p', '2k', '4k'];
export const LEO_VIDEO_QUALITIES = ['TURBO', 'STANDARD', 'ACCELERATED'];
export const LEO_VIDEO_DURATIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
export const LEO_VIDEO_RATIOS = ['9:16', '16:9'];

/**
 * Alias resolusi. Leonardo TIDAK punya bank 720 — UI melabeli 768p sebagai
 * "720p HD", jadi terima `720p` sebagai alias 768p (kalau tidak, request
 * 720p akan dianggap tidak valid dan jatuh ke 480p).
 */
const RES_ALIAS = { '720p': '768p', '720': '768p', 'hd': '768p' };
export function normalizeResolution(resolution) {
  const raw = String(resolution ?? '').toLowerCase();
  const mapped = RES_ALIAS[raw] || raw;
  return LEO_VIDEO_RESOLUTIONS.includes(mapped) ? mapped : '480p';
}

// Dimensi resmi per (resolusi, rasio) — semua ada di whitelist Leonardo.
const LEO_VIDEO_DIMS = {
  '480p': { '9:16': [480, 856], '16:9': [856, 480] },
  '768p': { '9:16': [768, 1376], '16:9': [1376, 768] },
  '2k': { '9:16': [1440, 2560], '16:9': [2560, 1440] },
  '4k': { '9:16': [2160, 3840], '16:9': [3840, 2160] },
};

/**
 * Batas resolusi per kualitas (aturan resmi Leonardo):
 *   hailuo_0_3_turbo_disables_high_res_and_refs       → TURBO mati di 2k & 4k
 *   hailuo_0_3_accelerated_disables_high_res_and_refs → ACCELERATED mati di 2k & 4k
 * Jadi TURBO & ACCELERATED masih boleh 768p (HD). STANDARD bebas sampai 4K.
 */
const QUALITY_MAX_RES = { TURBO: '768p', ACCELERATED: '768p' };
const RES_ORDER = ['480p', '768p', '2k', '4k'];

/**
 * Koersi parameter agar selalu valid di Leonardo. TURBO + ≥768p = job FAILED,
 * jadi resolusi diturunkan ke batas yang diizinkan (bukan kualitasnya, supaya murah).
 */
export function coerceQualityResolution(quality, resolution) {
  const q = String(quality || 'TURBO').toUpperCase();
  const res = normalizeResolution(resolution);
  const max = QUALITY_MAX_RES[q];
  if (max && RES_ORDER.indexOf(res) > RES_ORDER.indexOf(max)) {
    return { quality: q, resolution: max, coerced: true, reason: `${q} tidak mendukung ${res} (aturan Leonardo) — diturunkan ke ${max}` };
  }
  return { quality: q, resolution: res, coerced: false };
}

export function videoDimensions(ratio = '9:16', resolution = '768p') {
  const r = LEO_VIDEO_RATIOS.includes(ratio) ? ratio : '9:16';
  const res = normalizeResolution(resolution);
  const [width, height] = LEO_VIDEO_DIMS[res][r];
  return { width, height, ratio: r, resolution: res };
}

function leoHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'x-leo-schema-version': ACTIVE_SCHEMA,
    Origin: 'https://app.leonardo.ai',
    Referer: 'https://app.leonardo.ai/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  };
}

/**
 * Deteksi "error samar" khas skema usang:
 *   { message:'An error occurred.', code:'INTERNAL_SERVER_ERROR', statusCode:500 }
 * Leonardo memakai bentuk ini untuk versi skema yang sudah tidak berlaku,
 * jadi JANGAN diterjemahkan sebagai "server sedang rusak" — sinyalnya adalah
 * kita perlu pindah ke versi skema terbaru lalu ulangi request.
 */
function isOpaqueSchemaError(detail, err0) {
  const code = String(err0?.extensions?.code || '');
  const text = String(detail || err0?.message || '');
  return code === 'INTERNAL_SERVER_ERROR' || /^(an error occurred\.?|oops, something went wrong)/i.test(text.trim());
}

async function leoGraphql(accessToken, body, timeoutMs = 60000, _retried = false) {
  const resp = await fetch(`${LEO_API_BASE}/v1/graphql`, {
    method: 'POST',
    headers: leoHeaders(accessToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.message || data?.error || `Leonardo HTTP ${resp.status}`;
    throw new LeonardoError(msg, { status: resp.status >= 500 ? 502 : 400 });
  }
  if (data?.errors?.length) {
    const err0 = data.errors[0];
    const det = err0?.extensions?.details;
    const detail =
      (typeof det === 'object' && det?.errors?.[0]?.message) ||
      (typeof det === 'object' && det?.message) ||
      (typeof det === 'string' ? det : null) ||
      err0?.message ||
      'Leonardo GraphQL error';

    // ── AUTO-RECOVERY SKEMA USANG (27 Sep'26) ───────────────────────────────
    // Leonardo menaikkan versi skema tanpa pengumuman; versi lama dibalas
    // "An error occurred." (INTERNAL_SERVER_ERROR) yang tidak informatif.
    // Di sini: paksa cari versi terbaru, lalu ULANGI request yang sama 1×.
    if (isOpaqueSchemaError(detail, err0) && !_retried) {
      const before = ACTIVE_SCHEMA;
      const next = await discoverSchemaVersion({ force: true });
      if (next && next !== before) {
        console.log(`[LeoVideo] skema usang ${before} → ${next}, ulangi request`);
        return leoGraphql(accessToken, body, timeoutMs, true);
      }
    }

    // Kode status harus DITERUSKAN apa adanya untuk status yang bisa diulang.
    // Bug nyata (27 Sep'26, terbukti dari uji langsung): Leonardo membalas
    // `HttpException` 403 "Access denied / Request denied". Sebelumnya SEMUA kode
    // selain 402 dipetakan jadi 400 → `withVideoSession` menganggapnya permanen
    // ("konten ditolak") sehingga akun TIDAK dirotasi dan generate langsung gagal.
    // Sekarang 401/403/402/429 diteruskan, jadi pool otomatis mencoba akun lain.
    const sc = Number(err0?.extensions?.statusCode) || 0;
    const status = [401, 402, 403, 429].includes(sc) ? sc : 400;
    throw new LeonardoError(String(detail), { status });
  }
  return data;
}

async function uploadReferenceFromBuffer(accessToken, buffer, mimeType = 'image/jpeg') {
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
      // Catatan per 27 Sep'26: rasio gambar BUKAN penyebab job gagal (sudah diuji
      // 3:4 & 9:16 — keduanya lolos moderasi). Jangan tambahkan penolakan berbasis
      // rasio di sini; itu akan memblokir gambar yang sebenarnya valid.
      return { id: rec.initImageId, type: 'UPLOADED', width: Number(rec.init_image?.imageWidth) || 0, height: Number(rec.init_image?.imageHeight) || 0 };
    }
    if (rec?.checkStatus === 'Rejected') {
      const iw = Number(rec.init_image?.imageWidth) || 0;
      const ih = Number(rec.init_image?.imageHeight) || 0;
      throw new LeonardoError(`Gambar referensi ditolak moderasi Leonardo${iw ? ` (${iw}×${ih})` : ''}`, { status: 400 });
    }
  }
  throw new LeonardoError('Timeout moderasi gambar referensi', { status: 504 });
}

/**
 * Buat job video. Payload mengikuti PERSIS yang dikirim UI Leonardo.
 * @param imageReference {id, type:'GENERATED'|'UPLOADED'} → dikirim sbg guidances.start_frame
 */
export async function createVideoGeneration(accessToken, params) {
  const parameters = {
    prompt: params.prompt,
    width: params.width,
    height: params.height,
    duration: params.duration,
    resolution: params.resolution,
    quality: params.quality,
    quantity: params.quantity || 1,
    // WAJIB true (T2V maupun I2V) — tanpa ini Leonardo membalas 402.
    // Terbukti E2E: T2V & I2V sama-sama COMPLETE dengan motion_has_audio:true,
    // dan justru inilah yang menghasilkan Voice Over (audio native MiniMax H3).
    motion_has_audio: params.motionHasAudio !== false,
    ...(params.imageReference
      ? { guidances: { start_frame: [{ image: { id: params.imageReference.id, type: params.imageReference.type || 'UPLOADED' } }] } }
      : {}),
  };
  const data = await leoGraphql(accessToken, {
    operationName: 'Generate',
    variables: { request: { model: params.model || LEO_VIDEO_MODEL, public: params.public ?? true, parameters } },
    query: `mutation Generate($request: CreateGenerationRequest!) {
  generate(request: $request) {
    apiCreditCost
    generationId
    cost { amount unit __typename }
    __typename
  }
}`,
  }, 90000);
  const generationId = data.data?.generate?.generationId;
  if (!generationId) throw new LeonardoError('Leonardo tidak mengembalikan generationId video');
  const cost = data.data?.generate?.cost || null;
  return { generationId, apiCreditCost: data.data?.generate?.apiCreditCost ?? null, cost };
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

/**
 * Ambil hasil video. PENTING: Leonardo mengembalikan URL berakhiran `.jpg`
 * (thumbnail) walau outputType=VIDEO. MP4 asli ada di URL yang sama dgn
 * ekstensi `.mp4`. Jadi URL di-rewrite, bukan dicari pola ".mp4".
 */
export function toMp4Url(url) {
  return String(url || '').replace(/-\d+\.(jpg|jpeg|png|webp)$/i, (m, ext) => m.replace(ext, 'mp4'));
}

export async function getGenerationVideo(accessToken, generationId) {
  const data = await leoGraphql(accessToken, {
    operationName: 'GetGenerationVideo',
    variables: { id: generationId },
    query: `query GetGenerationVideo($id: uuid!) {
  generations_by_pk(id: $id) {
    id status outputType motionModel motionHasAudio
    generated_images(order_by: [{url: desc}]) { id url image_width image_height __typename }
    __typename
  }
}`,
  });
  const pk = data.data?.generations_by_pk || {};
  const imgs = pk.generated_images || [];
  return imgs.map((i) => ({
    id: i.id,
    url: toMp4Url(i.url),
    thumb: i.url,
    width: i.image_width,
    height: i.image_height,
    outputType: pk.outputType || null,
    motionModel: pk.motionModel || null,
    hasAudio: pk.motionHasAudio ?? null,
  }));
}

/** Generate video lengkap: text→video atau image→video, pakai pool VIDEO (reservasi + rotasi). */
export async function generateVideo({
  prompt, ratio = '9:16', resolution = '768p', duration = 10, quality = 'TURBO',
  model = LEO_VIDEO_MODEL, imageBase64 = null, mimeType = 'image/jpeg', timeoutMs = 900000,
  promptEnhance = 'AUTO', onAccepted = null,
}) {
  if (!prompt || !String(prompt).trim()) throw new LeonardoError('Prompt wajib diisi', { status: 400 });

  // Pastikan versi skema sudah yang terbaru sebelum kirim (cached 15 menit, tanpa kredit).
  await discoverSchemaVersion().catch(() => {});

  const co = coerceQualityResolution(quality, resolution);
  const { width, height } = videoDimensions(ratio, co.resolution);

  return withVideoSession(async (token, session, { markAccepted }) => {
    let imageReference = null;
    if (imageBase64) {
      const buf = Buffer.from(String(imageBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      imageReference = await uploadReferenceFromBuffer(token, buf, mimeType);
    }
    const { generationId, apiCreditCost, cost } = await createVideoGeneration(token, {
      prompt, width, height,
      duration: LEO_VIDEO_DURATIONS.includes(Number(duration)) ? Number(duration) : 10,
      resolution: co.resolution,
      quality: co.quality,
      model, imageReference, motionHasAudio: true, promptEnhance,
    });

    // Job DITERIMA Leonardo → kredit terpotong di akun ini.
    // PENTING: `apiCreditCost` dari Leonardo = TARIF KUOTA (flat 150), BUKAN potongan nyata.
    // Bukti lapangan: video 6 dtk membuat saldo live turun 90 (150 → 60). Jadi biaya
    // nyata = 15 kredit × durasi. Kalau memakai apiCreditCost, akun sehat ikut dianggap habis.
    const actualCost = VIDEO_COST_PER_SEC * (LEO_VIDEO_DURATIONS.includes(Number(duration)) ? Number(duration) : 10);
    await markAccepted(actualCost);

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const status = await pollStatus(token, generationId);
      if (status === 'COMPLETE') {
        const videos = await getGenerationVideo(token, generationId);
        if (!videos.length) throw new LeonardoError('Video tidak tersedia setelah selesai');
        return {
          generationId, videos, account: session?.name || session?.email || null,
          mode: imageReference ? 'image-to-video' : 'text-to-video',
          width, height, ratio, resolution: co.resolution, duration, quality: co.quality,
          apiCreditCost, cost, coerced: co.coerced, note: co.reason || null,
        };
      }
      if (status === 'FAILED') throw new LeonardoError(`Generate video gagal di sisi Leonardo (job ${generationId})`, { status: 502 });
    }
    throw new LeonardoError('Timeout menunggu video selesai', { status: 504 });
  }, { maxAttempts: 3, onAccepted });
}
