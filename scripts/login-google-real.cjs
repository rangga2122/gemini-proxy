const { firefox } = require('playwright');
const fs = require('fs');

const EMAIL = process.env.LOGIN_EMAIL || '';
const PASSWORD = process.env.LOGIN_PASSWORD || '';
const PROFILE_DIR = process.env.PROFILE_DIR || '';
const LABEL = process.env.ACCOUNT_LABEL || EMAIL.split('@')[0];
const AUTOMATION_DIR = '/home/ubuntu/.9router/automation-runtime';
const SHOT_DIR = '/home/ubuntu/google-profiles/screenshots';
if (!EMAIL || !PASSWORD || !PROFILE_DIR) throw new Error('LOGIN_EMAIL, LOGIN_PASSWORD, PROFILE_DIR required');
fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

(async () => {
  const camoufox = require(AUTOMATION_DIR + '/node_modules/camoufox-js');
  const opts = await camoufox.launchOptions({ headless: false });
  const browser = await firefox.launchPersistentContext(PROFILE_DIR, {
    ...opts, headless: false, viewport: null,
    firefoxUserPrefs: { ...opts.firefoxUserPrefs, 'security.sandbox.content.level': 0 },
  });
  const page = browser.pages()[0] || await browser.newPage();
  const shot = async (name) => {
    try { await page.screenshot({ path: `${SHOT_DIR}/${LABEL}-${name}.png`, fullPage: true }); } catch {}
  };

  // Buka halaman login Google (paksa login, bukan gemini.app)
  console.log('[1/5] Buka Google login...');
  await page.goto('https://accounts.google.com/signin/v2/identifier?service=mail&passive=true&continue=https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await shot('01-login-page');
  console.log('URL:', page.url());

  // Step 1: Isi email
  console.log('[2/5] Isi email:', EMAIL);
  // Google sign-in v3: input[type="text"] id="identifierId", bukan type="email"
  const emailInput = page.locator('#identifierId, input[type="email"], input[name="identifier"]').first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.click();
    await page.waitForTimeout(500);
    await page.evaluate((email) => {
      const input = document.querySelector('#identifierId, input[type="email"], input[name="identifier"]');
      if (input) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, email);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      }
    }, EMAIL);
    await page.waitForTimeout(1000);
    await shot('02-email-filled');
    // Klik Next
    const nextBtn = page.locator('#identifierNext, button:has-text("Next"), button:has-text("Berikutnya")').first();
    await nextBtn.click();
    await page.waitForTimeout(5000);
  }
  console.log('After email URL:', page.url());
  await shot('03-after-email');

  // Cek error email
  const bodyText1 = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500);
  if (bodyText1.includes('Couldn\'t find') || bodyText1.includes('tidak ditemukan')) {
    console.log('ERROR: Email tidak ditemukan!');
    console.log('BODY:', bodyText1);
    await browser.close();
    process.exit(1);
  }

  // Step 2: Isi password
  console.log('[3/5] Isi password...');
  const passInput = page.locator('input[type="password"]');
  if (await passInput.isVisible().catch(() => false)) {
    await passInput.click();
    await page.waitForTimeout(500);
    await page.evaluate((pass) => {
      const input = document.querySelector('input[type="password"]');
      if (input) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, pass);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      }
    }, PASSWORD);
    await page.waitForTimeout(1000);
    await shot('04-password-filled');
    const passNext = page.locator('#passwordNext, button:has-text("Next"), button:has-text("Berikutnya")').first();
    await passNext.click();
    await page.waitForTimeout(8000);
  }
  console.log('After password URL:', page.url());
  await shot('05-after-password');

  const bodyText2 = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500);
  console.log('BODY:', bodyText2);

  // Cek error password
  if (bodyText2.includes('Wrong password') || bodyText2.includes('salah') || bodyText2.includes('Incorrect')) {
    console.log('ERROR: Password salah!');
    await browser.close();
    process.exit(1);
  }

  // Step 3: Tunggu challenge (2FA, device prompt, dll)
  if (page.url().includes('challenge') || bodyText2.includes('verify') || bodyText2.includes('Verify') || bodyText2.includes('konfirmasi') || bodyText2.includes('2-Step')) {
    console.log('[4/5] CHALLENGE DETECTED');
    console.log('CHALLENGE_URL:', page.url());
    
    // Extract nomor challenge (misal "52" atau "74")
    const numMatch = bodyText2.match(/Google sent a notification.*?Tap.*?on your phone.*?verify.*?(\d+)\s/);
    if (numMatch) {
      console.log('CHALLENGE_NUMBER:', numMatch[1]);
      console.log('>>> KONFIRMASI DI HP: tap "Yes" lalu tap angka ' + numMatch[1] + ' <<<');
    } else {
      // Coba ekstrak angka yang berdiri sendiri di body
      const numMatch2 = bodyText2.match(/2-Step Verification.*?(\d{2,3})\s/);
      if (numMatch2) {
        console.log('CHALLENGE_NUMBER:', numMatch2[1]);
        console.log('>>> KONFIRMASI DI HP: tap "Yes" lalu tap angka ' + numMatch2[1] + ' <<<');
      }
    }
    
    await shot('06-challenge');
    
    // Tunggu sampai user menyelesaikan challenge (max 10 menit)
    console.log('>>> TUNGGU KONFIRMASI HP (max 10 menit) <<<');
    let challengeDone = false;
    let lastUrl = page.url();
    for (let i = 0; i < 120; i++) {
      try {
        await page.waitForTimeout(5000);
      } catch (e) {
        await page.waitForTimeout(2000);
      }
      let currentUrl;
      try { currentUrl = page.url(); } catch { currentUrl = lastUrl; continue; }
      
      // Challenge selesai HANYA kalau hostname = gemini.google.com (bukan query string)
      try {
        const u = new URL(currentUrl);
        if (u.hostname === 'gemini.google.com' || u.hostname === 'www.google.com') {
          console.log('Challenge selesai! URL:', currentUrl);
          challengeDone = true;
          break;
        }
      } catch {}
      
      // Deteksi navigasi meskipun URL berubah dalam challenge
      if (currentUrl !== lastUrl) {
        console.log(`URL changed: ${currentUrl.substring(0, 100)}`);
        lastUrl = currentUrl;
      }
      
      // Log setiap 30 detik
      if (i % 6 === 0) {
        try {
          const challengeText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
          console.log(`Wait ${(i + 1) * 5}s | URL: ${currentUrl.substring(0, 80)} | Text: ${challengeText.substring(0, 150)}`);
        } catch {}
      }
    }
    if (!challengeDone) {
      console.log('CHALLENGE_TIMEOUT: tidak selesai dalam 10 menit');
    }
  } else {
    console.log('[4/5] No challenge needed');
  }

  // Step 4: Verifikasi login berhasil
  console.log('[5/5] Verifikasi login...');
  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  console.log('FINAL_URL:', finalUrl);
  await shot('08-final');

  // Cek apakah benar-benar di halaman gemini (sudah login)
  let finalHostname = '';
  try { finalHostname = new URL(finalUrl).hostname; } catch {}
  if (finalHostname === 'gemini.google.com') {
    // Cek cookies di browser context
    const cookies = await browser.cookies();
    const hasSid = cookies.some(c => c.name === 'SID');
    const hasSapisid = cookies.some(c => c.name === 'SAPISID');
    const hasSecure1PSID = cookies.some(c => c.name === '__Secure-1PSID');
    console.log('SID:', hasSid ? 'YES' : 'NO');
    console.log('SAPISID:', hasSapisid ? 'YES' : 'NO');
    console.log('__Secure-1PSID:', hasSecure1PSID ? 'YES' : 'NO');
    
    if (hasSid && hasSapisid) {
      console.log('LOGIN_SUCCESS');
    } else {
      console.log('LOGIN_INCOMPLETE: cookies tidak lengkap');
    }
  } else {
    console.log('LOGIN_INCOMPLETE: masih di', finalUrl);
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
