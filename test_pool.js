// test_pool.js — Test multi-account pool endpoints
import fs from 'node:fs';
import path from 'node:path';

// Load .env
const envPath = path.resolve('/home/ubuntu/work/gemini-proxy/.env');
const envContent = fs.readFileSync(envPath, 'utf8');
let apiKey = '';
for (const line of envContent.split('\n')) {
  const t = line.trim();
  if (t.startsWith('API_KEY=')) {
    apiKey = t.substring(8).trim().replace(/^["']|["']$/g, '');
  }
}

const BASE = 'http://localhost:3100';

async function test(name, method, path, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  const opts = { method, headers: h };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(`${name}: ${r.status} ${r.ok ? '✓' : '✗'}`);
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2).substring(0, 500));
  } else {
    console.log(data.substring(0, 200));
  }
  console.log('---');
  return { status: r.status, ok: r.ok, data };
}

// 1. Status (empty pool)
await test('1. Status (empty pool)', 'GET', '/v1/status');

// 2. List accounts (empty)
await test('2. List accounts (empty)', 'GET', '/v1/accounts');

// 3. Capture tokens (simulasi Camoufox dengan label)
await test('3. Capture (harmitafbads)', 'POST', '/v1/capture-tokens', {
  at: 'test_at_token_abc123',
  bl: 'boq_assistant-bard-web-server_20260709.09_p0',
  fSid: '2648168936207692562',
  shareId: 'c26c881da4e6',
  hl: 'id',
  cookies: 'SID=test; HSID=test',
  label: 'harmitafbads',
  extensionKey: apiKey,
});

// 4. Status (1 account)
await test('4. Status (1 account)', 'GET', '/v1/status');

// 5. List accounts (1 account)
await test('5. List accounts (1 account)', 'GET', '/v1/accounts');

// 6. Capture second account
await test('6. Capture (second account)', 'POST', '/v1/capture-tokens', {
  at: 'test_at_token_xyz789',
  bl: 'boq_assistant-bard-web-server_20260709.09_p0',
  fSid: '9999999999999999999',
  shareId: 'd37d992eb5f7',
  hl: 'id',
  cookies: 'SID=test2; HSID=test2',
  label: 'account2',
  extensionKey: apiKey,
});

// 7. List accounts (2 accounts)
await test('7. List accounts (2 accounts)', 'GET', '/v1/accounts');

// 8. Reset account
const list = await (await fetch(`${BASE}/v1/accounts`, {
  headers: { 'Authorization': `Bearer ${apiKey}` }
})).json();
if (list.accounts && list.accounts[0]) {
  const accId = list.accounts[0].id;
  await test(`8. Reset ${accId}`, 'POST', `/v1/accounts/${accId}/reset`);
}

// 9. Set rotation mode
await test('9. Set rotation least-used', 'POST', '/v1/rotation', { mode: 'least-used' });

// 10. Set back to round-robin
await test('10. Set rotation round-robin', 'POST', '/v1/rotation', { mode: 'round-robin' });

// 11. Remove second account
if (list.accounts && list.accounts[1]) {
  const accId2 = list.accounts[1].id;
  await test(`11. Remove ${accId2}`, 'DELETE', `/v1/accounts/${accId2}`);
}

// 12. Final status
await test('12. Final status', 'GET', '/v1/status');

console.log('\n✅ All pool tests done!');
