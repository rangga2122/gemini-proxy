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

test('login asks for password/passkey and never API key', () => {
  assert.match(html, /Password pengguna \/ passkey admin/);
  assert.doesNotMatch(html, /Passkey \/ API Key/);
});

test('user owns API key lifecycle through profile endpoints', () => {
  assert.match(html, /id="myApiKey"/);
  assert.match(html, /class="simple-key" id="myApiKey"/);
  assert.doesNotMatch(html, /class="simple-key card"/);
  assert.match(html, /API Key Saya/);
  assert.match(html, /fetch\(`\$\{BASE\}\/profile\/api-key`,\s*\{\s*method:\s*'POST',\s*credentials:\s*'include'/);
  assert.match(html, /fetch\(`\$\{BASE\}\/profile\/api-key`,\s*\{\s*method:\s*'DELETE',\s*credentials:\s*'include'/);
  assert.match(html, /keyState\s*=\s*\{hasApiKey:true,keyId:data\.keyId,keyCreatedAt:data\.createdAt,rpmLimit:data\.rpmLimit\};\s*renderMyKey\(keyState\);\s*revealRawKey\(data\.key\)/);
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

test('admin configures per-account RPM, profile shows two workers, and statistics stay separated', () => {
  assert.match(html, /id="userRpmLimit"[^>]*min="1"[^>]*max="600"[^>]*value="60"/);
  assert.match(html, /adminFetch\('\/admin\/stats'\)/);
  assert.match(html, /rpmLimit:\s*data\.rpmLimit/);
  assert.match(html, /rpmLimit\s*=\s*Number\(rpmInput\.value\)/);
  for (const id of ['usageOverall', 'usageImages', 'usageImageGenerate', 'usageImageEdit', 'usageVision', 'usageChat', 'usageAudio']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Maks\. \$\{data\.workerLimit\?\?2\} request aktif/);
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
  assert.match(html,/Rp35\.000/);assert.match(html,/60 request per menit/);assert.match(html,/2 Worker Paralel/);assert.match(html,/maksimal 2 request aktif bersamaan/);assert.match(html,/id="billingBlock"/);assert.match(html,/id="billingQr"/);assert.match(html,/\/billing\/plan/);assert.match(html,/\/billing\/order/);assert.match(html,/Masa aktif baru ditambahkan ke sisa waktu/);assert.match(html,/setInterval\(\(\)=>checkBillingPayment\(false\),5000\)/);
});

test('landing public order collects account details and opens the console after payment',()=>{
  for(const id of ['priceOrder','orderScreen','publicOrderForm','orderEmail','orderPhone','orderPassword','publicOrderPayment','publicOrderQr','publicOrderCheck'])assert.match(html,new RegExp(`id="${id}"`));assert.doesNotMatch(html,/id="openOrder"/);assert.match(html,/Order Paket Sekarang/);assert.match(html,/password lama diganti setelah pembayaran berhasil/);assert.match(html,/Generate Gambar Unlimited/);assert.match(html,/AI Chat Unlimited/);assert.match(html,/TTS Unlimited/);assert.match(html,/Akun Private/);assert.match(html,/CHATBOT &amp; AI AGENT/);assert.match(html,/ANALISIS GAMBAR/);assert.match(html,/\/billing\/public\/order/);assert.match(html,/JSON\.stringify\(\{email,password,phone\}\)/);assert.match(html,/order\.status==='paid'&&order\.authenticated/);assert.match(html,/showDashboard\(order\)/);
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
