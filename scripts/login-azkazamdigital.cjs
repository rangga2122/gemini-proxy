// login-azkazamdigital.cjs — Login akun kedua ke Camoufox profile
// Pakai xvfb-run untuk display virtual
const { firefox } = require('playwright');
const AUTOMATION_DIR = '/home/ubuntu/.9router/automation-runtime';
const PROFILE_DIR = '/home/ubuntu/google-profiles/azkazamdigital';
const SCREENSHOT_DIR = '/home/ubuntu/google-profiles/screenshots';

(async () => {
  const fs = require('fs');
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const camoufox = require(AUTOMATION_DIR + '/node_modules/camoufox-js');
  const opts = await camoufox.launchOptions({ headless: false });
  const browser = await firefox.launchPersistentContext(PROFILE_DIR, {
    ...opts,
    headless: false,
    viewport: null,
    firefoxUserPrefs: {
      ...opts.firefoxUserPrefs,
      'security.sandbox.content.level': 0,
    },
  });

  const page = browser.pages()[0] || await browser.newPage();
  console.log('Navigating to gemini.google.com/app...');
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);

  const url = page.url();
  console.log('URL:', url);

  if (url.includes('accounts.google.com') || url.includes('signin') || url.includes('ServiceLogin')) {
    console.log('NOT_LOGGED_IN — attempting login...');

    // Step 1: Email
    try {
      const emailInput = await page.waitForSelector('input[type="email"]', { timeout: 10000 });
      await emailInput.fill('azkazamdigital@gmail.com');
      console.log('Email filled');
      await page.screenshot({ path: SCREENSHOT_DIR + '/login-01-email.png' });

      // Click Next
      const nextBtn = await page.waitForSelector('button:has-text("Next"), #identifierNext', { timeout: 5000 });
      await nextBtn.click();
      await page.waitForTimeout(5000);
      console.log('After email Next, URL:', page.url());
      await page.screenshot({ path: SCREENSHOT_DIR + '/login-02-after-email.png' });
    } catch(e) {
      console.log('Email step:', e.message);
      await page.screenshot({ path: SCREENSHOT_DIR + '/login-02-email-error.png' });
    }

    // Step 2: Password
    try {
      const pwInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await pwInput.fill('Nr201105');
      console.log('Password filled');
      await page.screenshot({ path: SCREENSHOT_DIR + '/login-03-password.png' });

      const nextBtn2 = await page.waitForSelector('button:has-text("Next"), #passwordNext', { timeout: 5000 });
      await nextBtn2.click();
      await page.waitForTimeout(8000);
      console.log('After password Next, URL:', page.url());
      await page.screenshot({ path: SCREENSHOT_DIR + '/login-04-after-password.png' });
    } catch(e) {
      console.log('Password step:', e.message);
      await page.screenshot({ path: SCREENSHOT_DIR + '/login-04-password-error.png' });
    }

    // Check for verification challenge
    const finalUrl = page.url();
    if (finalUrl.includes('accounts.google.com') || finalUrl.includes('challenge')) {
      console.log('CHALLENGE_DETECTED — taking screenshot for vision analysis');
      await page.screenshot({ path: SCREENSHOT_DIR + '/login-05-challenge.png' });
      console.log('CHALLENGE_SCREENSHOT_READY');
    } else {
      console.log('LOGIN_SUCCESS — URL:', finalUrl);
    }
  } else {
    console.log('LOGGED_IN_ALREADY');
  }

  // Final screenshot
  await page.screenshot({ path: SCREENSHOT_DIR + '/login-final.png' });
  console.log('FINAL_URL:', page.url());
  console.log('DONE');

  // Keep browser open for 300s if challenge needs interaction
  if (page.url().includes('challenge') || page.url().includes('accounts.google.com')) {
    console.log('Waiting 300s for challenge resolution...');
    await page.waitForTimeout(300000);
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
