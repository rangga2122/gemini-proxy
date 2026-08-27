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
