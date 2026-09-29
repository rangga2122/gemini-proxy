// server.js — Gemini Proxy Server
// OpenAI-compatible API untuk Gemini web (image, text, TTS)

// ─── Load .env file (manual, no dotenv dependency) ─────
import fs from 'node:fs';
import path from 'node:path';
try {
  const envPath = path.resolve(process.cwd(), '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
  console.log('[Config] .env loaded');
} catch (e) {
  // .env tidak wajib — env vars bisa lewat docker/systemd
}

import http from 'node:http';
import { getConfig, hasTokens, updateTokens, loadTokensFromSupabase,
         getNextAccount, upsertAccount, markCooldown, markError, resetAccount,
         removeAccount, listAccounts, getPoolStats, setRotationMode }
from './lib/tokens.js';
import { createKey, listKeys, revokeKey, activateKey, deleteKey,
         validateKey, hasKeys, getKeyStats }
from './lib/apikeys.js';
import { generateImage, generateImagesParallel, generateText, generateTTS, TTS_VOICES } from './lib/gemini.js';
import { normalizeImageInput, ImageInputError } from './lib/images.js';
import { generateImage as generateGptImage, loadLeonardoPool, poolSummary,
         listFreshSessions, getUserTokens, withLeonardoSession, LeonardoError, snapSize,
         generateVideo as generateLeoVideo, videoDimensions, LEO_VIDEO_MODEL,
         LEO_VIDEO_RESOLUTIONS, LEO_VIDEO_QUALITIES, LEO_VIDEO_DURATIONS }
from './lib/leonardo.js';
import { getVibesStatus, resetVibesCaches, upsertVibesSession } from './lib/vibes.js';
import { listPool as omniListPool, totalAccounts as omniTotal, getActive as omniGetActive, setActive as omniSetActive, stats as omniStats, setMode as omniSetMode } from './lib/omni-accounts.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 3000;

// ─── Static file serving (UI) ────────────────────────
const PUBLIC_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  // Alias rapi: /kelola-akun → kelola-akun.html
  if (urlPath === '/kelola-akun') urlPath = '/kelola-akun.html';
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  // Security: prevent path traversal
  filePath = filePath.replace(/\.\./g, '');

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────

// ─── Auth check (multi-key) ─────────────────────────────
function authCheck(req) {
  if (!hasKeys()) return true; // no keys configured = open access
  const auth = req.headers['authorization'] || '';
  const xkey = req.headers['x-api-key'] || '';
  const bearer = auth.replace(/^Bearer\s+/i, '');
  if (validateKey(bearer) || validateKey(xkey)) return true;
  // Fallback: dashboard_session dari login Gen Console (role admin) — utk endpoint admin omni-accounts
  try {
    const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
    const sess = cookies.find(c => c.startsWith('dashboard_session='));
    if (sess) {
      const token = sess.slice('dashboard_session='.length);
      const stateDir = process.env.MCP_STATE_DIR || '/home/ubuntu/work/gemini-proxy/mcp-state';
      const now = Date.now();
      for (const file of ['admin-sessions.json', 'dashboard-sessions.json']) {
        try {
          const sessions = JSON.parse(fs.readFileSync(stateDir + '/' + file, 'utf8'));
          const found = sessions.find(s => s.hash === crypto.createHash('sha256').update(token).digest('hex') && s.expiresAt > now);
          if (found && (file === 'admin-sessions.json' || found.role === 'admin')) return true;
        } catch {}
      }
    }
  } catch {}
  return false;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ─── Router ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // ─── Static UI (serve index.html for non-API paths) ──
  if (method === 'GET' && !path.startsWith('/v1/') && !path.startsWith('/api/')) {
    if (serveStatic(req, res, path)) return;
  }

  // ─── Health (API JSON) ────────────────────────────────
  if (path === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      name: 'gen-proxy',
      version: '2.0.0',
      status: 'online',
      tokensReady: hasTokens(),
      endpoints: [
        'POST /v1/images/generations     — generate image',
        'POST /v1/images/variations      — generate parallel images',
        'POST /v1/chat/completions       — text chat / image analysis',
        'POST /v1/audio/speech           — text-to-speech',
        'GET  /v1/tts/voices             — list available voices',
        'GET  /v1/status                 — token status',
        'POST /v1/capture-tokens         — receive token from extension',
      ],
    });
  }

  // ─── Public Pool Info (no auth, untuk UI) ────────────
  if (path === '/api/pool' && method === 'GET') {
    const stats = getPoolStats();
    const accounts = listAccounts();
    const currentAccount = accounts.find(a => a.status === 'active') || accounts[0];
    return sendJson(res, 200, {
      total: stats.total,
      active: stats.active,
      stale: stats.stale,
      cooldown: stats.cooldown,
      dead: stats.dead,
      rotationMode: stats.rotationMode,
      currentLabel: currentAccount ? currentAccount.label : '—',
      currentStatus: currentAccount ? currentAccount.status : '—',
      capturedAgo: currentAccount ? currentAccount.capturedAgo : '—',
      lastUsed: currentAccount ? currentAccount.lastUsed : '—',
      requestCount: currentAccount ? currentAccount.requestCount : 0,
    });
  }

  // ─── Simple public key generator untuk playground ─────
  if (path === '/api/key/generate' && method === 'POST') {
    const entry = createKey('playground');
    console.log(`[Keys] Playground key #${entry.id} created`);
    return sendJson(res, 201, { success: true, key: entry.key });
  }

  // ─── API Key Management (admin endpoints) ───────────
  // GET /api/keys  — list all keys (needs master key auth)
  // POST /api/keys — generate new key { label }
  // POST /api/keys/:id/revoke — revoke key
  // POST /api/keys/:id/activate — un-revoke key
  // DELETE /api/keys/:id — delete key permanently

  if (path === '/api/keys' && method === 'GET') {
    // Auth: butuh master key
    const auth = req.headers['authorization'] || '';
    const xkey = req.headers['x-api-key'] || '';
    const testKey = auth.replace(/^Bearer\s+/i, '') || xkey;
    const master = process.env['API' + '_KEY'] || '';
    if (!master || testKey !== master) {
      return sendJson(res, 401, { error: 'Admin access required. Use master key.' });
    }
    return sendJson(res, 200, { keys: listKeys(), stats: getKeyStats() });
  }

  if (path === '/api/keys' && method === 'POST') {
    // Auth: butuh master key
    const auth = req.headers['authorization'] || '';
    const xkey = req.headers['x-api-key'] || '';
    const testKey = auth.replace(/^Bearer\s+/i, '') || xkey;
    const master = process.env['API' + '_KEY'] || '';
    if (!master || testKey !== master) {
      return sendJson(res, 401, { error: 'Admin access required. Use master key.' });
    }
    const body = await readBody(req);
    const entry = createKey(body.label || '');
    console.log(`[Keys] Created key #${entry.id}: "${entry.label}" → ${entry.key.substring(0, 12)}…`);
    return sendJson(res, 201, { success: true, key: entry });
  }

  // /api/keys/:id/revoke
  const keyActionMatch = path.match(/^\/api\/keys\/(\d+)\/(revoke|activate)$/);
  if (keyActionMatch && method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const xkey = req.headers['x-api-key'] || '';
    const testKey = auth.replace(/^Bearer\s+/i, '') || xkey;
    const master = process.env['API' + '_KEY'] || '';
    if (!master || testKey !== master) {
      return sendJson(res, 401, { error: 'Admin access required' });
    }
    const id = parseInt(keyActionMatch[1]);
    const action = keyActionMatch[2];
    const ok = action === 'revoke' ? revokeKey(id) : activateKey(id);
    return sendJson(res, ok ? 200 : 404, { success: ok, message: ok ? `Key ${action}d` : 'Key not found' });
  }

  // DELETE /api/keys/:id
  const keyDeleteMatch = path.match(/^\/api\/keys\/(\d+)$/);
  if (keyDeleteMatch && method === 'DELETE') {
    const auth = req.headers['authorization'] || '';
    const xkey = req.headers['x-api-key'] || '';
    const testKey = auth.replace(/^Bearer\s+/i, '') || xkey;
    const master = process.env['API' + '_KEY'] || '';
    if (!master || testKey !== master) {
      return sendJson(res, 401, { error: 'Admin access required' });
    }
    const id = parseInt(keyDeleteMatch[1]);
    const ok = deleteKey(id);
    return sendJson(res, ok ? 200 : 404, { success: ok, message: ok ? 'Key deleted' : 'Key not found' });
  }

  // ─── Status (dengan pool info) ──────────────────────
  if (path === '/v1/status' && method === 'GET') {
    if (!authCheck(req)) return sendJson(res, 401, { error: 'Invalid API key' });
    const stats = getPoolStats();
    return sendJson(res, 200, {
      status: 'online',
      tokensReady: hasTokens(),
      pool: stats,
      timestamp: Date.now(),
    });
  }

  // ─── Admin: List accounts ───────────────────────────
  if (path === '/v1/accounts' && method === 'GET') {
    if (!authCheck(req)) return sendJson(res, 401, { error: 'Invalid API key' });
    return sendJson(res, 200, { accounts: listAccounts(), stats: getPoolStats() });
  }

  // ─── Admin: Add/Update account ──────────────────────
  if (path === '/v1/accounts' && method === 'POST') {
    if (!authCheck(req)) return sendJson(res, 401, { error: 'Invalid API key' });
    const body = await readBody(req);
    if (!body.at && !body.bl && !body.fSid) {
      return sendJson(res, 400, { error: 'at, bl, fSid are required' });
    }
    const result = upsertAccount(body);
    console.log(`[Admin] Account upserted: ${result.accountId} (${result.label})`);
    return sendJson(res, 200, { success: true, ...result });
  }

  // ─── Admin: Reset account (un-dead, clear cooldown) ──
  if (path.startsWith('/v1/accounts/') && path.endsWith('/reset') && method === 'POST') {
    if (!authCheck(req)) return sendJson(res, 401, { error: 'Invalid API key' });
    const accId = path.split('/')[3];
    if (resetAccount(accId)) {
      return sendJson(res, 200, { success: true, message: `Account ${accId} reset to active` });
    }
    return sendJson(res, 404, { error: 'Account not found' });
  }

  // ─── Admin: Remove account ──────────────────────────
  if (path.startsWith('/v1/accounts/') && method === 'DELETE') {
    if (!authCheck(req)) return sendJson(res, 401, { error: 'Invalid API key' });
    const accId = path.split('/')[3];
    if (removeAccount(accId)) {
      return sendJson(res, 200, { success: true, message: `Account ${accId} removed` });
    }
    return sendJson(res, 404, { error: 'Account not found' });
  }

  // ─── Admin: Set rotation mode ───────────────────────
  if (path === '/v1/rotation' && method === 'POST') {
    if (!authCheck(req)) return sendJson(res, 401, { error: 'Invalid API key' });
    const body = await readBody(req);
    if (setRotationMode(body.mode)) {
      return sendJson(res, 200, { success: true, mode: body.mode });
    }
    return sendJson(res, 400, { error: 'Invalid mode. Use: round-robin or least-used' });
  }

  // ─── Capture Tokens (dari Chrome Extension atau Camoufox) ──
  // Endpoint ini TIDAK butuh API key — extension capture pakai key internal
  if (path === '/v1/capture-tokens' && method === 'POST') {
    const body = await readBody(req);
    const { at, bl, fSid, shareId, hl, cookies, url: captureUrl, extensionKey, label } = body;

    // Extension harus kirim key internal — bisa master key atau generated key
    const expectedExtKey = process.env.EXTENSION_KEY || '';
    if (expectedExtKey) {
      if (extensionKey !== expectedExtKey && !validateKey(extensionKey)) {
        return sendJson(res, 403, { error: 'Invalid extension key' });
      }
    } else if (hasKeys()) {
      // Jika ada keys tapi tidak ada EXTENSION_KEY, validasi pakai key pool
      if (!validateKey(extensionKey)) {
        return sendJson(res, 403, { error: 'Invalid extension key' });
      }
    }

    const updated = updateTokens({ at, bl, fSid, shareId, hl, cookies, url: captureUrl, label });
    console.log(`[Capture] Token updated from ${label || 'extension'}: ${updated.join(', ')}`);

    return sendJson(res, 200, {
      success: true,
      message: `Tokens updated: ${updated.join(', ')}`,
      updated,
      tokensReady: hasTokens(),
      poolStats: getPoolStats(),
    });
  }

  // ─── Import Cookies (dari PC/Chrome export) ──
  // Endpoint simpel: hanya butuh label + cookies, tanpa auth
  // Om login di PC, export cookies via extension, POST ke sini
  if (path === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const { label, cookies } = body;

    if (!label || !cookies) {
      return sendJson(res, 400, { error: 'label dan cookies wajib diisi' });
    }

    // Validasi cookies mengandung minimal __Secure-1PSID atau SID
    const hasSid = cookies.includes('SID=') || cookies.includes('__Secure-1PSID=');
    const hasSapisid = cookies.includes('SAPISID=') || cookies.includes('__Secure-1PAPISID=');

    if (!hasSid || !hasSapisid) {
      return sendJson(res, 400, { error: 'Cookies tidak lengkap (SID/__Secure-1PSID atau SAPISID tidak ada). Pastikan sudah login Google.' });
    }

    // Extract token 'at' dari cookies jika ada
    // Untuk Gemini, 'at' token diambil dari halaman, bukan cookie
    // Tapi kita bisa capture via batchexecute nanti
    const updated = updateTokens({
      at: '', // akan di-capture otomatis oleh cronjob
      bl: '',
      fSid: '',
      shareId: '',
      hl: 'id',
      cookies: cookies,
      url: 'https://gemini.google.com/app',
      label: label
    });

    console.log(`[Import] Cookies imported from PC: ${label}`);

    return sendJson(res, 200, {
      success: true,
      message: `Cookies imported: ${label}`,
      label: label,
      poolStats: getPoolStats(),
    });
  }

  // ─── Vibes Session Sync (dari Chrome Extension) ─────
  // POST /v1/vibes/sync { session_value, projectId?, accountLabel?, valid? }
  // Auth: header x-vibes-sync-token = VIBES_SYNC_TOKEN env (bukan API key user)
  if (path === '/v1/vibes/sync' && (method === 'POST' || method === 'GET')) {
    const token = String(req.headers['x-vibes-sync-token'] || '');
    const expected = process.env.VIBES_SYNC_TOKEN || '';
    if (!expected || token.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return sendJson(res, 401, { success: false, error: 'unauthorized' });
    }
    if (method === 'GET') {
      try {
        const status = await getVibesStatus();
        return sendJson(res, 200, { success: true, ...status, timestamp: Date.now() });
      } catch (error) {
        return sendJson(res, 500, { success: false, error: error.message });
      }
    }
    try {
      const body = await readBody(req);
      const sessions = Array.isArray(body.sessions) && body.sessions.length
        ? body.sessions
        : [{ session_value: body.session_value, accountKey: body.accountKey, captured_at: body.captured_at }];
      let saved = 0;
      for (const item of sessions) {
        const sessionValue = String(item?.session_value || '').trim();
        if (!sessionValue) continue;
        // key stabil per akun = hash isi session (pola sama dengan RupaAI)
        const accountKey = String(item?.accountKey || '').trim()
          || crypto.createHash('sha256').update(sessionValue).digest('hex').slice(0, 24);
        await upsertVibesSession({
          key: accountKey,
          session_value: sessionValue,
          project_id: item?.projectId || body.projectId || null,
          username: body.username || null,
          account_status: body.account_status || null,
          source: 'chrome-extension',
          valid: typeof body.valid === 'boolean' ? body.valid : null,
        });
        saved++;
        console.log(`[VibesSync] Session tersimpan (key=${accountKey.slice(0, 16)}) dari ${body.accountLabel || 'extension'}`);
      }
      if (!saved) return sendJson(res, 400, { success: false, error: 'session_value kosong' });
      resetVibesCaches(); // cache akun basi → refresh di request berikutnya
      return sendJson(res, 200, { success: true, saved, message: 'Session tersimpan' });
    } catch (error) {
      console.error('[VibesSync] error:', error.message);
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  // ─── Pool JWT Leonardo: hub leonardo.azkazamdigital.com → Gen Console ───
  // POST /v1/leonardo/pool — hub push pool JWT (auth: Bearer master API_KEY).
  // Disimpan ke mcp-state/leonardo-pool.json sebagai sumber baca + fallback.
  if (path === '/v1/leonardo/pool' && method === 'POST') {
    if (!validateKey((req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '')) {
      return sendJson(res, 401, { error: 'Invalid API key' });
    }
    try {
      const body = await readBody(req);
      const incoming = Array.isArray(body) ? body : (body.sessions || []);
      if (!Array.isArray(incoming) || !incoming.length) return sendJson(res, 400, { error: 'sessions kosong' });

      const stateDir = process.env.MCP_STATE_DIR || '/home/ubuntu/work/gemini-proxy/mcp-state';
      const poolFile = stateDir + '/leonardo-pool.json';
      let current = { sessions: [], cursor: 0 };
      try { current = JSON.parse(fs.readFileSync(poolFile, 'utf8')); } catch { current = { sessions: [], cursor: 0 }; }

      const sessions = Array.isArray(current.sessions) ? [...current.sessions] : [];
      const idx = new Map(sessions.map((s, i) => [s.email || s.userSub, i]));
      let added = 0; let updated = 0;
      for (const inc of incoming) {
        const k = inc.email || inc.userSub;
        if (k && idx.has(k)) {
          const prev = sessions[idx.get(k)];
          sessions[idx.get(k)] = { ...prev, ...inc, lastUsedAt: prev.lastUsedAt || null };
          updated++;
        } else { sessions.push(inc); added++; }
      }
      const merged = { updatedAt: Date.now(), cursor: Number(body.cursor ?? current.cursor) || 0, sessions };
      // tulis atomik: file sementara lalu rename (hindari pool setengah jadi)
      fs.writeFileSync(poolFile + '.tmp', JSON.stringify(merged, null, 1));
      fs.renameSync(poolFile + '.tmp', poolFile);

      const nowSec = Date.now() / 1000;
      const freshCount = sessions.filter((s) => s.accessToken && !s.invalid && Number(s.tokenExp) > nowSec + 120).length;
      console.log(`[LeonardoPool] push dari ${body.source || 'hub'}: +${added} baru, ${updated} update, ${freshCount}/${sessions.length} fresh`);
      return sendJson(res, 200, { success: true, total: sessions.length, added, updated, fresh: freshCount });
    } catch (error) {
      console.error('[LeonardoPool] error:', error.message);
      return sendJson(res, 500, { error: error.message });
    }
  }

  // ─── Semua endpoint di bawah butuh API key ──────────
  if (!authCheck(req)) {
    return sendJson(res, 401, { error: 'Invalid or missing API key. Use Authorization: Bearer or X-API-Key header. Generate key at /api/keys (POST)' });
  }

  // Gerbang kolam token Gemini — HANYA untuk endpoint yang benar-benar memakai
  // kolam itu (generate gambar/teks Gemini).
  // ⚠️ BUG 28 Sep'26: dulu gerbang ini TANPA syarat, jadi begitu token-pool.json
  // rusak/kosong SEMUA endpoint di bawah balas 503 "Gemini tokens not configured"
  // — termasuk /api/omni-accounts (halaman /kelola-akun jadi tampak "tidak ada
  // data") dan /v1/images/gpt/accounts. Endpoint admin/status akun tidak butuh
  // token Gemini sama sekali, jadi jangan ikut diblokir.
  const bukanGateGemini = /^\/(api\/(omni-accounts|omni-autologin)|v1\/images\/gpt)/.test(path);
  if (!bukanGateGemini && !hasTokens()) {
    return sendJson(res, 503, {
      error: 'Gemini tokens not configured. Capture tokens first via Chrome extension (POST /v1/capture-tokens) or set in .env',
    });
  }

  // ─── Generate Image ──────────────────────────────────
  // POST /v1/images/generations
  // Body: { prompt, ratio?, seed?, referenceImage?, extraImages? }
  if (path === '/v1/images/generations' && method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.prompt) return sendJson(res, 400, { error: 'prompt is required' });

      const referenceImage = normalizeImageInput(body.image ?? body.referenceImage ?? null);
      const result = await generateImage({
        prompt: body.prompt,
        ratio: body.ratio || '1:1',
        seed: body.seed,
        referenceImage,
        extraImages: body.extraImages || [],
      });

      // OpenAI-compatible-ish response
      return sendJson(res, 200, {
        success: true,
        mode: referenceImage ? 'image-to-image' : 'text-to-image',
        seed: result.seed,
        image: result.image,
        text: result.text,
        // OpenAI-style format
        data: result.image
          ? [{ url: result.image.dataUrl, b64_json: result.image.base64, mimeType: result.image.mimeType }]
          : [],
      });
    } catch (error) {
      console.error('[Image] Error:', error.message);
      if (error instanceof ImageInputError) return sendJson(res, 400, { error: error.message });
      // If rate-limited, mark account for cooldown
      const cfg = getConfig();
      if (cfg._accountId && (error.message.includes('429') || error.message.includes('rate') || error.message.includes('OVERLOAD'))) {
        markCooldown(cfg._accountId, `image: ${error.message}`);
        console.log(`[Pool] Account ${cfg._accountId} → cooldown (rate-limit)`);
      } else if (cfg._accountId) {
        markError(cfg._accountId, error.message);
      }
      return sendJson(res, 500, { error: error.message });
    }
  }

  // ─── Generate Images Parallel ───────────────────────
  // POST /v1/images/variations
  // Body: { prompt, ratio?, count?, referenceImage?, extraImages? }
  if (path === '/v1/images/variations' && method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.prompt) return sendJson(res, 400, { error: 'prompt is required' });

      const referenceImage = normalizeImageInput(body.image ?? body.referenceImage ?? null);
      const results = await generateImagesParallel({
        prompt: body.prompt,
        ratio: body.ratio || '1:1',
        count: body.count || 4,
        referenceImage,
        extraImages: body.extraImages || [],
      });

      return sendJson(res, 200, {
        success: true,
        mode: referenceImage ? 'image-to-image' : 'text-to-image',
        count: results.filter(r => r.image).length,
        total: results.length,
        results,
        // OpenAI-style format
        data: results
          .filter(r => r.image)
          .map(r => ({ url: r.image.dataUrl, b64_json: r.image.base64, mimeType: r.image.mimeType })),
      });
    } catch (error) {
      console.error('[Parallel] Error:', error.message);
      if (error instanceof ImageInputError) return sendJson(res, 400, { error: error.message });
      return sendJson(res, 500, { error: error.message });
    }
  }

  // ─── GPT Image (Leonardo pool) ───────────────────────
  // POST /v1/images/gpt
  // Body: { prompt, model?, width?, height?, ratio?, size?, quantity?, quality?, promptEnhance?, image? }
  if (path === '/v1/images/gpt' && method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.prompt) return sendJson(res, 400, { error: 'prompt is required' });

      // ⚠️ Rasio di sini WAJIB sinkron dengan enum di mcp/lib/tools.js.
      // Rasio yang tidak ada di daftar DIAM-DIAM jatuh ke 9:16 (baris bawah),
      // jadi pengunjung bisa minta 4:5 tapi dapat 9:16 tanpa pesan galat.
      //
      // Dimensi ditulis EKSPLISIT per ukuran — JANGAN dikali rumus. Rumus
      // skala menghasilkan angka mentah (2036x1137) yang ditolak Leonardo,
      // dan setelah di-snap hasilnya bisa melenceng dari rasio yang diminta.
      // Semua angka di bawah ini ada di bank dimensi resmi Leonardo
      // (LEO_WIDTHS / LEO_HEIGHTS).
      //
      // ONGKOS (diukur 30 Sep'26, akun Leonardo FREE, kualitas MEDIUM):
      //   768x1376  -> 20 kredit
      //   1024x1280 -> 25 kredit
      //   1536x1920 -> 56 kredit
      // Saldo akun FREE = 150 kredit/gambar (subscriptionTokens).
      // Bawaan MEDIUM (permintaan Om 30 Sep'26): ~2 gambar/akun, jadi pool
      // 15 akun sehat ≈ 30 gambar sebelum rotasi perlu akun baru.
      // ⚠️ 4:5 TIDAK boleh 768x960 — angka 960 tidak ada di bank dimensi
      // Leonardo, dan snapSize akan menurunkannya ke 928 sehingga rasionya
      // jadi 0,83 (bukan 0,8). Pasangan yang benar-benar tepat 4:5 dan sah:
      // 1024x1280 (basis) dan 1536x1920 (medium).
      const RASIO_DIM = {
        '9:16': { SMALL: { w: 768, h: 1376 }, MEDIUM: { w: 1024, h: 1824 }, LARGE: { w: 1536, h: 1920 } },
        '16:9': { SMALL: { w: 1376, h: 768 }, MEDIUM: { w: 1824, h: 1024 }, LARGE: { w: 1920, h: 1536 } },
        '4:5':  { SMALL: { w: 1024, h: 1280 }, MEDIUM: { w: 1024, h: 1280 }, LARGE: { w: 1536, h: 1920 } },
      };
      const ar = RASIO_DIM[body.ratio] || RASIO_DIM['9:16'];
      // Bawaan MEDIUM ukuran + MEDIUM kualitas (permintaan Om 30 Sep'26).
      // Klien yang mengirim size/quality sendiri — termasuk Gen Console —
      // TIDAK terpengaruh, karena nilai dari body selalu menang.
      const ukuran = String(body.size || 'MEDIUM').toUpperCase();
      const dim = ar[ukuran] || ar.SMALL;
      // ⚠️ snapSize menerima {width, height} — bukan {w, h}. Salah nama kunci
      // membuat dimensinya NaN dan SEMUA permintaan gagal di sisi Leonardo
      // (ketahuan lewat uji 3 rasio 30 Sep'26).
      const snapped = snapSize({
        width: body.width || dim.w,
        height: body.height || dim.h,
      });
      const width = snapped.width;
      const height = snapped.height;

      const ref = normalizeImageInput(body.image ?? body.referenceImage ?? null);
      const result = await generateGptImage({
        prompt: body.prompt,
        width, height,
        quantity: Math.min(Math.max(parseInt(body.quantity) || 1, 1), 4),
        quality: ['LOW', 'MEDIUM', 'HIGH'].includes(String(body.quality).toUpperCase()) ? String(body.quality).toUpperCase() : 'MEDIUM',
        promptEnhance: ['OFF', 'AUTO', 'ON'].includes(String(body.promptEnhance).toUpperCase()) ? String(body.promptEnhance).toUpperCase() : 'AUTO',
        model: body.model || undefined,
        imageBase64: ref?.base64 || null,
        mimeType: ref?.mimeType || 'image/jpeg',
      });

      return sendJson(res, 200, {
        success: true,
        mode: ref ? 'image-to-image' : 'text-to-image',
        generationId: result.generationId,
        account: result.account,
        model: body.model || 'openai/gpt-image-2.5-sunburst',
        width, height,
        size: String(body.size || 'MEDIUM').toUpperCase(),
        quality: ['LOW', 'MEDIUM', 'HIGH'].includes(String(body.quality).toUpperCase()) ? String(body.quality).toUpperCase() : 'MEDIUM',
        data: result.images.map((img) => ({ url: img.url, b64_json: null, mimeType: 'image/png', width: img.width, height: img.height })),
      });
    } catch (error) {
      console.error('[GPT Image] Error:', error.message);
      if (error instanceof ImageInputError) return sendJson(res, 400, { error: error.message });
      if (error instanceof LeonardoError) return sendJson(res, error.status, { error: error.message });
      return sendJson(res, 500, { error: error.message });
    }
  }

  // ─── MENU VIDEO: Omni Video (Leonardo Hailuo 03) ─────────────────────
  // POST /v1/videos/omni  — text-to-video & image-to-video
  // Body: { prompt, ratio?('9:16'|'16:9'), resolution?('480p'|'768p'|'2k'|'4k'),
  //         duration?(6|10), quality?('TURBO'|'STANDARD'|'ACCELERATED'), image? }
  if (path === '/v1/videos/omni' && method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.prompt) return sendJson(res, 400, { error: 'prompt is required' });

      const ratio = ['9:16', '16:9'].includes(String(body.ratio)) ? String(body.ratio) : '9:16';
      const resolution = LEO_VIDEO_RESOLUTIONS.includes(String(body.resolution)) ? String(body.resolution) : '768p';
      const duration = LEO_VIDEO_DURATIONS.includes(Number(body.duration)) ? Number(body.duration) : 10;
      const quality = LEO_VIDEO_QUALITIES.includes(String(body.quality).toUpperCase()) ? String(body.quality).toUpperCase() : 'TURBO';
      const { width, height } = videoDimensions(ratio, resolution);

      const ref = normalizeImageInput(body.image ?? body.referenceImage ?? null);
      const result = await generateLeoVideo({
        prompt: body.prompt,
        ratio, resolution, duration, quality,
        model: body.model || LEO_VIDEO_MODEL,
        imageBase64: ref?.base64 || null,
        mimeType: ref?.mimeType || 'image/jpeg',
      });

      return sendJson(res, 200, {
        success: true,
        mode: result.mode,
        model: LEO_VIDEO_MODEL,
        generationId: result.generationId,
        account: result.account,
        ratio, resolution, duration, quality, width, height,
        cost: result.cost || null,
        coerced: result.coerced || false,
        note: result.note || null,
        data: result.videos.map((v) => ({ url: v.url, mimeType: 'video/mp4', width: v.width, height: v.height })),
      });
    } catch (error) {
      console.error('[Omni Video] Error:', error.message);
      if (error instanceof ImageInputError) return sendJson(res, 400, { error: error.message });
      if (error instanceof LeonardoError) {
        // 403/401 dari Leonardo = akun kena penolakan sisi mereka (bukan salah user).
        // withVideoSession sudah mencoba beberapa akun; kalau sampai ke sini semuanya kena.
        // Jangan bocorkan pesan mentah "Access denied" — beri pesan yang bisa ditindaklanjuti.
        if (error.status === 403 || error.status === 401) {
          return sendJson(res, 503, { error: 'Maaf akun video sedang disiapkan, silakan coba lagi 2–5 menit.' });
        }
        return sendJson(res, error.status, { error: error.message });
      }
      return sendJson(res, 500, { error: error.message });
    }
  }

  // GET /v1/images/gpt/accounts — status pool Leonardo (admin)
  if (path === '/v1/images/gpt/accounts' && method === 'GET') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    try {
      const pool = await loadLeonardoPool({ force: true });
      const fresh = await listFreshSessions();
      const accounts = (pool.sessions || []).map((s) => ({
        email: s.email || s.userSub,
        tokens: s.tokens ?? null,
        expiredInMin: Math.round(((Number(s.tokenExp) || 0) * 1000 - Date.now()) / 60000),
        exhausted: Boolean(s.exhaustedAt),
        fresh: fresh.some((f) => f.email === s.email),
        lastUsedAt: s.lastUsedAt || null,
      })).sort((a, b) => String(a.email).localeCompare(String(b.email)));
      return sendJson(res, 200, { success: true, ...poolSummary(pool), accounts });
    } catch (error) {
      return sendJson(res, 503, { success: false, error: error.message });
    }
  }

  // ─── Chat / Text / Vision ───────────────────────────
  // POST /v1/chat/completions
  // Body: { messages: [{role, content}], image? }
  // Atau: { prompt, referenceImage?, extraImages? }
  if (path === '/v1/chat/completions' && method === 'POST') {
    try {
      const body = await readBody(req);

      // Support 2 format: OpenAI-style messages atau simple prompt
      let prompt = '';
      let referenceImage = body.referenceImage || null;
      let extraImages = body.extraImages || [];

      if (body.messages && Array.isArray(body.messages)) {
        // OpenAI-style: ambil content dari messages
        prompt = body.messages
          .filter(m => m.role === 'user' || m.role === 'system')
          .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
          .join('\n\n');

        // Cari gambar di content array (OpenAI vision style)
        for (const m of body.messages) {
          if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part.type === 'image_url' && part.image_url?.url) {
                const url = part.image_url.url;
                if (url.startsWith('data:')) {
                  const match = url.match(/^data:(.+?);base64,(.*)/);
                  if (match) {
                    if (!referenceImage) {
                      referenceImage = { mimeType: match[1], base64: match[2] };
                    } else {
                      extraImages.push({ mimeType: match[1], base64: match[2] });
                    }
                  }
                }
              }
            }
          }
        }
      } else {
        prompt = body.prompt || '';
      }

      if (!prompt) return sendJson(res, 400, { error: 'prompt or messages is required' });

      const result = await generateText({ prompt, referenceImage, extraImages });

      // OpenAI-style response
      return sendJson(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gemini-3-flash',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.text || '' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        // Raw result juga
        text: result.text,
      });
    } catch (error) {
      console.error('[Chat] Error:', error.message);
      const cfg = getConfig();
      if (cfg._accountId && (error.message.includes('429') || error.message.includes('rate') || error.message.includes('OVERLOAD'))) {
        markCooldown(cfg._accountId, `chat: ${error.message}`);
      } else if (cfg._accountId) {
        markError(cfg._accountId, error.message);
      }
      return sendJson(res, 500, { error: error.message });
    }
  }

  // ─── TTS Voices ──────────────────────────────────────
  if (path === '/v1/tts/voices' && method === 'GET') {
    return sendJson(res, 200, { voices: TTS_VOICES });
  }

  // ─── Text-to-Speech ──────────────────────────────────
  // POST /v1/audio/speech
  // Body: { input, voice?, response_format? }
  // OpenAI-compatible TTS endpoint
  if (path === '/v1/audio/speech' && method === 'POST') {
    try {
      const body = await readBody(req);
      const text = body.input || body.text || '';
      if (!text) return sendJson(res, 400, { error: 'input (text) is required' });

      const voice = body.voice || 'Charon';
      const result = await generateTTS(text, voice);

      // OpenAI-style: return audio binary kalau response_format=wav
      // Tapi karena ini proxy, kita return base64 JSON untuk fleksibilitas
      return sendJson(res, 200, {
        success: true,
        audio: result.audio,
        voice: result.voice,
        textLength: result.textLength,
      });
    } catch (error) {
      console.error('[TTS] Error:', error.message);
      const cfg = getConfig();
      if (cfg._accountId && (error.message.includes('429') || error.message.includes('rate') || error.message.includes('OVERLOAD'))) {
        markCooldown(cfg._accountId, `tts: ${error.message}`);
      } else if (cfg._accountId) {
        markError(cfg._accountId, error.message);
      }
      return sendJson(res, 500, { error: error.message });
    }
  }

  // ─── Kelola Akun Omni (admin: master key ATAU dashboard session) ─────
  // Auth: (a) X-API-Key = OMNI_ADMIN_KEY/API_KEY, ATAU
  //       (b) cookie dashboard_session dari login Gen Console (role admin)
  async function omniAdminAuth(req) {
    const testKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
    // master key via lib/apikeys (API_KEY + OMNI_ADMIN_KEY)
    if (testKey && validateKey(testKey)) return true;
    // Dashboard session dari login Gen Console (role admin)
    try {
      const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
      const sess = cookies.find(c => c.startsWith('dashboard_session='));
      if (!sess) return false;
      const token = sess.slice('dashboard_session='.length);
      const stateDir = process.env.MCP_STATE_DIR || '/home/ubuntu/work/gemini-proxy/mcp-state';
      const now = Date.now();
      for (const file of ['admin-sessions.json', 'dashboard-sessions.json']) {
        let sessions = null;
        try {
          sessions = JSON.parse(fs.readFileSync(stateDir + '/' + file, 'utf8'));
        } catch { sessions = null; }
        if (!Array.isArray(sessions)) continue;
        const found = sessions.find(s => s.hash === crypto.createHash('sha256').update(token).digest('hex') && s.expiresAt > now);
        if (found) {
          if (file === 'admin-sessions.json') return true;
          if (found.role === 'admin') return true;
        }
      }
    } catch {}
    return false;
  }
  // GET  /api/omni-accounts          — list pool + stats
  // POST /api/omni-accounts/activate — { label } set akun aktif ke Omni engine
  // GET  /api/omni-accounts/active   — akun aktif sekarang
  if (path === '/api/omni-accounts' && method === 'GET') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    return sendJson(res, 200, { stats: omniStats(), accounts: omniListPool() });
  }

  if (path === '/api/omni-accounts/active' && method === 'GET') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    return sendJson(res, 200, { active: omniGetActive() });
  }

  if (path === '/api/omni-accounts/audit' && method === 'GET') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    try {
      if (!fs.existsSync('/tmp/omni-audit-state.json')) return sendJson(res, 200, { running: false, never: true, results: [] });
      return sendJson(res, 200, JSON.parse(fs.readFileSync('/tmp/omni-audit-state.json', 'utf8')));
    } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
  }

  if (path === '/api/omni-accounts/audit' && method === 'POST') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    try {
      if (fs.existsSync('/tmp/omni-audit-state.json')) {
        const st = JSON.parse(fs.readFileSync('/tmp/omni-audit-state.json', 'utf8'));
        if (st.running && Date.now() - (st.startedAt || 0) < 10 * 60 * 1000) {
          return sendJson(res, 200, { success: true, alreadyRunning: true });
        }
      }
      const child = spawn('python3', ['/home/ubuntu/omni-accounts/omni-audit.py'],
        { detached: true, stdio: 'ignore', env: { ...process.env } });
      child.unref();
      return sendJson(res, 200, { success: true, pid: child.pid });
    } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
  }

  // POST /api/omni-accounts/delete { labels:[...] } — hapus akun (pool+profil+daftar)
  if (path === '/api/omni-accounts/delete' && method === 'POST') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    const body = await readBody(req);
    const labels = (Array.isArray(body.labels) ? body.labels : []).filter(l => typeof l === 'string' && /^[A-Za-z0-9_.-]+$/.test(l));
    if (!labels.length) return sendJson(res, 400, { error: 'labels kosong / tidak valid' });
    try {
      const r = await new Promise((resolve) => {
        const child = spawn('python3', ['/home/ubuntu/omni-accounts/omni-hapus.py', ...labels]);
        let out = '', err = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => err += d);
        child.on('close', () => resolve({ out, err }));
      });
      let detail = {};
      try { detail = JSON.parse(r.out); } catch { detail = { raw: r.out.slice(0, 500), err: r.err.slice(0, 300) }; }
      console.log('[omni-accounts/delete]', labels.length, 'akun →', JSON.stringify(detail).slice(0, 300));
      return sendJson(res, 200, { success: true, ...detail });
    } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
  }

  if (path === '/api/omni-accounts/activate' && method === 'POST') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    const body = await readBody(req);
    if (!body.label) return sendJson(res, 400, { error: 'label is required' });
    const result = omniSetActive(body.label);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    console.log(`[Omni] Akun aktif diganti: ${result.label}`);
    return sendJson(res, 200, { success: true, ...result });
  }

  if (path === '/api/omni-accounts/mode' && method === 'POST') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    const body = await readBody(req);
    const result = omniSetMode(body.mode);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    console.log(`[Omni] Mode pembagian pool diganti: ${result.mode}${result.first ? ' (akun pertama: ' + result.first + ')' : ''}`);
    return sendJson(res, 200, { success: true, ...result });
  }

  if (path === '/api/omni-accounts/batch-status' && method === 'GET') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    let running = false, okCount = 0, total = 0;
    try {
      total = omniTotal();
      okCount = omniListPool().filter(a => a.ok).length;
      const lockPath = '/tmp/omni-batch-122.lock';
      let pidAlive = false;
      if (fs.existsSync(lockPath)) {
        try { process.kill(Number(fs.readFileSync(lockPath, 'utf8').trim()), 0); pidAlive = true; } catch {}
      }
      running = pidAlive;
    } catch {}
    return sendJson(res, 200, { running, okCount, total });
  }

  // ─── LOGIN OTOMATIS (form UI → capture batch) ─────────
  // GET  /api/omni-autologin/status  — batch jalan? progress? log terakhir?
  // POST /api/omni-autologin/start   — { accounts: "email1\\nemail2", password } → jalankan batch
  // POST /api/omni-autologin/stop    — kill batch berjalan
  if (path === '/api/omni-autologin/status' && method === 'GET') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    let running = false, pid = null, total = 0, okCount = 0, failCount = 0, lastLines = [];
    try {
      const lockPath = '/tmp/omni-batch-auto.lock';
      if (fs.existsSync(lockPath)) {
        const p = Number(fs.readFileSync(lockPath, 'utf8').trim());
        try { process.kill(p, 0); running = true; pid = p; } catch {}
      }
      const logPath = '/tmp/omni-autologin.log';
      if (fs.existsSync(logPath)) {
        const noise = /^\[pid|GFX1|Sandbox|JavaScript (warning|error)|^\s*⏳|^$/;
        const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
        lastLines = lines.filter(l => !noise.test(l)).slice(-60);
        const cur = lines.filter(l => l.startsWith('########'));
        total = cur.length || Number(fs.readFileSync('/home/ubuntu/omni-accounts/accounts-auto.txt', 'utf8').split('\n').filter(l => l.includes('@')).length);
        okCount = lines.filter(l => l.startsWith('OK ')).length;
        failCount = lines.filter(l => l.startsWith('FAIL ')).length;
      }
    } catch {}
    return sendJson(res, 200, { running, pid, total, okCount, failCount, log: lastLines });
  }

  if (path === '/api/omni-autologin/start' && method === 'POST') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    const body = await readBody(req);
    const accounts = String(body.accounts || '').split(/\n+/).map(s => s.trim()).filter(s => s.includes('@'));
    const password = String(body.password || '');
    if (!accounts.length) return sendJson(res, 400, { error: 'Daftar email kosong' });
    if (!password) return sendJson(res, 400, { error: 'Password wajib diisi' });
    const bad = accounts.filter(a => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
    if (bad.length) return sendJson(res, 400, { error: 'Format email tidak valid: ' + bad.slice(0, 3).join(', ') });
    // cegah duplikat jalan
    if (fs.existsSync('/tmp/omni-batch-auto.lock')) {
      try { process.kill(Number(fs.readFileSync('/tmp/omni-batch-auto.lock', 'utf8').trim()), 0);
        return sendJson(res, 409, { error: 'Batch login otomatis sudah berjalan' }); } catch {}
    }
    fs.writeFileSync('/home/ubuntu/omni-accounts/accounts-auto.txt', accounts.join('\n') + '\n', { mode: 0o600 });
    fs.writeFileSync('/home/ubuntu/omni-accounts/.auto_pw', password, { mode: 0o600 });
    const child = spawn('bash', ['batch-omni-auto.sh'], {
      cwd: '/home/ubuntu/omni-accounts',
      env: { ...process.env, ACCT_FILE: '/home/ubuntu/omni-accounts/accounts-auto.txt', LOGIN_PASSWORD: password },
      detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    console.log(`[Omni] Login otomatis dimulai: ${accounts.length} akun (pid ${child.pid})`);
    return sendJson(res, 200, { success: true, count: accounts.length, pid: child.pid });
  }

  if (path === '/api/omni-autologin/stop' && method === 'POST') {
    if (!(await omniAdminAuth(req))) return sendJson(res, 401, { error: 'Admin access required' });
    const lockPath = '/tmp/omni-batch-auto.lock';
    let stopped = false;
    if (fs.existsSync(lockPath)) {
      try {
        const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
        try { process.kill(-pid, 'SIGTERM'); } catch {}
        try { process.kill(pid, 'SIGTERM'); } catch {}
        stopped = true;
        // matikan juga child capture yang mungkin jalan
        try { spawn('pkill', ['-f', 'omni-token-capture.cjs'], { detached: true }).unref(); } catch {}
      } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
    return sendJson(res, 200, { success: stopped, message: stopped ? 'Batch dihentikan' : 'Tidak ada batch berjalan' });
  }

  // ─── 404 ────────────────────────────────────────────
  sendJson(res, 404, { error: 'Not found', path });
});

// ─── Start ───────────────────────────────────────────────

async function start() {
  // Load tokens dari Supabase jika dikonfigurasi
  await loadTokensFromSupabase();

  server.listen(PORT, () => {
    const stats = getPoolStats();
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║        Gen Proxy v2.0.0 (Pool)         ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`  Base URL:  http://localhost:${PORT}`);
    const kStats = getKeyStats();
    console.log(`  API Keys: ${kStats.master ? 'master ✓' : 'no master'} + ${kStats.active} generated (${kStats.revoked} revoked)`);
    console.log(`  Pool:      ${stats.active}/${stats.total} active (${stats.stale} stale, ${stats.cooldown} cooldown, ${stats.dead} dead)`);
    console.log(`  Mode:      ${stats.rotationMode}`);
    console.log(`  Pool file: ${stats.poolFile}`);
    console.log('');
    console.log('  Endpoints:');
    console.log('    POST /v1/images/generations   — generate image');
    console.log('    POST /v1/images/variations    — parallel images');
    console.log('    POST /v1/chat/completions     — text chat / vision');
    console.log('    POST /v1/audio/speech         — text-to-speech');
    console.log('    GET  /v1/tts/voices           — list voices');
    console.log('    GET  /v1/status               — pool status');
    console.log('    GET  /v1/accounts             — list accounts');
    console.log('    POST /v1/accounts             — add/update account');
    console.log('    POST /v1/accounts/:id/reset  — reset account');
    console.log('    DELETE /v1/accounts/:id       — remove account');
    console.log('    POST /v1/rotation             — set rotation mode');
    console.log('    POST /v1/capture-tokens       — extension/camoufox capture');
    console.log('');
    console.log(`  Listening on :${PORT}`);
    console.log('');
  });
}

start();
