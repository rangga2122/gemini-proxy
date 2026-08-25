// test_server.js — Quick smoke test for gemini-proxy
import fs from 'node:fs';
import path from 'node:path';

// Load .env
const env = fs.readFileSync(path.resolve('.env'), 'utf8');
const envVars = {};
for (const line of env.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  envVars[t.substring(0, eq).trim()] = t.substring(eq + 1).trim();
}

const API_KEY = envVars.API_KEY || '';
console.log('API key length:', API_KEY.length, 'prefix:', API_KEY.substring(0, 6));

const BASE = 'http://localhost:3000';

// Test 1: Health
let r = await fetch(`${BASE}/`);
console.log('\n1. Health:', (await r.json()).status);

// Test 2: No API key → 401
r = await fetch(`${BASE}/v1/status`);
console.log('2. No key:', r.status, (await r.json()).error);

// Test 3: With API key
r = await fetch(`${BASE}/v1/status`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});
const status = await r.json();
console.log('3. With key:', r.status, 'tokensReady:', status.tokensReady);

// Test 4: Capture tokens
r = await fetch(`${BASE}/v1/capture-tokens`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    at: 'test_at_12345',
    bl: 'boq_assistant-bard-web-server_20260709.09_p0',
    fSid: '9999999999999',
    shareId: 'c26c881da4e6',
    hl: 'id',
    cookies: 'test_cookie=1',
    extensionKey: API_KEY,
  }),
});
const cap = await r.json();
console.log('4. Capture:', r.status, cap.success, cap.updated);

// Test 5: Status again → tokensReady should be true
r = await fetch(`${BASE}/v1/status`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});
const status2 = await r.json();
console.log('5. Status after capture:', 'tokensReady:', status2.tokensReady);

// Test 6: TTS voices (butuh API key)
r = await fetch(`${BASE}/v1/tts/voices`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});
const voices = await r.json();
console.log('6. TTS voices:', voices.voices?.length || 0, 'voices');

console.log('\n✅ All tests passed!');
