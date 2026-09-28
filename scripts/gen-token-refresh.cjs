// gen-token-refresh.cjs — Refresh token dari pool (tanpa browser profile)
// Baca cookies dari token-pool.json, inject ke Camoufox, extract token baru, update pool
// Untuk akun yang di-import via Chrome extension (tidak punya browser profile di VPS)

const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const AUTOMATION_DIR = '/home/ubuntu/.9router/automation-runtime';
const POOL_FILE = '/home/ubuntu/work/gemini-proxy/token-pool.json';
const SCREENSHOT_DIR = '/home/ubuntu/google-profiles/screenshots';

// ⚠️ 28 Sep'26: akar kejadian pool 0 byte = disk penuh 11:31 (No space left on
// device) memotong file JSON saat ditulis. Tulis pool sekarang atomik, TAPI
// lebih baik dicegah: kalau sisa disk < 200 MB, JANGAN tulis sama sekali
// (lebih baik refresh ditunda daripada merusak pool untuk semua akun).
function assertDiskSpace() {
  const { execSync } = require('child_process');
  try {
    const kb = parseInt(execSync("df -Pk /home/ubuntu | tail -1 | awk '{print $4}'", { encoding: 'utf8' }).trim(), 10);
    const mb = Math.round(kb / 1024);
    if (kb < 200 * 1024) {
      throw new Error(`Sisa disk hanya ${mb} MB (<200 MB) — menolak menulis pool agar tidak terpotong. Bebaskan disk dulu.`);
    }
    return mb;
  } catch (e) {
    if (/Sisa disk/.test(e.message)) throw e;
    return null;
  }
}

const GEN_PROXY_URL = process.env.GEN_PROXY_URL || 'http://localhost:3100';
const GEN_EXTENSION_KEY = process.env.GEN_EXTENSION_KEY || '';
const ACCOUNT_LABEL = process.env.ACCOUNT_LABEL || '';

const COOKIE_NAMES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  'SIDCC',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  'LSID', '__Secure-ENID', 'NID',
  'ACCOUNT_CHOOSER', 'GAPS',
];

// ===== Read cookies from pool =====
// ⚠️ 28 Sep'26 — DIPERKUAT. Dulu fungsi ini langsung `throw` kalau file pool
// kosong/rusak atau label tidak ada. Akibatnya SEMUA cron refresh mati
// (19 job × error "Unexpected end of JSON input") dan pool tidak pernah sembuh
// sendiri — lingkaran setan, karena refresh butuh cookies DARI pool.
// Sekarang: (1) file kosong/rusak → pulihkan dari backup terbaru, (2) label
// tidak ada → pakai cookies dari profil browser akun itu (kalau masih login),
// baru menyerah dengan pesan jelas.
function latestPoolBackup() {
  const dir = path.dirname(POOL_FILE);
  const base = path.basename(POOL_FILE);
  try {
    const cands = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.backup') || f.startsWith(base + '.bak'))
      .map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return cands[0] || null;
  } catch { return null; }
}

function readPoolSafe() {
  try {
    const raw = fs.readFileSync(POOL_FILE, 'utf8');
    if (!raw.trim()) throw new Error('pool kosong');
    const pool = JSON.parse(raw);
    if (!Array.isArray(pool.accounts)) throw new Error('pool tanpa accounts');
    return pool;
  } catch (e) {
    const bak = latestPoolBackup();
    if (!bak) throw new Error(`pool rusak/kosong dan tidak ada backup: ${e.message}`);
    console.log(`⚠️  Pool rusak/kosong (${e.message}) → memakai backup ${path.basename(bak)}`);
    return JSON.parse(fs.readFileSync(bak, 'utf8'));
  }
}

// Cookies dari profil browser akun (dipakai kalau pool tidak punya entry-nya).
// Pool Omni (omni-accounts) HIDUP sebagai akun Google — dipakai sebagai cadangan.
function cookiesFromProfiles(label) {
  const roots = ['/home/ubuntu/google-profiles', '/home/ubuntu/omni-accounts/profiles'];
  const out = {};
  for (const root of roots) {
    for (const cand of [label, label.toLowerCase()]) {
      const p = path.join(root, cand, 'cookies.sqlite');
      if (fs.existsSync(p)) {
        try {
          const { execFileSync } = require('child_process');
          const rows = execFileSync('sqlite3', ['-separator', '\t', p,
            "SELECT name,value FROM moz_cookies WHERE host LIKE '%google.com'"], { encoding: 'utf8' });
          const map = {};
          for (const line of rows.split('\n')) {
            const [n, ...r] = line.split('\t');
            if (n && r.length) map[n] = r.join('\t');
          }
          if (Object.keys(map).length > 3) return map;
        } catch {}
      }
    }
  }
  return out;
}

function getCookiesFromPool(label) {
  const pool = readPoolSafe();
  const account = pool.accounts.find(a => a.label === label) || { label };
  const cookieStr = account.cookies
    || Object.entries(cookiesFromProfiles(label)).map(([n, v]) => `${n}=${v}`).join('; ');
  if (!cookieStr) {
    throw new Error(`Account "${label}" tidak punya cookies di pool maupun di profil browser`);
  }

  // Parse cookie string "SID=xxx; SAPISID=yyy; ..." into array
  const cookies = [];
  for (const part of cookieStr.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    const name = (rawName || '').trim();
    const value = rest.join('=');
    if (value && COOKIE_NAMES.includes(name)) {
      cookies.push({
        name,
        value,
        domain: '.google.com',
        path: '/',
        httpOnly: name.startsWith('__Secure'),
        secure: name.startsWith('__Secure'),
        sameSite: 'None',
      });
    }
  }
  return { cookies, account: { ...account, cookies: cookieStr } };
}

// ===== Token extraction =====
async function extractTokens(page) {
  const tokens = { at: null, bl: null, fSid: null, shareId: null, hl: null, url: page.url() };

  const allText = await page.evaluate(() => {
    let text = '';
    document.querySelectorAll('script').forEach(s => { text += (s.textContent || '') + '\n'; });
    text += '\n' + (document.documentElement?.outerHTML || '');
    return text;
  });

  const patterns = {
    at: [/"SNlM0e"\s*:\s*"([^"]+)"/, /'SNlM0e'\s*:\s*'([^']+)'/, /SNlM0e\s*=\s*"([^"]+)"/],
    bl: [/"cfb2h"\s*:\s*"([^"]+)"/, /'cfb2h'\s*:\s*'([^']+)'/, /cfb2h\s*=\s*"([^"]+)"/],
    fSid: [/"FdrFJe"\s*:\s*"([^"]+)"/, /'FdrFJe'\s*:\s*'([^']+)'/, /FdrFJe\s*=\s*"([^"]+)"/],
    hl: [/"hl"\s*:\s*"([a-z]{2}(?:-[A-Z]{2})?)"/, /'hl'\s*:\s*'([a-z]{2}(?:-[A-Z]{2})?)'/],
  };

  for (const [key, regexList] of Object.entries(patterns)) {
    for (const regex of regexList) {
      const m = allText.match(regex);
      if (m && m[1]) { tokens[key] = m[1]; break; }
    }
  }

  // WIZ_global_data fallback
  const globals = await page.evaluate(() => {
    const result = {};
    try { if (window.WIZ_global_data) { result.at = window.WIZ_global_data.SNlM0e || null; result.bl = window.WIZ_global_data.cfb2h || null; result.fSid = window.WIZ_global_data.FdrFJe || null; } } catch {}
    try { if (!result.at && typeof window.SNlM0e !== 'undefined') result.at = window.SNlM0e; } catch {}
    try { if (!result.bl && typeof window.cfb2h !== 'undefined') result.bl = window.cfb2h; } catch {}
    try { if (!result.fSid && typeof window.FdrFJe !== 'undefined') result.fSid = window.FdrFJe; } catch {}
    return result;
  });

  if (!tokens.at && globals.at) tokens.at = globals.at;
  if (!tokens.bl && globals.bl) tokens.bl = globals.bl;
  if (!tokens.fSid && globals.fSid) tokens.fSid = globals.fSid;

  const shareMatch = page.url().match(/\/share\/([a-f0-9]+)/i);
  if (shareMatch) tokens.shareId = shareMatch[1];

  return tokens;
}

// ===== Send to gen proxy =====
async function sendToProxy(data) {
  const payload = {
    at: data.at || null,
    bl: data.bl || null,
    fSid: data.fSid || null,
    shareId: data.shareId || null,
    hl: data.hl || 'id',
    cookies: data.cookies || null,
    url: data.url || '',
    label: ACCOUNT_LABEL,
    extensionKey: GEN_EXTENSION_KEY,
  };

  const response = await fetch(`${GEN_PROXY_URL}/v1/capture-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Proxy error: ${response.status} ${errText}`);
  }

  return response.json();
}

// ===== MAIN =====
async function main() {
  console.log('=== Gen Token Refresh (Pool → Camoufox → Pool) ===');
  console.log('Time:', new Date().toISOString());
  console.log('Label:', ACCOUNT_LABEL);
  console.log('Proxy:', GEN_PROXY_URL);

  if (!ACCOUNT_LABEL) {
    console.error('ERROR: ACCOUNT_LABEL not set');
    process.exit(1);
  }

  // Step 1: Read cookies from pool
  console.log('\n[1/4] Reading cookies from pool...');
  const { cookies, account } = getCookiesFromPool(ACCOUNT_LABEL);
  console.log(`✅ Found ${cookies.length} cookies for "${ACCOUNT_LABEL}"`);
  console.log(`   Last updated: ${account.lastUpdated || 'unknown'}`);

  if (cookies.length < 5) {
    console.error(`❌ Only ${cookies.length} cookies — not enough for login`);
    process.exit(1);
  }

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // Step 2: Launch Camoufox (non-persistent, inject cookies)
  console.log('\n[2/4] Launching Camoufox (fresh context, inject cookies)...');
  const camoufox = require(`${AUTOMATION_DIR}/node_modules/camoufox-js`);
  if (!camoufox?.launchOptions) {
    console.error('camoufox-js loaded but no launchOptions()');
    process.exit(1);
  }

  const camoufoxOptions = await camoufox.launchOptions({ headless: true });
  const browser = await firefox.launchPersistentContext(
    `/home/ubuntu/google-profiles/_refresh_${ACCOUNT_LABEL}`,
    {
      ...camoufoxOptions,
      headless: true,
      viewport: null,
      firefoxUserPrefs: {
        ...camoufoxOptions.firefoxUserPrefs,
        'security.sandbox.content.level': 0,
      },
    }
  );

  const pages = browser.pages();
  const page = pages[0] || await browser.newPage();

  try {
    // Inject cookies BEFORE navigating
    console.log('Injecting cookies...');
    await browser.addCookies(cookies);

    // Navigate to Gemini
    console.log('Navigating to gemini.google.com...');
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    let url = page.url();
    console.log('Current URL:', url);

    if (url.includes('accounts.google.com') || url.includes('signin')) {
      console.error('❌ Not logged in! Cookies may be expired.');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `refresh-${ACCOUNT_LABEL}-not-logged-in.png`) });
      process.exit(1);
    }

    // Step 3: Extract tokens
    console.log('\n[3/4] Extracting tokens...');
    let tokens = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`  Attempt ${attempt}/3...`);
      tokens = await extractTokens(page);
      if (tokens.at) {
        console.log('✅ Token "at" found:', tokens.at.substring(0, 20) + '...');
        break;
      }
      console.log('  Tokens not found, retrying...');
      await page.waitForTimeout(5000);
      if (attempt === 2) {
        console.log('  Reloading page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
      }
    }

    if (!tokens.at) {
      console.log('⚠️ No "at" token found, but continuing with cookies only');
    }

    // Get fresh cookies from browser (may be updated by Google)
    console.log('Extracting fresh cookies...');
    const allCookies = await browser.cookies();
    const cookieObj = {};
    for (const c of allCookies) {
      if (COOKIE_NAMES.includes(c.name) && !cookieObj[c.name]) {
        cookieObj[c.name] = c.value;
      }
    }
    const cookieString = Object.entries(cookieObj)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    console.log(`✅ Cookies: ${Object.keys(cookieObj).length} cookies captured`);

    // Step 4: Send to proxy
    console.log('\n[4/4] Sending to gen proxy...');
    const fullData = {
      ...tokens,
      cookies: cookieString,
      cookieCount: Object.keys(cookieObj).length,
      timestamp: Date.now(),
    };
    const result = await sendToProxy(fullData);
    console.log('✅ Sent to gen proxy! tokensReady:', result.tokensReady);
    console.log('Pool:', JSON.stringify(result.poolStats));

    // Summary
    console.log('\n=== REFRESH SUMMARY ===');
    console.log(`  account:  ${ACCOUNT_LABEL}`);
    console.log(`  at:       ${(tokens.at || 'NULL').substring(0, 30)}`);
    console.log(`  bl:       ${(tokens.bl || 'NULL').substring(0, 30)}`);
    console.log(`  fSid:     ${(tokens.fSid || 'NULL').substring(0, 30)}`);
    console.log(`  cookies:  ${Object.keys(cookieObj).length} cookies`);
    console.log(`  pool:     ${result.poolStats?.active}/${result.poolStats?.total} active`);
    console.log('=== DONE ===');

  } catch (error) {
    console.error('Error:', error.message);
    try {
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `refresh-${ACCOUNT_LABEL}-error.png`) });
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
    // Clean up temp profile
    try {
      fs.rmSync(`/home/ubuntu/google-profiles/_refresh_${ACCOUNT_LABEL}`, { recursive: true, force: true });
    } catch {}
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
