import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8').catch(error=>error.code==='ENOENT'?readFile(new URL('../../index.html',import.meta.url),'utf8'):Promise.reject(error));

test('MCP and user management views are mutually exclusive', () => {
  assert.doesNotMatch(html, /id="manageUsersLink"/);
  assert.match(html, /document\.getElementById\('adminMcp'\)\.hidden\s*=\s*id\s*!==\s*'pengguna'\s*\|\|\s*authSession\?\.role\s*!==\s*'admin'/);
  assert.match(html, /document\.getElementById\('mcpContent'\)\.hidden\s*=\s*id\s*===\s*'pengguna'/);
});

test('managed users see only online service status, never pool details', () => {
  assert.match(html, /id="userOnlineStatus"/);
  assert.match(html, /document\.getElementById\('userOnlineStatus'\)\.hidden\s*=\s*session\.role\s*===\s*'admin'/);
  assert.match(html, /document\.querySelector\('\.pool-bar'\)\.hidden\s*=\s*id\s*!==\s*'ringkasan'\s*\|\|\s*authSession\?\.role\s*!==\s*'admin'/);
  assert.match(html, /\.pool-bar\[hidden\]\{display:none!important\}/);
});

test('profile is role-aware and an exclusive dashboard view', () => {
  assert.match(html, /\['profil','Profil','profileView'\]/);
  assert.match(html, /id="profileView"/);
  assert.match(html, /profileView'\)\.hidden\s*=\s*id\s*!==\s*'profil'/);
  assert.match(html, /profil:'profileView'/);
  assert.match(html, /id="userProfileFields"/);
  assert.match(html, /id="adminProfileNote"/);
});

test('login asks for password or admin passkey and never API key', () => {
  assert.match(html, /Password \/ passkey admin/);
  assert.doesNotMatch(html, /Passkey \/ API Key/);
});

test('user owns API key lifecycle through profile endpoints', () => {
  assert.match(html, /id="myApiKey"/);
  assert.match(html, /class="simple-key" id="myApiKey"/);
  assert.doesNotMatch(html, /class="simple-key card"/);
  assert.match(html, /API Key Saya/);
  assert.match(html, /fetch\(`\$\{BASE\}\/profile\/api-key`,\s*\{\s*method:\s*'POST',\s*credentials:\s*'include'/);
  assert.match(html, /fetch\(`\$\{BASE\}\/profile\/api-key`,\s*\{\s*method:\s*'DELETE',\s*credentials:\s*'include'/);
  assert.match(html, /keyState\s*=\s*\{hasApiKey:true,keyId:data\.keyId,keyCreatedAt:data\.createdAt,rpmLimit:data\.rpmLimit,workerLimit:data\.workerLimit\};\s*renderMyKey\(keyState\);\s*revealRawKey\(data\.key\)/);
  assert.match(html, /finally\s*\{\s*setLoading\(btn,\s*false\);\s*if\(keyState\)\s*renderMyKey\(keyState\);\s*\}/);
  assert.doesNotMatch(html, /revealRawKey\(data\.key\);[\s\S]{0,200}loadProfile\(\)/);
  assert.match(html, /key\.startsWith\('cosmic-mcp-'\)/);
  assert.match(html, /renderMyKey\(\{hasApiKey:false\}\)/);
  assert.doesNotMatch(html, /(?:localStorage|sessionStorage)/);
});

test('profile password update validates and sends exact contract', () => {
  assert.match(html, /fetch\(`\$\{BASE\}\/profile`,\s*\{\s*credentials:\s*'include'/);
  assert.match(html, /\/profile\/password/);
  assert.match(html, /JSON\.stringify\(\{\s*currentPassword,\s*newPassword,\s*confirmPassword\s*\}\)/);
  assert.match(html, /newPassword\.length\s*<\s*10/);
});

test('admin creation/reset/revoke/delete use password-era contracts', () => {
  assert.match(html, /PASSWORD AWAL/);
  assert.match(html, /Kredensial disalin/);
  assert.match(html, /\/reset-password/);
  assert.match(html, /\/api-key`?,\s*\{\s*method:\s*'DELETE'/);
  assert.match(html, /Hapus Pengguna/);
  assert.doesNotMatch(html, /Nonaktifkan permanen|Rotasi key/);
});

test('admin configures per-account RPM and workers while statistics stay separated', () => {
  assert.match(html, /id="userRpmLimit"[^>]*min="1"[^>]*max="600"[^>]*value="60"/);
  assert.match(html, /id="userWorkerLimit"[^>]*min="1"[^>]*max="20"[^>]*value="5"/);
  assert.match(html, /adminFetch\('\/admin\/stats'\)/);
  assert.match(html, /rpmLimit:\s*data\.rpmLimit/);
  assert.match(html, /rpmLimit\s*=\s*Number\(rpmInput\.value\)/);
  assert.match(html, /workerLimit\s*=\s*Number\(workerInput\.value\)/);
  assert.match(html, /maxSessions, rpmLimit, workerLimit/);
  for (const id of ['usageOverall', 'usageImages', 'usageImageGenerate', 'usageImageEdit', 'usageVision', 'usageChat', 'usageAudio']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data\.workerLimit\?\?user\.workerLimit\?\?5/);
});

test('API response values are rendered through textContent', () => {
  assert.doesNotMatch(html, /innerHTML\s*=\s*(?:data|user|profile)/);
});

test('trial signup and OTP flow has its exact public contract', () => {
  for (const id of ['openTrial', 'loginTrial', 'trialScreen', 'trialSignupForm', 'trialEmail', 'trialPassword', 'trialConfirmPassword', 'trialOtpForm', 'trialOtp', 'trialMaskedEmail', 'trialResend', 'trialCountdown', 'trialError']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Mulai Trial Gratis 3 Hari/);
  assert.match(html, /Daftar Trial 3 Hari/);
  assert.match(html, /fetch\(`\$\{BASE\}\/auth\/trial\/request`,\s*\{\s*method:'POST'/);
  assert.match(html, /fetch\(`\$\{BASE\}\/auth\/trial\/verify`,\s*\{\s*method:'POST'/);
  assert.match(html, /JSON\.stringify\(\{email:trialFlow\.email,password,confirmPassword:password\}\)/);
  assert.doesNotMatch(html, /trialExpiresAt/);
  assert.match(html, /password\.length<10\|\|password\.length>1024/);
  assert.match(html, /\^\\d\{6\}\$/);
  assert.match(html, /clearTrialState\(\)/);
  assert.match(html, /Periksa Inbox atau folder Spam/);
  assert.doesNotMatch(html, /(?:localStorage|sessionStorage)/);
});

test('landing price and profile Pakasir extension flow are present',()=>{
  assert.match(html,/Rp35\.000/);assert.match(html,/60 request per menit/);assert.match(html,/5 Worker Paralel/);assert.match(html,/maksimal 5 request aktif bersamaan/);assert.match(html,/NANO BANANA TERBARU/);assert.match(html,/className='model-highlight'/);assert.match(html,/Model generate gambar Nano Banana terbaru/);assert.match(html,/id="billingBlock"/);assert.match(html,/id="billingQr"/);assert.match(html,/\/billing\/plan/);assert.match(html,/\/billing\/order/);assert.match(html,/Masa aktif baru ditambahkan ke sisa waktu/);assert.match(html,/setInterval\(\(\)=>checkBillingPayment\(false\),5000\)/);
});

test('landing public order uses data, QRIS, and paid-login stages with email and phone only',()=>{
  for(const id of ['priceOrder','orderScreen','publicOrderForm','orderEmail','orderPhone','publicOrderPayment','publicOrderQr','publicOrderAmount','publicOrderCheck','publicOrderThankYou','publicOrderAccessMessage','paidLoginForm','paidLoginEmail','paidLoginPassword','paidLoginError','publicOrderLogin'])assert.match(html,new RegExp(`id="${id}"`));assert.doesNotMatch(html,/id="(?:openOrder|orderPassword)"/);assert.match(html,/Order Paket Sekarang/);assert.match(html,/class="gen-order-dialog"/);assert.match(html,/Pesan Gen Console/);assert.match(html,/Lanjut Pembayaran QRIS/);assert.match(html,/password acak baru dikirim ke email/i);assert.match(html,/Pembayaran berhasil/);assert.match(html,/Password dari email/);assert.doesNotMatch(html,/data-order-step=/);assert.match(html,/#orderScreen\{position:fixed/);assert.match(html,/background:linear-gradient\(155deg,#181a20,#111318\)/);assert.match(html,/event\.target===event\.currentTarget/);assert.match(html,/event\.key==='Escape'/);assert.match(html,/Generate Gambar Unlimited/);assert.match(html,/AI Chat Unlimited/);assert.match(html,/TTS Unlimited/);assert.match(html,/Akun Private/);assert.match(html,/CHATBOT &amp; AI AGENT/);assert.match(html,/ANALISIS GAMBAR/);assert.match(html,/\/billing\/public\/order/);assert.match(html,/JSON\.stringify\(\{email,phone\}\)/);assert.match(html,/publicCheckoutConfigured/);assert.match(html,/credentialDeliveryStatus==='sent'/);assert.match(html,/Inbox, Promosi, atau Spam/);assert.match(html,/paidLoginForm'\)\.addEventListener\('submit'/);assert.doesNotMatch(html,/order\.status==='paid'&&order\.authenticated/);
});

test('trial and profile-only entitlement UI is gated and timers are cleaned up', () => {
  assert.match(html, /entitlement\s*===\s*'profile-only'/);
  assert.match(html, /\['profil','dokumentasi'\]\.includes\(id\)/);
  assert.match(html, /Masa Aktif Berakhir/);
  assert.match(html, /Perpanjang paket di bawah/);
  assert.match(html, /Trial Aktif/);
  assert.match(html, /Trial Habis/);
  assert.match(html, /Paket Aktif/);
  assert.match(html, /Paket Habis/);
  assert.match(html, /Akun Aktif/);
  assert.match(html, /clearInterval\(trialActiveTimer\)/);
  for (const id of ['trialStatusBox', 'trialStatusLabel', 'trialOriginalEnd', 'trialLiveCountdown', 'profileAccountType', 'profileTrialDates', 'profileCurrentExpiry', 'profileOnlyNotice']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('document IDs are unique and inline JavaScript parses', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});
