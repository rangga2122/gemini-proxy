/**
 * lib/leonardo-pool.js — Pool sesi Leonardo (dibaca dari hub leonardo.azkazamdigital.com).
 *
 * Dipisah dari leonardo.js agar modul lain (mis. MCP tools untuk video) bisa memakai
 * pool yang sama tanpa duplikasi logika rotasi/failover.
 */
import fs from 'node:fs';

export class LeonardoError extends Error {
  constructor(message, { status = 500, code = null } = {}) {
    super(message);
    this.name = 'LeonardoError';
    this.status = status;
    this.code = code;
  }
}

// Sumber pool: hub Leonardo (leonardo.azkazamdigital.com → :3130). Bukan RupaAI.
// Fallback terakhir: baca file pool yang di-push hub ke disk lokal.
const LEO_POOL_URL = process.env.LEO_POOL_URL || 'http://127.0.0.1:3130/api/pool';
const LEO_POOL_KEY_FILE = process.env.LEO_POOL_KEY_FILE || '/home/ubuntu/leo-dashboard/data/pool-auth-key';
const LEO_POOL_FALLBACK_FILE = process.env.LEO_POOL_FALLBACK_FILE || '/home/ubuntu/work/gemini-proxy/mcp-state/leonardo-pool.json';

const WIT_OFFSET_MS = 9 * 60 * 60 * 1000;
const witDay = (ms) => Math.floor((ms + WIT_OFFSET_MS) / 86400000);

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

export function isSessionFresh(s, bufferMs = 120000) {
  if (!s?.accessToken) return false;
  if (s.invalid) return false;
  if (s.exhaustedAt && witDay(Date.now()) <= witDay(Number(s.exhaustedAt))) return false;
  const exp = Number(s.tokenExp) || 0;
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
 *
 * Opsi:
 *  - maxAttempts : jumlah akun yang dicoba sebelum menyerah.
 *  - preferEmail : dahulukan akun tertentu (mis. sesi yang dipakai UI).
 *  - sortByTokens: urutkan kandidat dari saldo TERBESAR dulu. WAJIB untuk video,
 *                  karena 1 video bisa butuh 90–150 kredit dan akun bersaldo kecil
 *                  akan selalu 402 padahal akun lain masih penuh.
 */
export async function withLeonardoSession(fn, { maxAttempts = 5, preferEmail = null, sortByTokens = false } = {}) {
  const pool = await loadLeonardoPool();
  const sessions = (pool.sessions || []).filter((s) => isSessionFresh(s));
  if (!sessions.length) throw new LeonardoError('Tidak ada akun Leonardo yang siap (semua expired/habis)', { status: 503 });

  const start = Number(pool.cursor) || 0;
  let ordered = preferEmail
    ? [...sessions.filter((s) => s.email === preferEmail), ...sessions.filter((s) => s.email !== preferEmail)]
    : [...sessions.slice(start % sessions.length), ...sessions.slice(0, start % sessions.length)];
  if (sortByTokens) {
    // Saldo terbesar dulu; jika sama, dahulukan akun yang BELUM pernah dipakai.
    // Alasan: nilai `tokens` dari hub bisa BASI (diperbarui tiap 3 jam), sedangkan akun
    // yang belum pernah dipakai hampir pasti masih penuh — jadi lebih aman dicoba dulu.
    ordered = [...ordered].sort((a, b) => {
      const d = (Number(b.tokens) || 0) - (Number(a.tokens) || 0);
      if (d !== 0) return d;
      return (Number(a.lastUsedAt) || 0) - (Number(b.lastUsedAt) || 0);
    });
  }

  let lastErr = null;
  for (let i = 0; i < Math.min(maxAttempts, ordered.length); i++) {
    const s = ordered[i];
    try {
      return await fn(s.accessToken, s);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || '');
      // 402 = saldo akun ini TIDAK CUKUP untuk request ini → coba akun berikutnya.
      // PENTING: jangan tandai akun "habis" di sini. 402 hanya berarti kurang untuk
      // request INI; akun tersebut masih bisa dipakai request lebih murah (mis. gambar).
      const retryable =
        e?.status === 402 || e?.status === 429 || e?.status === 401 || e?.status === 403 ||
        /credit|token|quota|limit|unauthor|expired|insufficient/i.test(msg);
      if (!retryable) throw e;
    }
  }
  throw lastErr || new LeonardoError('Semua akun Leonardo gagal', { status: 502 });
}
