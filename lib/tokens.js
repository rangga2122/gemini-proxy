// tokens.js — Multi-account Gemini token pool with rotation
// Local JSON file storage (NO Supabase)
// Supports: add account, rotate on rate-limit/error, auto-expire stale tokens

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_FILE = process.env.TOKEN_POOL_FILE
  || path.resolve(__dirname, '..', 'token-pool.json');

// Token freshness threshold (4 hours — Gemini tokens expire ~8h, 4h is safe)
const STALE_MS = 4 * 60 * 60 * 1000;
// Rate-limit cooldown (30 min)
const COOLDOWN_MS = 30 * 60 * 1000;
// Max consecutive failures before marking account dead
const MAX_FAILURES = 5;

/**
 * Account pool structure (persisted to JSON file):
 * {
 *   accounts: [
 *     {
 *       id: "acc_001",
 *       label: "harmitafbads",
 *       at: "...", bl: "...", fSid: "...", shareId: "...",
 *       hl: "id", cookies: "...",
 *       capturedAt: 1234567890,
 *       lastUsed: null,
 *       status: "active",         // active | cooldown | dead
 *       failures: 0,
 *       lastError: null,
 *       requestCount: 0,
 *     }
 *   ],
 *   currentIdx: 0,
 *   rotationMode: "round-robin",  // round-robin | least-used
 * }
 */

// ─── Load pool from file ─────────────────────────────
function loadPool() {
  try {
    if (!fs.existsSync(POOL_FILE)) return { accounts: [], currentIdx: 0, rotationMode: 'round-robin' };
    const raw = fs.readFileSync(POOL_FILE, 'utf8');
    const pool = JSON.parse(raw);
    if (!pool.accounts) pool.accounts = [];
    if (typeof pool.currentIdx !== 'number') pool.currentIdx = 0;
    if (!pool.rotationMode) pool.rotationMode = 'round-robin';
    return pool;
  } catch (e) {
    console.error('[Pool] Load error:', e.message);
    return { accounts: [], currentIdx: 0, rotationMode: 'round-robin' };
  }
}

// ─── Save pool to file ───────────────────────────────
function savePool(pool) {
  try {
    fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
  } catch (e) {
    console.error('[Pool] Save error:', e.message);
  }
}

// ─── Check if account token is stale ─────────────────
function isStale(account) {
  if (!account.capturedAt) return true;
  return (Date.now() - account.capturedAt) > STALE_MS;
}

// ─── Check if account is in cooldown ─────────────────
function isCooling(account) {
  if (account.status !== 'cooldown') return false;
  if (!account.cooldownUntil) return false;
  return Date.now() < account.cooldownUntil;
}

// ─── Pick next account (rotation logic) ─────────────
export function getNextAccount() {
  const pool = loadPool();

  // Refresh statuses: un-dead stale accounts, clear expired cooldowns
  let changed = false;
  for (const acc of pool.accounts) {
    if (acc.status === 'cooldown' && !isCooling(acc)) {
      acc.status = 'active';
      acc.cooldownUntil = null;
      changed = true;
    }
    if (acc.status === 'active' && isStale(acc)) {
      acc.status = 'stale';
      changed = true;
    }
  }

  // Get usable accounts: active, not stale, not cooling
  const usable = pool.accounts.filter(a =>
    a.status === 'active' && !isStale(a) && a.at && a.bl && a.fSid
  );

  if (usable.length === 0) {
    if (changed) savePool(pool);
    return { account: null, pool, reason: getNoAccountsReason(pool) };
  }

  // Rotation: round-robin among usable accounts
  if (pool.rotationMode === 'round-robin') {
    // Find next usable after currentIdx
    const sorted = [...pool.accounts].sort((a, b) =>
      (pool.accounts.indexOf(a) - pool.accounts.indexOf(b))
    );
    let picked = null;
    let pickedIdx = -1;

    for (let i = 0; i < pool.accounts.length; i++) {
      const idx = (pool.currentIdx + i) % pool.accounts.length;
      const acc = pool.accounts[idx];
      if (acc.status === 'active' && !isStale(acc) && acc.at && acc.bl && acc.fSid) {
        picked = acc;
        pickedIdx = idx;
        break;
      }
    }

    if (picked) {
      picked.lastUsed = Date.now();
      picked.requestCount = (picked.requestCount || 0) + 1;
      pool.currentIdx = (pickedIdx + 1) % pool.accounts.length;
      savePool(pool);
      return { account: picked, pool, reason: null };
    }
  } else if (pool.rotationMode === 'least-used') {
    // Pick account with lowest requestCount
    usable.sort((a, b) => (a.requestCount || 0) - (b.requestCount || 0));
    const picked = usable[0];
    picked.lastUsed = Date.now();
    picked.requestCount = (picked.requestCount || 0) + 1;
    savePool(pool);
    return { account: picked, pool, reason: null };
  }

  if (changed) savePool(pool);
  return { account: null, pool, reason: 'No usable accounts' };
}

// ─── Get reason why no accounts available ───────────
function getNoAccountsReason(pool) {
  if (pool.accounts.length === 0) return 'No accounts in pool. Add account via POST /v1/accounts or capture via extension.';
  const allStale = pool.accounts.every(a => a.status === 'stale' || isStale(a));
  if (allStale) return 'All accounts have stale tokens. Re-capture via cronjob or extension.';
  const allCooling = pool.accounts.every(a => a.status === 'cooldown' && isCooling(a));
  if (allCooling) return 'All accounts are in rate-limit cooldown. Wait a few minutes.';
  const allDead = pool.accounts.every(a => a.status === 'dead');
  if (allDead) return 'All accounts are marked dead. Reset them via POST /v1/accounts/:id/reset.';
  return 'No usable accounts available.';
}

// ─── Get current token config (compatible with old API) ──
export function getConfig() {
  const { account } = getNextAccount();
  if (!account) {
    return {
      at: '', bl: '', fSid: '', shareId: 'c26c881da4e6', hl: 'id', cookies: '',
      _accountId: null,
    };
  }
  return {
    at: account.at,
    bl: account.bl,
    fSid: account.fSid,
    shareId: account.shareId || 'c26c881da4e6',
    hl: account.hl || 'id',
    cookies: account.cookies || '',
    _accountId: account.id,
  };
}

// ─── Check if any account has valid tokens ───────────
export function hasTokens() {
  const { account } = getNextAccount();
  return !!account;
}

// ─── Add or update account in pool ──────────────────
export function upsertAccount({ id, label, at, bl, fSid, shareId, hl, cookies, url }) {
  const pool = loadPool();

  // Find existing by id or label
  let acc = pool.accounts.find(a =>
    (id && a.id === id) || (label && a.label === label)
  );

  if (!acc) {
    // Create new account
    acc = {
      id: id || `acc_${String(pool.accounts.length + 1).padStart(3, '0')}`,
      label: label || `account-${pool.accounts.length + 1}`,
      at: '', bl: '', fSid: '', shareId: 'c26c881da4e6',
      hl: 'id', cookies: '',
      capturedAt: null, lastUsed: null,
      status: 'active', failures: 0, lastError: null,
      requestCount: 0,
    };
    pool.accounts.push(acc);
  }

  // Update fields
  const updated = [];
  if (at) { acc.at = at; updated.push('at'); }
  if (bl) { acc.bl = bl; updated.push('bl'); }
  if (fSid) { acc.fSid = fSid; updated.push('fSid'); }
  if (shareId) { acc.shareId = shareId; updated.push('shareId'); }
  if (hl) { acc.hl = hl; updated.push('hl'); }
  if (cookies) { acc.cookies = cookies; updated.push('cookies'); }

  acc.capturedAt = Date.now();
  acc.status = 'active';
  acc.failures = 0;
  acc.lastError = null;

  savePool(pool);
  return { accountId: acc.id, label: acc.label, updated };
}

// ─── Mark account as rate-limited (cooldown) ────────
export function markCooldown(accountId, reason = 'rate-limit') {
  const pool = loadPool();
  const acc = pool.accounts.find(a => a.id === accountId);
  if (!acc) return false;

  acc.status = 'cooldown';
  acc.cooldownUntil = Date.now() + COOLDOWN_MS;
  acc.lastError = reason;
  acc.failures = (acc.failures || 0) + 1;

  if (acc.failures >= MAX_FAILURES) {
    acc.status = 'dead';
    console.log(`[Pool] Account ${acc.id} (${acc.label}) marked DEAD after ${acc.failures} failures`);
  }

  savePool(pool);
  return true;
}

// ─── Mark account error (but not cooldown) ──────────
export function markError(accountId, error) {
  const pool = loadPool();
  const acc = pool.accounts.find(a => a.id === accountId);
  if (!acc) return false;

  acc.lastError = String(error).substring(0, 200);
  acc.failures = (acc.failures || 0) + 1;

  if (acc.failures >= MAX_FAILURES) {
    acc.status = 'dead';
    console.log(`[Pool] Account ${acc.id} (${acc.label}) marked DEAD after ${acc.failures} failures`);
  }

  savePool(pool);
  return true;
}

// ─── Reset account to active ────────────────────────
export function resetAccount(accountId) {
  const pool = loadPool();
  const acc = pool.accounts.find(a => a.id === accountId);
  if (!acc) return false;

  acc.status = 'active';
  acc.cooldownUntil = null;
  acc.failures = 0;
  acc.lastError = null;

  savePool(pool);
  return true;
}

// ─── Remove account from pool ───────────────────────
export function removeAccount(accountId) {
  const pool = loadPool();
  const idx = pool.accounts.findIndex(a => a.id === accountId);
  if (idx === -1) return false;

  pool.accounts.splice(idx, 1);
  if (pool.currentIdx >= pool.accounts.length) pool.currentIdx = 0;
  savePool(pool);
  return true;
}

// ─── List all accounts (masked tokens) ──────────────
export function listAccounts() {
  const pool = loadPool();
  return pool.accounts.map(a => ({
    id: a.id,
    label: a.label,
    status: a.status,
    capturedAt: a.capturedAt,
    capturedAgo: a.capturedAt ? `${Math.round((Date.now() - a.capturedAt) / 60000)}m ago` : 'never',
    lastUsed: a.lastUsed ? `${Math.round((Date.now() - a.lastUsed) / 60000)}m ago` : 'never',
    requestCount: a.requestCount || 0,
    failures: a.failures || 0,
    lastError: a.lastError,
    tokenPreview: {
      at: a.at ? `${a.at.substring(0, 12)}...` : null,
      bl: a.bl ? `${a.bl.substring(0, 20)}...` : null,
      fSid: a.fSid ? `${a.fSid.substring(0, 12)}...` : null,
    },
    isStale: isStale(a),
  }));
}

// ─── Get pool stats ─────────────────────────────────
export function getPoolStats() {
  const pool = loadPool();
  const accounts = pool.accounts;
  return {
    total: accounts.length,
    active: accounts.filter(a => a.status === 'active' && !isStale(a)).length,
    stale: accounts.filter(a => a.status === 'stale' || (a.status === 'active' && isStale(a))).length,
    cooldown: accounts.filter(a => a.status === 'cooldown' && isCooling(a)).length,
    dead: accounts.filter(a => a.status === 'dead').length,
    rotationMode: pool.rotationMode,
    currentIdx: pool.currentIdx,
    poolFile: POOL_FILE,
  };
}

// ─── Backward compat: updateTokens (for extension capture)
// When extension captures, it creates/updates account by label ──
export function updateTokens({ at, bl, fSid, shareId, hl, cookies, url, label }) {
  const result = upsertAccount({
    label: label || 'extension-default',
    at, bl, fSid, shareId, hl, cookies, url,
  });
  console.log(`[Pool] Account upserted: ${result.accountId} (label: ${label || 'extension-default'}), fields: ${result.updated.join(', ')}`);
  return result.updated;
}

// ─── Backward compat: loadTokensFromSupabase (no-op now) ──
export async function loadTokensFromSupabase() {
  // No Supabase — pool loaded from JSON file on demand
  const stats = getPoolStats();
  console.log(`[Pool] Loaded from ${stats.poolFile}: ${stats.total} accounts (${stats.active} active)`);
}

// ─── Set rotation mode ───────────────────────────────
export function setRotationMode(mode) {
  if (mode !== 'round-robin' && mode !== 'least-used') return false;
  const pool = loadPool();
  pool.rotationMode = mode;
  savePool(pool);
  return true;
}
