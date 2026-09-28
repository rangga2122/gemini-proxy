/**
 * lib/leo-video-pool.js — Sesi VIDEO dari pool terpisah (hub :3130 /api/video/*).
 *
 * Beda dengan leonardo-pool.js (pool GAMBAR):
 *   • Pool gambar dipilih dari daftar sesi yang di-push hub (round-robin di sisi Gen Console).
 *   • Pool video DIRESERVASI di hub (GET /api/video/reserve) supaya satu akun tidak
 *     dipakai dua request bersamaan, dan hub yang menghitung kuota harian per akun.
 *
 * Alur satu request video:
 *   1. reserve → hub beri { email, accessToken, videoAccountId, videoReserveId }
 *   2. pakai JWT itu untuk create generation
 *   3. laporkan hasil (POST /api/video/mark-used) — SUKSES atau gagal + status HTTP
 *   4. kalau gagal yang bisa diulang (401/402/403/429/503) → reserve lagi dengan exclude
 *
 * Semua kegagalan dilaporkan apa adanya ke hub, jadi hub bisa memutuskan:
 *   401 → token dibuang, akun di-mint ulang (kuota TIDAK hangus)
 *   402 → akun dianggap kosong untuk hari ini
 *   429 → akun cooldown beberapa menit
 *   400 → tidak ada yang hangus (konten ditolak, bukan kredit)
 */
import fs from 'node:fs';
import { LeonardoError } from './leonardo-pool.js';

const HUB = process.env.LEO_HUB_URL || 'http://127.0.0.1:3130';
const KEY_FILE = process.env.LEO_POOL_KEY_FILE || '/home/ubuntu/leo-dashboard/data/pool-auth-key';

function poolKey() {
  if (process.env.LEO_POOL_KEY) return process.env.LEO_POOL_KEY;
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

async function hubFetch(path, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const key = poolKey();
  const r = await fetch(HUB + path, {
    method,
    headers: { 'x-pool-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new LeonardoError(`Hub video HTTP ${r.status}: ${data?.error || text.slice(0, 120)}`, { status: r.status });
  return data;
}

/** Minta satu akun video siap pakai. exclude = akun yang sudah dicoba di request ini. */
export async function reserveVideoAccount(excludeIds = []) {
  const qs = excludeIds.length ? `?exclude=${encodeURIComponent(excludeIds.join(','))}` : '';
  return hubFetch('/api/video/reserve' + qs);
}

/** Laporkan hasil pemakaian akun video ke hub. */
export async function reportVideoUsage({ id, reserveId, ok, status, error, cost }) {
  try {
    return await hubFetch('/api/video/mark-used', {
      method: 'POST',
      body: { id, reserveId, ok, httpStatus: status, error, cost },
      timeoutMs: 15000,
    });
  } catch (e) {
    // Jangan gagalkan generate hanya karena laporan gagal — hub punya watchdog sendiri.
    return { ok: false, error: String(e.message).slice(0, 160) };
  }
}

export function videoPoolStats() {
  return hubFetch('/api/video/stats').catch(() => null);
}

/**
 * Jalankan fn(accessToken, session) dengan akun video yang DIRESERVASI.
 * Satu request = satu akun sampai akun itu benar-benar menerima/video selesai.
 *
 * onAccepted: dipanggil tepat saat Leonardo MENERIMA request (kredit terpakai saat itu).
 *             Di sinilah kuota akun dihanguskan + kredit dicatat.
 */
export async function withVideoSession(fn, { maxAttempts = 6, onAccepted = null, waitMs = 9000 } = {}) {
  const tried = [];
  let lastErr = null;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await reserveVideoAccount(tried);

    if (!res || !res.ok || !res.session) {
      const reason = res?.reason || 'no-token';
      // Stok kosong/busy BUKAN kegagalan permanen: hub sedang menyiapkan akun baru
      // (mint JWT ≈ 20 detik/akun). Tunggu sebentar lalu coba lagi, sampai maxAttempts.
      // Ini yang membuat 10 user generate BERSAMAAN tetap terlayani walau stok awal
      // lebih kecil dari jumlah permintaan.
      if ((reason === 'no-token' || reason === 'busy') && i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const human = {
        exhausted: 'Kuota video hari ini sudah habis (kredit akun Leonardo reset 00:00 WIT).',
        busy: 'Semua akun video sedang dipakai proses lain. Coba lagi sebentar.',
        'no-token': 'Akun video sedang disiapkan (mint JWT baru). Tunggu 1–2 menit lalu coba lagi.',
      }[reason] || res?.error || 'Belum ada akun video yang siap.';
      throw new LeonardoError(human, { status: 503, code: reason });
    }

    const s = res.session;
    tried.push(s.videoAccountId);

    let accepted = false;
    try {
      return await fn(s.accessToken, s, {
        // dipanggil generator tepat setelah Leonardo menerima job (kredit terpotong)
        markAccepted: async (cost) => {
          if (accepted) return;
          accepted = true;
          await reportVideoUsage({ id: s.videoAccountId, reserveId: s.videoReserveId, ok: true, status: 200, cost });
          if (onAccepted) await onAccepted(s, cost).catch(() => {});
        },
      });
    } catch (e) {
      lastErr = e;
      const st = Number(e?.status) || 0;

      // Kalau Leonardo sudah MENERIMA job, akun itu dianggap terpakai (kuota 1 akun
      // sudah dikonsumsi dari sudut pandang pemakaian). Kredit yang benar-benar
      // terpotong sudah dicatat lewat markAccepted(cost).
      // Catatan: kalau job berakhir FAILED, Leonardo ME-REFUND kreditnya (terbukti:
      // akun yang FAILED saldonya tetap 150), sehingga akun tetap sehat untuk besok.
      if (accepted) {
        if (st !== 0) await reportVideoUsage({ id: s.videoAccountId, reserveId: s.videoReserveId, ok: false, status: st, error: e.message });
        throw e;
      }

      await reportVideoUsage({ id: s.videoAccountId, reserveId: s.videoReserveId, ok: false, status: st, error: e.message });

      const retryable =
        st === 401 || st === 403 || st === 402 || st === 429 ||
        /credit|token|quota|limit|unauthor|expired|insufficient|402|429/i.test(String(e?.message || ''));
      if (!retryable) throw e;
    }
  }
  throw lastErr || new LeonardoError('Semua akun video gagal dipakai', { status: 502 });
}

export { LeonardoError };
