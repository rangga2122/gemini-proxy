// gen-token-capture.js — Token capture untuk gen.azkazamdigital.com
// Menggunakan Camoufox (headless) dengan saved Google profile
// Kirim token ke gen proxy (localhost:3100) — NO Supabase
// Support multi-account: kirim label untuk identifikasi akun

const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const AUTOMATION_DIR = '/home/ubuntu/.9router/automation-runtime';
const PROFILE_DIR = '/home/ubuntu/google-profiles/harmitafbads';
const SCREENSHOT_DIR = '/home/ubuntu/google-profiles/screenshots';

// Gen proxy endpoint
const GEN_PROXY_URL = process.env.GEN_PROXY_URL || 'http://localhost:3100';
const GEN_EXTENSION_KEY = process.env.GEN_EXTENSION_KEY || '';

// Account label (untuk multi-account rotation)
const ACCOUNT_LABEL = process.env.ACCOUNT_LABEL || 'harmitafbads';

const CAPTURE_TIMEOUT = 120;

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

// ===== Send token ke gen proxy =====
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

  const result = await response.json();
  return result;
}

// ===== Token extraction (sama seperti RupaAI) =====
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

// ===== MAIN =====
async function main() {
  console.log('=== Gen Token Capture (Camoufox → gen proxy) ===');
  console.log('Time:', new Date().toISOString());
  console.log('Label:', ACCOUNT_LABEL);
  console.log('Proxy:', GEN_PROXY_URL);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const camoufox = require(`${AUTOMATION_DIR}/node_modules/camoufox-js`);
  if (!camoufox?.launchOptions) {
    console.error('camoufox-js loaded but no launchOptions()');
    process.exit(1);
  }

  const camoufoxOptions = await camoufox.launchOptions({ headless: true });

  console.log('Launching Camoufox with saved Google profile...');
  const browser = await firefox.launchPersistentContext(PROFILE_DIR, {
    ...camoufoxOptions,
    headless: true,
    viewport: null,
    firefoxUserPrefs: {
      ...camoufoxOptions.firefoxUserPrefs,
      'security.sandbox.content.level': 0,
    },
  });

  const pages = browser.pages();
  const page = pages[0] || await browser.newPage();

  try {
    // Navigate to Gemini
    console.log('Navigating to gemini.google.com...');
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    let url = page.url();
    console.log('Current URL:', url);

    if (url.includes('accounts.google.com') || url.includes('signin')) {
      console.error('❌ Not logged in! Redirected to:', url);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'gen-not-logged-in.png') });
      process.exit(1);
    }

    // Extract tokens (with retries)
    let tokens = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`Extracting tokens (attempt ${attempt}/3)...`);
      tokens = await extractTokens(page);
      if (tokens.at) {
        console.log('✅ Token "at" found:', tokens.at.substring(0, 20) + '...');
        break;
      }
      console.log('Tokens not found, waiting and retrying...');
      await page.waitForTimeout(5000);
      if (attempt === 2) {
        console.log('Reloading page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
      }
    }

    if (!tokens.at) {
      console.log('⚠️ No "at" token found, but continuing with cookies only');
    }

    // Get cookies
    console.log('Extracting cookies...');
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

    // Build full data
    const fullData = {
      ...tokens,
      cookies: cookieString,
      cookieCount: Object.keys(cookieObj).length,
      timestamp: Date.now(),
    };

    // Send to gen proxy (NOT Supabase)
    console.log('Sending to gen proxy...');
    const result = await sendToProxy(fullData);
    console.log('✅ Sent to gen proxy! tokensReady:', result.tokensReady);
    console.log('Pool:', JSON.stringify(result.poolStats));

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'gen-capture.png') });

    // Summary
    console.log('\n=== CAPTURE SUMMARY ===');
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
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'gen-error.png') });
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
