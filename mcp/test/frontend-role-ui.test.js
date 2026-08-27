import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');

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

test('admin configures per-account RPM and sees separated feature totals', () => {
  assert.match(html, /id="userRpmLimit"[^>]*min="1"[^>]*max="600"[^>]*value="20"/);
  assert.match(html, /adminFetch\('\/admin\/stats'\)/);
  assert.match(html, /rpmLimit:\s*data\.rpmLimit/);
  assert.match(html, /rpmLimit\s*=\s*Number\(rpmInput\.value\)/);
  for (const id of ['usageOverall', 'usageImages', 'usageImageGenerate', 'usageImageEdit', 'usageVision', 'usageChat', 'usageAudio']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Maks\. 1 request aktif/);
});

test('API response values are rendered through textContent', () => {
  assert.doesNotMatch(html, /innerHTML\s*=\s*(?:data|user|profile)/);
});
