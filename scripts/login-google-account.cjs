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
  const shot = async name => page.screenshot({path:`${SHOT_DIR}/${LABEL}-${name}.png`, fullPage:true}).catch(()=>{});
  await page.goto('https://gemini.google.com/app', {waitUntil:'domcontentloaded', timeout:45000});
  await page.waitForTimeout(5000);
  console.log('START_URL:', page.url());
  if (!page.url().includes('accounts.google.com')) {
    console.log('LOGGED_IN_ALREADY'); await shot('logged-in'); await browser.close(); return;
  }
  const email = page.locator('input[type=email]').first();
  if (await email.isVisible().catch(()=>false)) {
    await email.fill(EMAIL); await shot('email');
    await page.locator('#identifierNext, button:has-text("Next")').first().click();
    await page.waitForTimeout(5000);
  }
  console.log('AFTER_EMAIL_URL:', page.url());
  const password = page.locator('input[type=password]').first();
  if (await password.isVisible().catch(()=>false)) {
    await password.fill(PASSWORD); await shot('password');
    await page.locator('#passwordNext, button:has-text("Next")').first().click();
    await page.waitForTimeout(8000);
  }
  console.log('AFTER_PASSWORD_URL:', page.url());
  await shot('after-password');
  const body = (await page.locator('body').innerText().catch(()=>'' )).replace(/\s+/g,' ').slice(0,1200);
  console.log('PAGE_TEXT:', body);
  if (page.url().includes('challenge')) {
    console.log('CHALLENGE_DETECTED');
    for (let i=0;i<60;i++) {
      await page.waitForTimeout(5000);
      if (!page.url().includes('accounts.google.com')) break;
      if (i%3===0) { await shot('challenge'); console.log('CHALLENGE_WAIT', (i+1)*5); }
    }
  }
  console.log('FINAL_URL:', page.url());
  await shot('final');
  console.log(page.url().includes('gemini.google.com') ? 'LOGIN_COMPLETE' : 'LOGIN_INCOMPLETE');
  await browser.close();
})().catch(e=>{console.error('FATAL:',e.message);process.exit(1)});
