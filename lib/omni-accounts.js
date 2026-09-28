// lib/omni-accounts.js — Kelola akun Omni (gusmall) untuk Gen Console
// Sumber data: /home/ubuntu/omni-accounts/pool/*.json (hasil capture Camoufox)
// Aktif akun: tulis cookies SAPISID lengkap ke /home/ubuntu/work/omni-vids/cookies_live.txt
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const POOL_DIR = '/home/ubuntu/omni-accounts/pool';
const ACCOUNTS_LIST = '/home/ubuntu/omni-accounts/accounts.txt';
const OMNI_COOKIE = '/home/ubuntu/work/omni-vids/cookies_live.txt';
const OMNI_STATE = '/home/ubuntu/work/omni-vids/vids_state.json';
const ACTIVE_PTR = '/home/ubuntu/omni-accounts/active.json';
const RR_FILE = '/home/ubuntu/omni-accounts/rr_state.json';

function listPool() {
  const files = fs.existsSync(POOL_DIR) ? fs.readdirSync(POOL_DIR).filter(f => f.endsWith('.json')) : [];
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(POOL_DIR, f), 'utf8'));
      out.push({
        label: d.label || f.replace('.json', ''),
        email: d.email || (f.replace('.json', '') + '@gusmall.com'),
        ok: Boolean(d.ok),
        at: Boolean(d.at),
        bl: Boolean(d.bl),
        fSid: Boolean(d.fSid),
        cookieCount: d.cookieCount || 0,
        error: d.error || null,
        ts: d.ts || null,
        // usage & kesehatan
        genCount: d.genCount || 0,
        genOk: d.genOk || 0,
        genFail: d.genFail || 0,
        lastGenAt: d.lastGenAt || null,
        docId: d.docId || null,
        cooldownUntil: d.cooldownUntil || 0,
        cooldownReason: d.cooldownReason || null,
        limited: Boolean(d.cooldownUntil && d.cooldownUntil > Date.now()),
      });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

// Daftar akun tersebar di DUA file (accounts.txt = gasmil.store, accounts-auto.txt = gusmall.com).
// Hitung berdasarkan NAMA (local-part) supaya tidak dobel, dan ikutkan akun pool yang
// belum/tidak ada di daftar (mis. DanuKiranaLesmono) — kalau tidak, "Total Akun" salah
// (bug 27 Sep'26: dulu cuma baca accounts.txt + hardcode satu domain → 0).
const ACCOUNTS_LISTS = [ACCOUNTS_LIST, '/home/ubuntu/omni-accounts/accounts-auto.txt'];

function localPart(l) {
  const t = String(l || '').trim().toLowerCase();
  if (!t || !t.includes('@')) return null;
  return t.split('@')[0];
}

function totalAccounts() {
  const names = new Set();
  for (const f of ACCOUNTS_LISTS) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const n = localPart(line);
        if (n) names.add(n);
      }
    } catch { /* file belum ada — lewati */ }
  }
  for (const a of listPool()) {
    const n = localPart(a.email) || String(a.label || '').toLowerCase();
    if (n) names.add(n);
  }
  return names.size;
}

function getActive() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_PTR, 'utf8')); } catch { return null; }
}

function setActive(label) {
  const file = path.join(POOL_DIR, label + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'Akun tidak ditemukan di pool' };
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!d.ok || !d.cookies || !d.cookies.includes('SAPISID=')) {
    return { ok: false, error: 'Auth akun tidak lengkap (SAPISID tidak ada)' };
  }
  fs.writeFileSync(OMNI_COOKIE, d.cookies);
  // patch vids_state.json → cookie_file tetap sama, tapi catat label aktif
  try {
    const st = JSON.parse(fs.readFileSync(OMNI_STATE, 'utf8'));
    st.active_account = label;
    fs.writeFileSync(OMNI_STATE, JSON.stringify(st, null, 1));
  } catch { /* state opsional */ }
  fs.writeFileSync(ACTIVE_PTR, JSON.stringify({ label, email: d.email, ts: Date.now() }, null, 1));
  return { ok: true, label, email: d.email };
}

function stats() {
  const pool = listPool();
  const act = getActive();
  let rrMode = false, rrBlacklistCount = 0;
  try {
    const rr = JSON.parse(fs.readFileSync(RR_FILE, 'utf8'));
    rrMode = rr.mode === 'round_robin';
    rrBlacklistCount = Object.keys(rr.rrBlacklist || {}).length;
  } catch { /* default manual */ }
  return {
    total: totalAccounts(),
    captured: pool.filter(a => a.ok).length,
    failed: pool.filter(a => !a.ok).length,
    pending: Math.max(0, totalAccounts() - pool.length),
    limited: pool.filter(a => a.limited).length,
    totalGen: pool.reduce((s, a) => s + (a.genCount || 0), 0),
    active: act,
    mode: rrMode ? 'round_robin' : 'manual',
    rrBlacklistCount,
  };
}

function setMode(mode) {
  if (mode !== 'round_robin' && mode !== 'manual') return { ok: false, error: 'mode harus round_robin atau manual' };
  let rr = {};
  try { rr = JSON.parse(fs.readFileSync(RR_FILE, 'utf8')); } catch {}
  rr.mode = mode;
  if (mode === 'manual') { rr.rrIndex = 0; rr.rrFails = 0; }
  fs.writeFileSync(RR_FILE, JSON.stringify(rr, null, 1));
  // saat RR dinyalakan, tampilkan akun pertama rotasi supaya engine langsung siap
  let first = null;
  if (mode === 'round_robin') {
    try {
      const out = execSync('/home/ubuntu/work/omni-vids/venv/bin/python -c "import sys; sys.path.insert(0,\'/home/ubuntu/work/omni-vids\'); import omni_pool; d,e = omni_pool.rr_next_account(); print((d or {}).get(\'label\',\'\'), \'|\', e or \'\')"', { timeout: 120000 }).toString().trim();
      const [label, err] = out.split('|').map(s => s.trim());
      if (label) first = label; else return { ok: false, error: err || 'tidak ada akun sehat' };
    } catch (e) { return { ok: false, error: String(e.stderr || e.message).slice(0, 200) }; }
  }
  return { ok: true, mode, first };
}

export { listPool, totalAccounts, getActive, setActive, stats, setMode };
