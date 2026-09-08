// lib/vibes.js — Video generation untuk Gen Console (multi-akun)
// Session diambil dari PostgreSQL RupaAI tabel vibes_sessions — SEMUA baris,
// round-robin per request, cooldown otomatis saat akun gagal auth.
// Alur per akun: project resolve (retry) → upload → register → batch → generate → poll.

const VIBES_BASE = 'https://vibes.ai';
const VIBES_FALLBACK_PROJECT = process.env.VIBES_PROJECT_ID || 'f5d86de5-82f2-469e-9a1b-7bf5dc3c9994';
const BATCH_MAP_PATH = process.env.VIBES_BATCH_MAP_PATH || 'video-batch-accounts.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
export const ALLOWED_RESOLUTIONS = ['480p', '720p'];

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Koneksi PostgreSQL (DATABASE_URL atau varian terpisah) ──
let pgPool = null;

function pgConfig() {
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      return {
        host: u.hostname,
        port: Number(u.port || 5432),
        user: u.username,
        password: decodeURIComponent(u.password),
        database: u.pathname.replace(/^\//, ''),
        ssl: false,
      };
    } catch { /* fallthrough ke varian terpisah */ }
  }
  return {
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
    ssl: false,
  };
}

function getPool() {
  if (!pgPool) {
    const { Pool } = requirePg();
    pgPool = new Pool(pgConfig());
    pgPool.on('error', () => { pgPool = null; });
  }
  return pgPool;
}

function requirePg() {
  try { return require('pg'); }
  catch { throw new Error('Modul pg tidak tersedia'); }
}

// ─── Multi-akun: daftar session, round-robin, cooldown ──
let accountsCache = { rows: [], fetchedAt: 0 };
const ACCOUNTS_TTL = 30_000;
const cooldowns = new Map(); // key → untilMs
let rrIndex = 0;

export async function listVibesAccounts(force = false) {
  const now = Date.now();
  if (!force && accountsCache.rows.length && now - accountsCache.fetchedAt < ACCOUNTS_TTL) return accountsCache.rows;
  const pool = getPool();
  const res = await pool.query(
    `SELECT key, session_value, project_id, username, valid, captured_at, synced_at
     FROM vibes_sessions
     WHERE session_value IS NOT NULL AND session_value <> ''
     ORDER BY captured_at ASC, key ASC`);
  accountsCache = { rows: res.rows, fetchedAt: now };
  return accountsCache.rows;
}

function isCoolingDown(key) {
  const until = cooldowns.get(key) || 0;
  return until > Date.now();
}

function markCooldown(key, ms = 5 * 60_000) {
  cooldowns.set(key, Date.now() + ms);
}

function clearCooldown(key) {
  cooldowns.delete(key);
}

// Pilih akun round-robin yang tidak sedang cooldown; return null jika kosong.
export async function pickVibesAccount(preferredKey = null) {
  const rows = await listVibesAccounts();
  if (!rows.length) return null;
  if (preferredKey) {
    const row = rows.find((r) => r.key === preferredKey);
    if (row && !isCoolingDown(row.key)) return row;
  }
  const healthy = rows.filter((r) => !isCoolingDown(r.key));
  if (!healthy.length) return null; // semua cooldown — biarkan caller pakai preferred/apapun
  const picked = healthy[rrIndex % healthy.length];
  rrIndex = (rrIndex + 1) % healthy.length;
  return picked;
}

function isAuthError(error) {
  const status = Number(error?.status || 0);
  const msg = String(error?.message || '');
  return [401, 403].includes(status)
    || /auth|session|unauthor|forbidden|login/i.test(msg)
    || /project not found/i.test(msg);
}

export function resetVibesCaches() {
  accountsCache = { rows: [], fetchedAt: 0 };
  projectCache.clear();
}

// ─── Project resolution per akun (retry 3x — daftar kadang kosong) ──
const projectCache = new Map(); // key → { value, fetchedAt }
export async function getVibesProjectId(account, force = false) {
  const now = Date.now();
  const cached = projectCache.get(account.key);
  if (!force && cached?.value && now - cached.fetchedAt < 60_000) return cached.value;
  const session = account.session_value;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${VIBES_BASE}/api/projects`, {
        headers: {
          Cookie: `meta_session=${session}; cookie_ack=true`,
          Referer: `${VIBES_BASE}/`,
          'User-Agent': UA,
        },
      });
      if (res.ok) {
        const projects = (await res.json())?.projects || [];
        if (projects.length > 0 && projects[0]?.id) {
          projectCache.set(account.key, { value: projects[0].id, fetchedAt: now });
          return projects[0].id;
        }
      }
    } catch { /* retry */ }
    await sleep(1200);
  }
  // Fallback: project tersimpan di DB (diisi extension)
  if (account.project_id) {
    projectCache.set(account.key, { value: account.project_id, fetchedAt: now });
    return account.project_id;
  }
  projectCache.set(account.key, { value: VIBES_FALLBACK_PROJECT, fetchedAt: now });
  return VIBES_FALLBACK_PROJECT;
}

// ─── POST tahan-flake untuk akun tertentu ─────────────
async function fetchAs(account, pathname, body) {
  let lastError = null;
  const projectId = await getVibesProjectId(account);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${VIBES_BASE}${pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: `meta_session=${account.session_value}; cookie_ack=true`,
          Referer: `${VIBES_BASE}/projects/${projectId}`,
          'User-Agent': UA,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) {
        const errorMsg = typeof data?.error === 'string' ? data.error
          : (data?.error?.title || data?.error?.detail || data?.message || `Permintaan server gagal: ${response.status}`);
        throw Object.assign(new Error(errorMsg), { status: response.status, data });
      }
      return data;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const message = String(error?.message || '').toLowerCase();
      const isRateLimit = status === 429 || /too many requests/.test(message);
      const retryable = [401, 403, 408, 429].includes(status) || status >= 500
        || /auth|session|unauthor|forbidden|timeout|timed out|fetch|socket|network|temporary/.test(message);
      if (!retryable || attempt >= 2) throw error;
      const delay = isRateLimit ? 6000 + attempt * 6000 : 1200 + attempt * 800;
      await sleep(delay);
    }
  }
  throw lastError || new Error('Permintaan server video gagal');
}

// ─── Upload media (multipart native — JANGAN set Content-Type manual) ──
async function uploadMediaAs(account, fileBuffer, mimeType, filename) {
  let lastError = null;
  const projectId = await getVibesProjectId(account);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const blob = new Blob([fileBuffer], { type: mimeType });
      const formData = new FormData();
      formData.append('file', blob, filename);
      const response = await fetch(`${VIBES_BASE}/api/upload-media`, {
        method: 'POST',
        headers: {
          Cookie: `meta_session=${account.session_value}; cookie_ack=true`,
          Referer: `${VIBES_BASE}/projects/${projectId}`,
          'User-Agent': UA,
        },
        body: formData,
      });
      const text = await response.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) {
        const err = new Error(typeof data?.error === 'string' ? data.error
          : (data?.error?.title || data?.error?.detail || 'Failed to upload media'));
        throw Object.assign(err, { status: response.status, data });
      }
      return data;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const message = String(error?.message || '').toLowerCase();
      const isRateLimit = status === 429 || /too many requests/.test(message);
      const retryable = [401, 403, 408, 429].includes(status) || status >= 500
        || /auth|session|unauthor|forbidden|timeout|timed out|fetch|socket|network|temporary/.test(message);
      if (!retryable || attempt >= 2) throw error;
      const delay = isRateLimit ? 6000 + attempt * 6000 : 1200 + attempt * 800;
      await sleep(delay);
    }
  }
  throw lastError || new Error('Upload media video gagal');
}

// ─── Retry wrapper anti-flake (batch create + generate) ──
const FLAKE_RE = /too many requests|couldn'?t generate|failed to create|fetch failed|socket|network|timed out|empty project list/i;

export async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      const msg = String(err?.message || '');
      const flake = [429, 500, 502, 503, 504].includes(status) || FLAKE_RE.test(msg);
      if (!flake || i === attempts - 1) throw err;
      const delay = 3000 + i * 2500;
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ─── Mapping batchId → akun (agar poll pakai akun yang membuat batch) ──
function batchMapFile() {
  return path.isAbsolute(BATCH_MAP_PATH) ? BATCH_MAP_PATH : path.resolve(process.cwd(), BATCH_MAP_PATH);
}

function readBatchMap() {
  try { return JSON.parse(fs.readFileSync(batchMapFile(), 'utf8')); } catch { return {}; }
}

function writeBatchMap(map) {
  try { fs.writeFileSync(batchMapFile(), JSON.stringify(map)); } catch { /* non-fatal */ }
}

function recordBatchAccount(batchId, key) {
  const map = readBatchMap();
  map[batchId] = { key, at: Date.now() };
  // buang mapping lama (> 24 jam) agar file tidak membengkak
  for (const [id, v] of Object.entries(map)) {
    if (Date.now() - (v.at || 0) > 24 * 3600_000) delete map[id];
  }
  writeBatchMap(map);
}

function getBatchAccountKey(batchId) {
  return readBatchMap()[batchId]?.key || null;
}

// ─── Status ────────────────────────────────────────────
export async function getVibesStatus() {
  try {
    const rows = await listVibesAccounts();
    const healthy = rows.filter((r) => !isCoolingDown(r.key)).length;
    return { connected: rows.length > 0, accounts: rows.length, active: healthy };
  } catch {
    return { connected: false, accounts: 0, active: 0 };
  }
}

// ─── Batch poll: cari di akun pembuat batch, fallback cari semua akun ──
// API daftar batch vibes.ai cukup flaky (kadang 500 / daftar kosong) —
// setiap percobaan akun diberi retry kecil.
export async function pollVibesBatch(batchId) {
  const rows = await listVibesAccounts();
  if (!rows.length) throw Object.assign(new Error('Server video tidak tersedia'), { status: 503 });
  const preferredKey = getBatchAccountKey(batchId);
  const ordered = [
    ...rows.filter((r) => r.key === preferredKey),
    ...rows.filter((r) => r.key !== preferredKey),
  ];
  let lastError = null;
  for (const row of ordered) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const projectId = await getVibesProjectId(row);
        const headers = {
          Accept: 'application/json',
          Cookie: `meta_session=${row.session_value}; cookie_ack=true`,
          Referer: `${VIBES_BASE}/projects/${projectId}`,
          'User-Agent': UA,
        };
        const response = await fetch(`${VIBES_BASE}/api/projects/${projectId}/batches?limit=50&offset=0`, { headers });
        const text = await response.text();
        let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (!response.ok) {
          throw Object.assign(new Error('Permintaan server video gagal'), { status: response.status, data });
        }
        const batch = (data?.batches || []).find((b) => b.id === batchId) || null;
        if (batch) return batch;
        // Daftar bisa kosong sesaat (flaky) — retry sebelum pindah akun
        if (attempt < 3) { await sleep(2000 + attempt * 1500); continue; }
        break;
      } catch (error) {
        lastError = error;
        const status = Number(error?.status || 0);
        if (isAuthError(error)) { markCooldown(row.key); break; }
        if ([429, 500, 502, 503, 504].includes(status) && attempt < 3) {
          await sleep(2000 + attempt * 1500);
          continue;
        }
        if (ordered.length === 1) throw error;
        break;
      }
    }
  }
  if (lastError && ordered.length === 1) throw lastError;
  return null;
}

function genUuid() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += hex[(Math.random() * 4) | 8];
    else s += hex[(Math.random() * 16) | 0];
  }
  return s;
}

// ─── Generate: t2v (text → video) & i2v (image → video), multi-akun ──
const DEFAULTS = {
  aspectRatio: '9:16',
  resolution: '720p',
  variations: 2,
  imageModel: 'midjen-base',
  videoModel: 'midjen-short',
  promptModel: 'gemini-2.5-flash',
};

export async function generateVibesVideo({ prompt, imageUrl, imageEntId, contentItemId, imageBase64, imageMimeType, ...opts }) {
  if (!prompt || !String(prompt).trim()) {
    throw Object.assign(new Error('Prompt wajib diisi'), { status: 400 });
  }
  const o = { ...DEFAULTS, ...opts };
  if (!ALLOWED_RESOLUTIONS.includes(o.resolution)) {
    throw Object.assign(new Error('Resolusi hanya 480p atau 720p'), { status: 400 });
  }
  const rows = await listVibesAccounts();
  if (!rows.length) {
    throw Object.assign(new Error('Server video belum siap. Hubungi admin.'), { status: 503 });
  }
  const promptText = String(prompt).trim();
  const maxTries = Math.min(rows.length, 3);
  let lastError = null;

  for (let tryIdx = 0; tryIdx < maxTries; tryIdx++) {
    const account = await pickVibesAccount(lastError && lastError.__triedKey);
    if (!account) break;
    try {
      const result = await generateWithAccount(account, promptText, o, { imageUrl, imageEntId, contentItemId, imageBase64, imageMimeType });
      clearCooldown(account.key);
      return result;
    } catch (error) {
      error.__triedKey = account.key;
      lastError = error;
      if (isAuthError(error)) {
        // akun bermasalah → cooldown lalu coba akun lain
        markCooldown(account.key);
        continue;
      }
      throw error; // error non-auth (kuota/validasi/server) — jangan pindah akun
    }
  }
  throw lastError || Object.assign(new Error('Tidak ada akun video yang tersedia'), { status: 503 });
}

async function generateWithAccount(account, promptText, o, media) {
  const { imageUrl, imageEntId, contentItemId, imageBase64, imageMimeType } = media;
  const vibesProjectId = await getVibesProjectId(account);

  let finalImageUrl = imageUrl;
  let finalImageEntId = imageEntId;
  let finalContentItemId = contentItemId;

  // i2v: upload + register bila imageBase64 diberikan
  if (imageBase64 && (!finalImageEntId || !finalImageUrl)) {
    const mime = imageMimeType || 'image/jpeg';
    const filename = `convert-${Date.now()}.${(mime.split('/')[1] || 'jpg')}`;
    const fileBuffer = Buffer.from(imageBase64, 'base64');
    if (!fileBuffer.length) throw Object.assign(new Error('imageBase64 kosong'), { status: 400 });
    const uploadData = await uploadMediaAs(account, fileBuffer, mime, filename);
    if (!uploadData.mediaEntId) throw Object.assign(new Error('Media gambar tidak ditemukan dari server'), { status: 500 });
    const regRes = await fetchAs(account, `/api/projects/${vibesProjectId}/upload`, {
      files: [{
        mediaEntId: uploadData.mediaEntId,
        uploadToken: uploadData.uploadToken,
        cdnUrl: uploadData.cdnUrl,
        filename,
        dimensions: uploadData.dimensions,
        aspectRatio: uploadData.aspectRatio,
      }],
    });
    const contentItem = regRes?.contentItems?.[0];
    finalImageEntId = uploadData.mediaEntId;
    finalImageUrl = contentItem?.imageUrl || uploadData.cdnUrl;
    finalContentItemId = contentItem?.id || null;
  }

  const isI2V = !!(finalImageUrl && finalImageEntId);
  const count = Math.min(Math.max(Number(o.variations) || 2, 1), 2);
  const now = new Date().toISOString();
  const batchId = `batch-${genUuid()}`;

  const config = {
    directGeneration: true,
    promptModel: o.promptModel,
    aspectRatio: o.aspectRatio,
    imageModel: o.imageModel,
    videoModel: o.videoModel,
    resolution: o.resolution,
    batchVariation: true,
    ...(isI2V ? {
      sourceContentItemIds: finalContentItemId ? [{ id: finalContentItemId, source: 'start_frame' }] : [],
      directPromptImageHandle: { image_url: finalImageUrl, image_ent_id: finalImageEntId, source: 'asset' },
    } : {}),
  };

  // 1) Batch placeholder
  await withRetry(() => fetchAs(account, '/api/generation-batches', {
    id: batchId,
    type: 'videos',
    prompt: promptText,
    timestamp: now,
    content: Array.from({ length: count }, (_, i) => ({ id: `${batchId}-content-${i}`, type: 'videos', isLoading: true })),
    isComplete: false,
    config,
    promptModel: o.promptModel,
    imageModel: o.imageModel,
    videoModel: o.videoModel,
    generationStartTime: now,
    isDirectGeneration: true,
    projectId: vibesProjectId,
  }));

  // 2) Trigger generate
  const inputs = isI2V
    ? Array.from({ length: count }, () => ({
        type: 'image',
        imageUrl: finalImageUrl,
        imageEntId: finalImageEntId,
        prompt: promptText,
        originalPrompt: promptText,
        config,
      }))
    : Array.from({ length: count }, () => ({
        type: 'prompt',
        value: promptText,
        original_prompt: promptText,
        config,
      }));

  const result = await withRetry(() => fetchAs(account, '/api/generate/videos', {
    inputs,
    config: { ...config, generationType: 't2v' },
    batchId,
    mg_request_id: `www-${genUuid()}`,
    projectId: vibesProjectId,
  }));

  recordBatchAccount(batchId, account.key);
  return { success: true, batchId, mode: isI2V ? 'i2v' : 't2v', result };
}
