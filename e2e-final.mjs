// E2E produksi lewat jalur HTTP asli (butuh API key aktif dari api-keys.json).
import fs from 'node:fs';
const keysFile = JSON.parse(fs.readFileSync('/home/ubuntu/work/gemini-proxy/api-keys.json', 'utf8'));
const keys = Array.isArray(keysFile) ? keysFile : keysFile.keys || [];
const active = keys.filter(k => k.active && k.key);
if (!active.length) { console.log('tidak ada API key aktif'); process.exit(1); }
const chosen = active.find(k => k.label === 'playground') || active[0];
console.log('pakai key label:', chosen.label, '(aktif, tidak dicetak)');

const t0 = Date.now();
const r = await fetch('http://127.0.0.1:3100/v1/videos/omni', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chosen.key}` },
  body: JSON.stringify({ prompt: 'Buatkan iklan menarik: produk skincare di meja kayu, cahaya hangat, sinematik', ratio: '9:16', resolution: '768p', duration: 10, quality: 'TURBO' }),
});
const txt = await r.text();
console.log('HTTP', r.status, '|', Math.round((Date.now() - t0) / 1000) + 's');
let ok = false;
try {
  const d = JSON.parse(txt);
  if (r.ok) {
    ok = true;
    console.log('SUKSES | mode:', d.mode, '| akun:', d.account, '|', d.ratio, d.resolution, d.duration + 's', d.quality);
    for (const v of d.data || []) console.log('  video:', v.url, `${v.width}x${v.height}`);
    fs.writeFileSync('/tmp/e2e-video-fix.json', JSON.stringify({ at: new Date().toISOString(), ...d }, null, 1));
  } else console.log('GAGAL:', d.error);
} catch { console.log('non-JSON:', txt.slice(0, 300)); }
console.log('OK =', ok);
