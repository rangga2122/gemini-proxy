// Gen Console Export v1.1 — fix HttpOnly cookies via chrome.cookies API

const VPS_URL = 'https://gen.azkazamdigital.com';

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const exportBtn = document.getElementById('exportBtn');
  const copyBtn = document.getElementById('copyBtn');
  const sendBtn = document.getElementById('sendBtn');
  const output = document.getElementById('output');
  const labelInput = document.getElementById('label');
  const cookieCount = document.getElementById('cookieCount');

  let exportedData = null;

  // Cek tab aktif
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || '';
    if (url.includes('gemini.google.com')) {
      statusEl.className = 'status ok';
      statusEl.textContent = '✓ Siap export dari gemini.google.com';
    } else {
      statusEl.className = 'status wait';
      statusEl.textContent = '⚠️ Buka gemini.google.com dulu';
    }
  });

  exportBtn.addEventListener('click', async () => {
    statusEl.className = 'status wait';
    statusEl.textContent = 'Capturing cookies...';

    try {
      // Pakai chrome.cookies API untuk ambil SEMUA cookies termasuk HttpOnly
      const allCookies = [];
      
      // Ambil cookies untuk semua domain Google
      const domains = [
        '.google.com',
        'google.com',
        '.gemini.google.com',
        'gemini.google.com',
        'accounts.google.com'
      ];

      for (const domain of domains) {
        const cookies = await chrome.cookies.getAll({ domain: domain });
        allCookies.push(...cookies);
      }

      // Juga ambil semua cookies yang url-nya mengandung google
      const geminiCookies = await chrome.cookies.getAll({ url: 'https://gemini.google.com' });
      allCookies.push(...geminiCookies);

      const googleCookies = await chrome.cookies.getAll({ url: 'https://google.com' });
      allCookies.push(...googleCookies);

      // Dedup by name
      const seen = new Set();
      const unique = [];
      for (const c of allCookies) {
        if (!seen.has(c.name)) {
          seen.add(c.name);
          unique.push(c);
        }
      }

      // Filter cookies penting
      const importantNames = [
        'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
        '__Secure-1PSID', '__Secure-3PSID',
        '__Secure-1PAPISID', '__Secure-3PAPISID',
        '__Secure-1PSIDTS', '__Secure-3PSIDTS',
        '__Secure-1PSIDCC', '__Secure-3PSIDCC',
        'SIDCC', 'LSID', 'NID', 'ACCOUNT_CHOOSER',
        '__Secure-OSID', 'OSID'
      ];

      const important = unique.filter(c => importantNames.includes(c.name));
      const others = unique.filter(c => !importantNames.includes(c.name));
      const finalCookies = [...important, ...others.filter(c => !important.find(i => i.name === c.name))];

      // Debug: tampilkan semua cookie names
      console.log('All cookies found:', unique.map(c => c.name));

      if (finalCookies.length === 0) {
        statusEl.className = 'status err';
        statusEl.textContent = '❌ Tidak ada cookies Google! Login dulu.';
        return;
      }

      const hasSid = finalCookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID');
      const hasSapisid = finalCookies.some(c => c.name === 'SAPISID' || c.name === '__Secure-1PAPISID' || c.name === '__Secure-3PAPISID');
      const hasSecure1PSID = finalCookies.some(c => c.name === '__Secure-1PSID');

      // Tampilkan detail untuk debugging
      const foundNames = finalCookies.map(c => c.name).join(', ');
      console.log('Important cookies:', foundNames);

      if (!hasSid) {
        statusEl.className = 'status err';
        statusEl.textContent = `❌ SID/__Secure-1PSID tidak ada. Found: ${finalCookies.length} cookies. Names: ${foundNames.substring(0, 200)}`;
        return;
      }
      if (!hasSapisid) {
        statusEl.className = 'status err';
        statusEl.textContent = `❌ SAPISID tidak ada. Found: ${finalCookies.length} cookies. Names: ${foundNames.substring(0, 200)}`;
        return;
      }

      // Format cookie string
      const cookieStr = finalCookies.map(c => `${c.name}=${c.value}`).join('; ');

      const label = labelInput.value.trim() || 'imported-' + Date.now();
      exportedData = {
        label: label,
        cookies: cookieStr,
        cookieCount: finalCookies.length,
        hasSid: hasSid,
        hasSapisid: hasSapisid,
        hasSecure1PSID: hasSecure1PSID
      };

      output.value = JSON.stringify(exportedData);
      output.style.display = 'block';
      cookieCount.textContent = `${finalCookies.length} cookies | 1PSID:${hasSecure1PSID ? '✓' : '✗'} | SAPISID:${hasSapisid ? '✓' : '✗'}`;
      cookieCount.style.display = 'block';
      copyBtn.style.display = 'block';
      sendBtn.style.display = 'block';

      statusEl.className = 'status ok';
      statusEl.textContent = `✓ ${finalCookies.length} cookies captured! Siap dikirim.`;

    } catch (err) {
      statusEl.className = 'status err';
      statusEl.textContent = '❌ Error: ' + err.message;
      console.error('Export error:', err);
    }
  });

  copyBtn.addEventListener('click', () => {
    if (!exportedData) return;
    output.select();
    document.execCommand('copy');
    statusEl.className = 'status ok';
    statusEl.textContent = '✓ Copied! Paste ke chat.';
  });

  sendBtn.addEventListener('click', async () => {
    if (!exportedData) return;
    statusEl.className = 'status wait';
    statusEl.textContent = 'Sending to VPS...';

    try {
      const resp = await fetch(VPS_URL + '/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: exportedData.label,
          cookies: exportedData.cookies
        })
      });

      const data = await resp.json();

      if (resp.ok) {
        statusEl.className = 'status ok';
        statusEl.textContent = `✓ Berhasil! ${data.message || 'Token masuk pool'}`;
      } else {
        statusEl.className = 'status err';
        statusEl.textContent = '❌ ' + (data.error || 'Gagal');
      }
    } catch (err) {
      // Fallback: copy ke clipboard
      output.select();
      document.execCommand('copy');
      statusEl.className = 'status err';
      statusEl.textContent = '⚠️ Gagal kirim. Sudah di-copy, paste ke chat.';
    }
  });
});
