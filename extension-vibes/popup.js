// popup.js — config & status
const DEFAULT_URL = 'https://gen.azkazamdigital.com/v1/vibes/sync';

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['syncUrl', 'syncToken', 'accountLabel', 'lastStatus'], (r) => {
    document.getElementById('syncUrl').value = r.syncUrl || DEFAULT_URL;
    document.getElementById('syncToken').value = r.syncToken || '';
    document.getElementById('accountLabel').value = r.accountLabel || '';
    renderStatus(r.lastStatus);
  });

  document.getElementById('save').addEventListener('click', () => {
    const syncUrl = document.getElementById('syncUrl').value.trim() || DEFAULT_URL;
    const syncToken = document.getElementById('syncToken').value.trim();
    const accountLabel = document.getElementById('accountLabel').value.trim();
    chrome.storage.local.set({ syncUrl, syncToken, accountLabel }, () => {
      const btn = document.getElementById('save');
      btn.textContent = '✓ Tersimpan';
      setTimeout(() => { btn.textContent = 'Simpan'; }, 1500);
    });
  });

  document.getElementById('sync').addEventListener('click', () => {
    const btn = document.getElementById('sync');
    btn.textContent = 'Mengirim…';
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'MANUAL_SYNC' }, (resp) => {
      btn.textContent = 'Sync Sekarang';
      btn.disabled = false;
      chrome.storage.local.get(['lastStatus'], (r) => renderStatus(r.lastStatus));
    });
  });
});

function renderStatus(s) {
  const el = document.getElementById('status');
  if (!s) { el.textContent = ''; return; }
  el.textContent = s.msg;
  el.className = s.ok ? 'ok' : 'err';
}
