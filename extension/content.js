// content.js — Berjalan di tab gemini.google.com
// Auto-capture token dari halaman Gemini dan kirim ke gen proxy server
// Support multi-account: label dikirim untuk identifikasi akun di pool

const PROXY_URL = 'https://gen.azkazamdigital.com/v1/capture-tokens';
const CAPTURE_INTERVAL_MS = 5 * 60 * 1000; // refresh tiap 5 menit

let lastCapture = null;

// ─── Get config from storage ─────────────────────────
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['proxyUrl', 'extKey', 'accountLabel'], (result) => {
      resolve({
        proxyUrl: result.proxyUrl || PROXY_URL,
        extKey: result.extKey || '',
        accountLabel: result.accountLabel || 'extension-default',
      });
    });
  });
}

// ─── Extract tokens dari halaman Gemini ──────────────
function extractTokens() {
  const tokens = {};

  const atEl = document.querySelector('input[name="at"]') ||
               document.querySelector('#at') ||
               document.querySelector('script')?.textContent?.match(/"at":"([^"]+)"/);
  if (atEl) {
    tokens.at = atEl.value || atEl[1];
  }

  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';

    if (!tokens.at) {
      const atMatch = text.match(/SNlM0e['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
      if (atMatch) tokens.at = atMatch[1];
    }

    if (!tokens.bl) {
      const blMatch = text.match(/cfb2h['"]?\s*[:=]\s*['"](boq_assistant[^'"]+)['"]/);
      if (blMatch) tokens.bl = blMatch[1];
    }

    if (!tokens.fSid) {
      const fSidMatch = text.match(/FdrFJe['"]?\s*[:=]\s*['"]([\d]+)['"]/);
      if (fSidMatch) tokens.fSid = fSidMatch[1];
    }

    if (!tokens.shareId) {
      const shareMatch = text.match(/share_id['"]?\s*[:=]\s*['"]([a-f0-9]+)['"]/i);
      if (shareMatch) tokens.shareId = shareMatch[1];
    }
  }

  try {
    if (window.WIZ_global_data) {
      if (!tokens.at && window.WIZ_global_data.SNlM0e) tokens.at = window.WIZ_global_data.SNlM0e;
      if (!tokens.fSid && window.WIZ_global_data.FdrFJe) tokens.fSid = window.WIZ_global_data.FdrFJe;
      if (!tokens.bl && window.WIZ_global_data.cfb2h) tokens.bl = window.WIZ_global_data.cfb2h;
    }
  } catch {}

  tokens.hl = document.documentElement.lang || 'id';

  return tokens;
}

// ─── Ambil cookies Gemini ────────────────────────────
async function getCookies() {
  try {
    return document.cookie || '';
  } catch {
    return '';
  }
}

// ─── Kirim token ke proxy server ──────────────────────
async function sendTokens(tokens, cookies) {
  if (!tokens.at || !tokens.fSid || !tokens.bl) {
    console.warn('[GenCapture] Token tidak lengkap, skip send:', Object.keys(tokens));
    return false;
  }

  const config = await getConfig();

  const payload = {
    at: tokens.at,
    bl: tokens.bl,
    fSid: tokens.fSid,
    shareId: tokens.shareId || 'c26c881da4e6',
    hl: tokens.hl || 'id',
    cookies: cookies,
    url: location.href,
    extensionKey: config.extKey,
    label: config.accountLabel,
  };

  try {
    const resp = await fetch(config.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (resp.ok && data.success) {
      lastCapture = Date.now();
      console.log('[GenCapture] ✓ Token terkirim:', data.updated.join(', '));
      console.log('[GenCapture] Pool:', JSON.stringify(data.poolStats));
      chrome.runtime.sendMessage({
        type: 'CAPTURE_SUCCESS',
        data: {
          ...data,
          label: config.accountLabel,
        },
      });
      return true;
    } else {
      console.error('[GenCapture] Server error:', data.error);
      chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: data.error });
      return false;
    }
  } catch (e) {
    console.error('[GenCapture] Gagal kirim:', e.message);
    chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: e.message });
    return false;
  }
}

// ─── Main capture function ───────────────────────────
async function capture() {
  console.log('[GenCapture] Scanning for tokens...');
  const tokens = extractTokens();
  const cookies = await getCookies();
  await sendTokens(tokens, cookies);
}

// ─── Auto-capture loop ────────────────────────────────
setTimeout(capture, 3000);
setInterval(capture, CAPTURE_INTERVAL_MS);

// Listen untuk manual trigger dari popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'MANUAL_CAPTURE') {
    capture().then(() => sendResponse({ ok: true, lastCapture }));
    return true;
  }
});

chrome.runtime.sendMessage({ type: 'CONTENT_READY', url: location.href });
