// apikeys.js — Multi-API-key management
// Local JSON file storage, generate/list/revoke keys
// Keys persistent across restarts

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEYS_FILE = path.resolve(process.cwd(), 'api-keys.json');

// ─── Load existing keys from .env as "master" key ───────
function getMasterKey() {
  const envKey = process.env['API' + '_KEY'] || '';
  return envKey;
}

// ─── Storage ────────────────────────────────────────────
function loadKeys() {
  try {
    const data = fs.readFileSync(KEYS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { keys: [], nextId: 1 };
  }
}

function saveKeys(store) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(store, null, 2));
}

// ─── Generate new key ───────────────────────────────────
// Format: azkazamdigital-<8 random lowercase letters>
export function createKey(label = '') {
  const store = loadKeys();
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += alphabet[crypto.randomInt(0, alphabet.length)];
  const key = 'azkazamdigital-' + suffix;
  const entry = {
    id: store.nextId++,
    key,
    label: label || `key-${store.nextId - 1}`,
    createdAt: Date.now(),
    active: true,
    requestCount: 0,
    lastUsed: null,
  };
  store.keys.push(entry);
  saveKeys(store);
  return entry;
}

// ─── List all keys (masked) ─────────────────────────────
export function listKeys() {
  const store = loadKeys();
  const master = getMasterKey();
  const result = [];

  // Master key from .env (always active, can't revoke)
  if (master) {
    result.push({
      id: 0,
      key: master.substring(0, 12) + '…',
      fullKey: master, // only returned here for UI display
      label: 'master (from .env)',
      createdAt: null,
      active: true,
      isMaster: true,
      requestCount: '—',
      lastUsed: '—',
    });
  }

  for (const k of store.keys) {
    result.push({
      id: k.id,
      key: k.key.substring(0, 12) + '…',
      fullKey: k.key,
      label: k.label,
      createdAt: new Date(k.createdAt).toISOString(),
      createdAtAgo: timeAgo(k.createdAt),
      active: k.active,
      isMaster: false,
      requestCount: k.requestCount || 0,
      lastUsed: k.lastUsed ? timeAgo(k.lastUsed) : '—',
    });
  }

  return result;
}

// ─── Revoke key ──────────────────────────────────────────
export function revokeKey(id) {
  const store = loadKeys();
  const k = store.keys.find(x => x.id === id);
  if (!k) return false;
  k.active = false;
  saveKeys(store);
  return true;
}

// ─── Activate key (un-revoke) ───────────────────────────
export function activateKey(id) {
  const store = loadKeys();
  const k = store.keys.find(x => x.id === id);
  if (!k) return false;
  k.active = true;
  saveKeys(store);
  return true;
}

// ─── Delete key permanently ─────────────────────────────
export function deleteKey(id) {
  const store = loadKeys();
  const before = store.keys.length;
  store.keys = store.keys.filter(x => x.id !== id);
  if (store.keys.length < before) {
    saveKeys(store);
    return true;
  }
  return false;
}

// ─── Validate key ────────────────────────────────────────
// Returns true if key matches master OR any active generated key
export function validateKey(testKey) {
  if (!testKey) return false;

  // Check master key from .env
  const master = getMasterKey();
  if (master && testKey === master) return true;

  // Check generated keys
  const store = loadKeys();
  const found = store.keys.find(x => x.key === testKey && x.active);
  if (found) {
    // Track usage
    found.requestCount = (found.requestCount || 0) + 1;
    found.lastUsed = Date.now();
    saveKeys(store);
    return true;
  }

  return false;
}

// ─── Has any key configured? ───────────────────────────
export function hasKeys() {
  const master = getMasterKey();
  const store = loadKeys();
  const activeGenerated = store.keys.filter(x => x.active).length;
  return Boolean(master) || activeGenerated > 0;
}

// ─── Stats ──────────────────────────────────────────────
export function getKeyStats() {
  const store = loadKeys();
  const master = getMasterKey();
  return {
    master: Boolean(master),
    generated: store.keys.length,
    active: store.keys.filter(x => x.active).length,
    revoked: store.keys.filter(x => !x.active).length,
  };
}

// ─── Helpers ────────────────────────────────────────────
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}
