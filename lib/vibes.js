// lib/vibes.js — Vibes video generation untuk Gen Console
// Replika alur RupaAI (rupaai2-app proxy.js): session meta_session dari PostgreSQL
// vibes_sessions (key default), project resolve dengan retry, upload → register →
// batch → generate → poll. Free-tier vibes.ai — tanpa kuota Veo.

const VIBES_BASE = 'https://vibes.ai';
const VIBES_SESSION_KEY = process.env.VIBES_SESSION_KEY || 'default';
const VIBES_FALLBACK_PROJECT = process.env.VIBES_PROJECT_ID || 'f5d86de5-82f2-469e-9a1b-7bf5dc3c9994';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Session dari PostgreSQL RupaAI (vibes_sessions) ──
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
    // pg tersedia di runtime RupaAI; untuk Gen Console gunakan modul ini bila ada.
    const { Pool } = requirePg();
    pgPool = new Pool(pgConfig());
    pgPool.on('error', () => { pgPool = null; });
  }
  return pgPool;
}

function requirePg() {
  try { return require('pg'); }
  catch { throw new Error('Modul pg tidak tersedia di Gen Console'); }
}

export async function getVibesSessionRow() {
  const pool = getPool();
  const res = await pool.query(
    `SELECT session_value, project_id, username, valid, captured_at, synced_at
     FROM vibes_sessions WHERE key = $1 LIMIT 1`,
    [VIBES_SESSION_KEY]);
  return res.rows[0] || null;
}

let sessionCache = { value: null, fetchedAt: 0 };
export async function getVibesSession(force = false) {
  const now = Date.now();
  if (!force && sessionCache.value && now - sessionCache.fetchedAt < 60_000) return sessionCache.value;
  const row = await getVibesSessionRow();
  sessionCache = { value: row?.session_value || null, fetchedAt: now };
  return sessionCache.value;
}

export function resetVibesCaches() {
  sessionCache = { value: null, fetchedAt: 0 };
  projectCache = { value: null, fetchedAt: 0 };
}

// ─── Project resolution (retry 3x — vibes.ai kadang daftar kosong) ───
let projectCache = { value: null, fetchedAt: 0 };
export async function getVibesProjectId(force = false) {
  const now = Date.now();
  if (!force && projectCache.value && now - projectCache.fetchedAt < 60_000) return projectCache.value;
  const session = await getVibesSession();
  if (session) {
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
            projectCache = { value: projects[0].id, fetchedAt: now };
            return projects[0].id;
          }
        }
      } catch { /* retry */ }
      await sleep(1200);
    }
    // Fallback: project tersimpan di DB (diisi extension)
    try {
      const row = await getVibesSessionRow();
      if (row?.session_value && row?.project_id) {
        projectCache = { value: row.project_id, fetchedAt: now };
        return row.project_id;
      }
    } catch { /* fallback env */ }
  }
  projectCache = { value: VIBES_FALLBACK_PROJECT, fetchedAt: now };
  return VIBES_FALLBACK_PROJECT;
}

// ─── vibesFetch POST dengan retry tahan-flake ─────────
export async function vibesFetch(pathname, body) {
  let lastError = null;
  const projectId = await getVibesProjectId();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const session = await getVibesSession(attempt > 0);
      if (!session) {
        throw Object.assign(new Error('Server video tidak tersedia. Hubungi admin.'), { status: 503 });
      }
      const response = await fetch(`${VIBES_BASE}${pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: `meta_session=${session}; cookie_ack=true`,
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
      resetVibesCaches();
      const delay = isRateLimit ? 6000 + attempt * 6000 : 1200 + attempt * 800;
      await sleep(delay);
    }
  }
  throw lastError || new Error('Permintaan server video gagal');
}

// ─── Upload media (multipart native — JANGAN set Content-Type manual) ──
export async function uploadToVibesMedia(fileBuffer, mimeType, filename) {
  let lastError = null;
  const projectId = await getVibesProjectId();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const session = await getVibesSession(attempt > 0);
      if (!session) throw Object.assign(new Error('Server video tidak tersedia'), { status: 503 });
      const blob = new Blob([fileBuffer], { type: mimeType });
      const formData = new FormData();
      formData.append('file', blob, filename);
      const response = await fetch(`${VIBES_BASE}/api/upload-media`, {
        method: 'POST',
        headers: {
          Cookie: `meta_session=${session}; cookie_ack=true`,
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
      resetVibesCaches();
      const delay = isRateLimit ? 6000 + attempt * 6000 : 1200 + attempt * 800;
      await sleep(delay);
    }
  }
  throw lastError || new Error('Upload media video gagal');
}

// ─── Retry wrapper anti-flake (batch create + generate) ──
const VIBES_FLAKE_RE = /too many requests|couldn'?t generate|failed to create|project not found|fetch failed|socket|network|timed out|empty project list/i;

export async function withVibesRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = Number(err?.status || 0);
      const msg = String(err?.message || '');
      const flake = [429, 500, 502, 503, 504].includes(status) || VIBES_FLAKE_RE.test(msg);
      if (!flake || i === attempts - 1) throw err;
      const delay = 3000 + i * 2500;
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ─── Status / batch poll helpers ──────────────────────
export async function getVibesStatus() {
  try {
    const session = await getVibesSession();
    return { connected: !!session };
  } catch {
    return { connected: false };
  }
}

export async function pollVibesBatch(batchId) {
  const session = await getVibesSession();
  if (!session) throw Object.assign(new Error('Server video tidak tersedia'), { status: 503 });
  const projectId = await getVibesProjectId();
  const headers = {
    Accept: 'application/json',
    Cookie: `meta_session=${session}; cookie_ack=true`,
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
  return batch;
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

// ─── Generate: t2v (text → video) & i2v (image → video) ──
const DEFAULTS = {
  aspectRatio: '9:16',
  resolution: '720p',
  variations: 2,
  imageModel: 'midjen-base',
  videoModel: 'midjen-short',
  promptModel: 'gemini-2.5-flash',
};

export async function generateVibesVideo({ prompt, imageUrl, imageEntId, contentItemId, imageBase64, imageMimeType, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  if (!prompt || !String(prompt).trim()) {
    throw Object.assign(new Error('Prompt wajib diisi'), { status: 400 });
  }
  const promptText = String(prompt).trim();
  const vibesProjectId = await getVibesProjectId();

  let finalImageUrl = imageUrl;
  let finalImageEntId = imageEntId;
  let finalContentItemId = contentItemId;

  // i2v: upload + register bila imageBase64 diberikan
  if (imageBase64 && (!finalImageEntId || !finalImageUrl)) {
    const mime = imageMimeType || 'image/jpeg';
    const filename = `convert-${Date.now()}.${(mime.split('/')[1] || 'jpg')}`;
    const fileBuffer = Buffer.from(imageBase64, 'base64');
    if (!fileBuffer.length) throw Object.assign(new Error('imageBase64 kosong'), { status: 400 });
    const uploadData = await uploadToVibesMedia(fileBuffer, mime, filename);
    if (!uploadData.mediaEntId) throw Object.assign(new Error('Media gambar tidak ditemukan dari server'), { status: 500 });
    const regRes = await vibesFetch(`/api/projects/${vibesProjectId}/upload`, {
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
  await withVibesRetry(() => vibesFetch('/api/generation-batches', {
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

  const result = await withVibesRetry(() => vibesFetch('/api/generate/videos', {
    inputs,
    config: { ...config, generationType: 't2v' },
    batchId,
    mg_request_id: `www-${genUuid()}`,
    projectId: vibesProjectId,
  }));

  return { success: true, batchId, mode: isI2V ? 'i2v' : 't2v', result };
}
