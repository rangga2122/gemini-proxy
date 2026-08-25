// login-raisrahman1986.cjs — Login akun ketiga ke Camoufox profile
const { firefox } = require('playwright');
const AUTOMATION_DIR = '/home/ubuntu/.9router/automation-runtime';
const PROFILE_DIR = '/home/ubuntu/google-profiles/raisrahman1986';
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

  let url = page.url();
  console.log('URL:', url);

  if (url.includes('accounts.google.com') || url.includes('signin') || url.includes('ServiceLogin')) {
    console.log('NOT_LOGGED_IN — attempting login...');

    // Step 1: Email
    try {
      const emailInput = await page.waitForSelector('input[type="email"]', { timeout: 10000 });
      await emailInput.fill('raisrahman1986@gmail.com');
      console.log('Email filled');
      await page.screenshot({ path: SCREENSHOT_DIR + '/rais-01-email.png' });

      const nextBtn = await page.waitForSelector('#identifierNext, button:has-text("Next")', { timeout: 5000 });
      await nextBtn.click();
      await page.waitForTimeout(5000);
      console.log('After email Next, URL:', page.url());
      await page.screenshot({ path: SCREENSHOT_DIR + '/rais-02-after-email.png' });
    } catch(e) {
      console.log('Email step:', e.message);
      await page.screenshot({ path: SCREENSHOT_DIR + '/rais-02-email-error.png' });
    }

    // Step 2: Password
    try {
      const pwInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await pwInput.fill('Nr201105');
      console.log('Password filled');
      await page.screenshot({ path: SCREENSHOT_DIR + '/rais-03-password.png' });

      const nextBtn2 = await page.waitForSelector('#passwordNext, button:has-text("Next")', { timeout: 5000 });
      await nextBtn2.click();
      await page.waitForTimeout(8000);
      console.log('After password Next, URL:', page.url());
      await page.screenshot({ path: SCREENSHOT_DIR + '/rais-04-after-password.png' });
    } catch(e) {
      console.log('Password step:', e.message);
      await page.screenshot({ path: SCREENSHOT_DIR + '/rais-04-password-error.png' });
    }

    // Step 3: Check for challenge
    const finalUrl = page.url();
    if (finalUrl.includes('challenge') || finalUrl.includes('accounts.google.com')) {
      console.log('CHALLENGE_DETECTED — waiting for possible OTP/verification');
      await page.screenshot({ path: SCREENSHOT_DIR + '/rais-05-challenge.png' });
      console.log('CHALLENGE_SCREENSHOT_READY');
      // Wait for challenge to resolve (up to 300s)
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(5000);
        const currentUrl = page.url();
        if (!currentUrl.includes('accounts.google.com') && !currentUrl.includes('challenge')) {
          console.log('CHALLENGE_RESOLVED — URL:', currentUrl);
          break;
        }
        if (i % 6 === 0) {
          await page.screenshot({ path: SCREENSHOT_DIR + '/rais-05-challenge.png' });
          console.log('CHALLENGE_STILL_WAITING — ' + (i*5) + 's elapsed');
        }
      }
    } else {
      console.log('LOGIN_SUCCESS — URL:', finalUrl);
    }
  } else {
    console.log('LOGGED_IN_ALREADY');
  }

  // Final check
  await page.waitForTimeout(3000);
  const finalUrl2 = page.url();
  await page.screenshot({ path: SCREENSHOT_DIR + '/rais-final.png' });
  console.log('FINAL_URL:', finalUrl2);

  if (finalUrl2.includes('gemini.google.com/app') || finalUrl2.includes('gemini.google.com')) {
    console.log('LOGIN_COMPLETE');
  } else {
    console.log('LOGIN_INCOMPLETE — may need manual challenge');
  }

  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
