// popup.js — UI logic untuk popup extension
// Support multi-account: set label untuk identifikasi akun di pool

document.addEventListener('DOMContentLoaded', () => {
  // Load saved config
  chrome.storage.local.get(['proxyUrl', 'extKey', 'accountLabel', 'lastCapture', 'lastPoolStats'], (result) => {
    document.getElementById('proxyUrl').value = result.proxyUrl || 'https://gen.azkazamdigital.com/v1/capture-tokens';
    document.getElementById('extKey').value = result.extKey || '';
    document.getElementById('accountLabel').value = result.accountLabel || 'extension-default';

    if (result.lastCapture) {
      const ago = Math.round((Date.now() - result.lastCapture) / 1000);
      const status = document.getElementById('status');
      status.textContent = `✓ Last capture: ${ago}s ago`;
      status.style.color = '#10b981';
    }

    if (result.lastPoolStats) {
      const ps = result.lastPoolStats;
      document.getElementById('poolInfo').textContent =
        `Pool: ${ps.active}/${ps.total} active (${ps.stale} stale, ${ps.cooldown} cooldown)`;
    }
  });

  // Save config
  document.getElementById('save').addEventListener('click', () => {
    const proxyUrl = document.getElementById('proxyUrl').value;
    const extKey = document.getElementById('extKey').value;
    const accountLabel = document.getElementById('accountLabel').value || 'extension-default';

    chrome.storage.local.set({ proxyUrl, extKey, accountLabel }, () => {
      const btn = document.getElementById('save');
      btn.textContent = '✓ Saved!';
      setTimeout(() => { btn.textContent = 'Save'; }, 1500);
    });
  });

  // Manual capture
  document.getElementById('capture').addEventListener('click', () => {
    const btn = document.getElementById('capture');
    btn.textContent = 'Capturing...';
    btn.disabled = true;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].url || !tabs[0].url.includes('gemini.google.com')) {
        document.getElementById('status').textContent = '⚠ Buka gemini.google.com dulu';
        document.getElementById('status').style.color = '#f97316';
        btn.textContent = 'Capture Now';
        btn.disabled = false;
        return;
      }

      chrome.tabs.sendMessage(tabs[0].id, { type: 'MANUAL_CAPTURE' }, (response) => {
        if (chrome.runtime.lastError) {
          document.getElementById('status').textContent = '⚠ Content script tidak aktif';
          document.getElementById('status').style.color = '#ef4444';
        } else if (response && response.ok) {
          document.getElementById('status').textContent = '✓ Capture berhasil!';
          document.getElementById('status').style.color = '#10b981';
          chrome.storage.local.set({ lastCapture: Date.now() });
        } else {
          document.getElementById('status').textContent = '⚠ Capture gagal';
          document.getElementById('status').style.color = '#ef4444';
        }
        btn.textContent = 'Capture Now';
        btn.disabled = false;
      });
    });
  });

  // Open pool dashboard
  document.getElementById('dashboard').addEventListener('click', () => {
    const proxyUrl = document.getElementById('proxyUrl').value || 'https://gen.azkazamdigital.com';
    const baseUrl = proxyUrl.replace(/\/v1\/capture-tokens.*$/, '');
    chrome.tabs.create({ url: baseUrl });
  });
});
