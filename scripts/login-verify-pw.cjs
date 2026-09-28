const { firefox } = require('playwright');
const fs = require('fs');

const EMAIL = process.env.LOGIN_EMAIL || '';
const PASSWORD = process.env.LOGIN_PASSWORD || '';
const PROFILE_DIR = process.env.PROFILE_DIR || '';
const LABEL = process.env.ACCOUNT_LABEL || EMAIL.split('@')[0];
const AUTOMATION_DIR = '/home/ubuntu/.9router/automation-runtime';
const SHOT_DIR = '/home/ubuntu/google-profiles/screenshots';
fs.mkdirSync(PROFILE_DIR, { recursive: true });

(async () => {
  const camoufox = require(AUTOMATION_DIR + '/node_modules/camoufox-js');
  const opts = await camoufox.launchOptions({ headless: false });
  const browser = await firefox.launchPersistentContext(PROFILE_DIR, {
    ...opts, headless: false, viewport: null,
    firefoxUserPrefs: { ...opts.firefoxUserPrefs, 'security.sandbox.content.level': 0 },
  });
  const page = browser.pages()[0] || await browser.newPage();
  const shot = async (n) => { try { await page.screenshot({ path: `${SHOT_DIR}/${LABEL}-${n}.png`, fullPage: true }); } catch {} };

  await page.goto('https://accounts.google.com/signin/v2/identifier?service=mail&passive=true&continue=https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  // EMAIL
  const emailInput = page.locator('#identifierId, input[type="email"], input[name="identifier"]').first();
  await emailInput.click();
  await page.evaluate((email) => {
    const input = document.querySelector('#identifierId, input[type="email"], input[name="identifier"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, email);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, EMAIL);
  await page.waitForTimeout(1000);
  await page.locator('#identifierNext').click();
  await page.waitForTimeout(5000);

  // PASSWORD
  const pwInput = page.locator('input[type="password"]').first();
  if (!(await pwInput.isVisible().catch(() => false))) {
    console.log('NO_PASSWORD_FIELD | URL:', page.url());
    await shot('pw-missing');
    const body = (await page.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,300);
    console.log('BODY:', body);
    await browser.close(); process.exit(2);
  }
  await pwInput.click();
  await page.evaluate((pw) => {
    const input = document.querySelector('input[type="password"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, pw);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, PASSWORD);
  await page.waitForTimeout(800);

  // VERIFIKASI nilai terisi
  const filled = await page.evaluate(() => {
    const i = document.querySelector('input[type="password"]');
    return { len: i.value.length, val: i.value };
  });
  console.log('PASS_FILLED_LEN:', filled.len, '| expected:', PASSWORD.length, '| match:', filled.val === PASSWORD);
  await shot('before-submit');
  await page.locator('#passwordNext').click();
  await page.waitForTimeout(6000);

  const body = (await page.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,400);
  console.log('AFTER_URL:', page.url());
  console.log('BODY:', body);
  await shot('after-submit');
  await browser.close();
})();
