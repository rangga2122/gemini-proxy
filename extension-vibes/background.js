// background.js — Service worker: capture cookie meta_session dari vibes.ai
// dan kirim ke Gen Console. Multi-akun: tiap profile Chrome = akun terpisah.

const DEFAULT_SYNC_URL = 'https://gen.azkazamdigital.com/v1/vibes/sync';
const SYNC_INTERVAL_MINUTES = 30; // refresh session tiap 30 menit

// ─── Config ────────────────────────────────────────────
function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['syncUrl', 'syncToken', 'accountLabel'], (r) => {
      resolve({
        syncUrl: r.syncUrl || DEFAULT_SYNC_URL,
        syncToken: r.syncToken || '',
        accountLabel: r.accountLabel || '',
      });
    });
  });
}

// ─── Ambil cookie meta_session vibes.ai (httpOnly terbaca via cookies API) ──
function getCookie(url, name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url, name }, (cookie) => resolve(cookie ? cookie.value : null));
  });
}

// Nama akun dari cookie SBX_K / sesi vibes; fallback label manual
async function detectAccountName() {
  const sbx = await getCookie('https://vibes.ai/', 'SBX_K');
  if (sbx) return 'sbx-' + sbx.slice(0, 8);
  return null;
}

// ─── Kirim session ke Gen Console ──────────────────────
async function syncNow(manual = false) {
  const cfg = await getConfig();
  if (!cfg.syncToken) {
    setStatus({ ok: false, msg: 'Token sync belum diisi — buka popup extension' });
    return false;
  }

  const sessionValue = await getCookie('https://vibes.ai/', 'meta_session');
  if (!sessionValue) {
    setStatus({ ok: false, msg: 'Cookie meta_session tidak ditemukan. Login dulu ke vibes.ai di browser ini.' });
    return false;
  }

  // Nama akun: label manual jika diisi, else deteksi otomatis
  const accountName = cfg.accountLabel || (await detectAccountName()) || 'akun-vibes';

  try {
    const resp = await fetch(cfg.syncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vibes-sync-token': cfg.syncToken,
      },
      body: JSON.stringify({
        session_value: sessionValue,
        accountLabel: accountName,
        valid: true,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.success) {
      setStatus({ ok: true, msg: `✓ Tersinkron (${accountName}) — ${new Date().toLocaleTimeString()}`, accounts: data.saved });
      return true;
    }
    setStatus({ ok: false, msg: `✗ Server: ${data.error || resp.status}` });
    return false;
  } catch (e) {
    setStatus({ ok: false, msg: `✗ Gagal kirim: ${e.message}` });
    return false;
  }
}

// ─── Status di storage untuk popup ─────────────────────
function setStatus({ ok, msg, accounts }) {
  chrome.storage.local.set({ lastStatus: { ok, msg, accounts, at: Date.now() } });
}

// ─── Alarm: sync periodik ──────────────────────────────
chrome.alarms.create('vibes-sync', { periodInMinutes: SYNC_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vibes-sync') syncNow(false);
});

// Sync saat service worker aktif & saat vibes.ai tab dibuka
syncNow(false);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && /(^|\.)vibes\.ai$/.test(new URL(tab.url).hostname)) {
    setTimeout(() => syncNow(false), 3000); // beri waktu cookie terpasang
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'MANUAL_SYNC') {
    syncNow(true).then((ok) => sendResponse({ ok }));
    return true;
  }
});
