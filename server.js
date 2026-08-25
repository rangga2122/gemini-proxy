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
  return validateKey(bearer) || validateKey(xkey);
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

  // ─── Semua endpoint di bawah butuh API key ──────────
  if (!authCheck(req)) {
    return sendJson(res, 401, { error: 'Invalid or missing API key. Use Authorization: Bearer or X-API-Key header. Generate key at /api/keys (POST)' });
  }

  if (!hasTokens()) {
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
