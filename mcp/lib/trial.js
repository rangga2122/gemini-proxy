import { createHmac, randomInt, randomBytes, scrypt as scryptCallback, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const scrypt = promisify(scryptCallback);
export const OTP_TTL_MS = 10 * 60_000;
export const RESERVATION_TTL_MS = 2 * 60_000;
export const RESEND_COOLDOWN_MS = 60_000;
export const SEND_WINDOW_MS = 60 * 60_000;
export const PENDING_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_SENDS_PER_WINDOW = 5;

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid email');
  const email = value.trim().toLowerCase();
  if (!/^[^\s@,;<>\x00-\x1f\x7f]+@[^\s@,;<>\x00-\x1f\x7f]+\.[^\s@,;<>\x00-\x1f\x7f]+$/.test(email)) throw new TypeError('Invalid email');
  return email;
}
function validateSecret(secret) {
  if (!((typeof secret === 'string' && secret.length >= 32) || (Buffer.isBuffer(secret) && secret.length >= 32))) throw new TypeError('ledgerSecret must be at least 32 bytes');
}
export function emailHmac(email, secret) { validateSecret(secret); return createHmac('sha256', secret).update(normalizeEmail(email)).digest('hex'); }
export function generateOtp() { return String(randomInt(0, 1_000_000)).padStart(6, '0'); }
export async function hashOtp(otp, salt = randomBytes(16).toString('hex')) {
  if (!/^\d{6}$/.test(String(otp))) throw new TypeError('OTP must be six digits');
  return { salt, hash: (await scrypt(String(otp), salt, 32)).toString('hex') };
}
export async function verifyOtp(otp, verifier) {
  if (!/^\d{6}$/.test(String(otp)) || !verifier?.salt || !verifier?.hash) return false;
  try { const actual = await scrypt(String(otp), verifier.salt, 32); const expected = Buffer.from(verifier.hash, 'hex'); return expected.length === actual.length && timingSafeEqual(actual, expected); } catch { return false; }
}
function validatePasswordVerifier(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'passwordHash,passwordSalt' || typeof value.passwordSalt !== 'string' || !value.passwordSalt || typeof value.passwordHash !== 'string' || !/^[0-9a-fA-F]{64,}$/.test(value.passwordHash) || value.passwordHash.length % 2) throw new TypeError('passwordVerifier must contain exactly passwordSalt and a valid passwordHash');
  return structuredClone(value);
}
function trialError(code) { return Object.assign(new Error(code), { code }); }
const clone = structuredClone;

export class TrialStore {
  constructor(file, { ledgerSecret, now = Date.now, persist, otpGenerator = generateOtp } = {}) {
    validateSecret(ledgerSecret); this.file=file; this.secret=ledgerSecret; this.now=now; this.otpGenerator=otpGenerator;
    this.data={version:1,pending:{},consumed:{},requestRates:{}}; this.tail=Promise.resolve(); this.initialized=false;
    this.sendReservations=new Map(); this.activationReservations=new Map(); this.persistImpl=persist;
  }
  async load() {
    if (this.initialized) throw new Error('TrialStore already initialized');
    await this.enqueue(async()=>{ if (this.initialized) throw new Error('TrialStore already initialized'); try { const v=JSON.parse(await readFile(this.file,'utf8')); this.data={version:1,pending:v?.pending&&typeof v.pending==='object'?v.pending:{},consumed:v?.consumed&&typeof v.consumed==='object'?v.consumed:{},requestRates:v?.requestRates&&typeof v.requestRates==='object'?v.requestRates:{}}; } catch(e){if(e.code!=='ENOENT') throw e;} this.initialized=true; });
  }
  ready(){if(!this.initialized) throw new Error('TrialStore must be loaded before use');}
  key(email){return emailHmac(email,this.secret);}
  opaqueIpKey(ip){return createHmac('sha256',this.secret).update(`ip-attempt:${String(ip)}`).digest('hex');}
  enqueue(op){const run=this.tail.then(op);this.tail=run.catch(()=>{});return run;}
  mutate(op){this.ready();return this.enqueue(async()=>{const before=clone(this.data);try{const result=await op();await this.persist();return result;}catch(e){this.data=before;throw e;}});}
  pruneReservations(now=Number(this.now())) { for(const [id,r] of this.sendReservations) if(now>=r.expiresAt)this.sendReservations.delete(id); for(const [id,r] of this.activationReservations) if(now>=r.expiresAt)this.activationReservations.delete(id); }
  reserveSend(email,passwordVerifier,{opaqueIp}={}){this.ready();return this.enqueue(async()=>{const key=this.key(email), now=Number(this.now());this.pruneReservations(now);validatePasswordVerifier(passwordVerifier);if(this.data.consumed[key])throw trialError('ALREADY_CONSUMED');if([...this.sendReservations.values()].some(r=>r.key===key))throw trialError('SEND_IN_PROGRESS');const old=this.data.pending[key], sends=(old?.sends||[]).filter(t=>t>now-SEND_WINDOW_MS),ipKey=opaqueIp?createHmac('sha256',this.secret).update(`ip:${opaqueIp}`).digest('hex'):null,ipSends=ipKey?(this.data.requestRates[ipKey]||[]).filter(t=>t>now-SEND_WINDOW_MS):[];if(old&&now-old.lastSentAt<RESEND_COOLDOWN_MS)throw trialError('RESEND_COOLDOWN');if(sends.length>=MAX_SENDS_PER_WINDOW)throw trialError('SEND_LIMIT');if(ipSends.length>=MAX_SENDS_PER_WINDOW)throw trialError('IP_SEND_LIMIT');const otp=String(this.otpGenerator());if(!/^\d{6}$/.test(otp))throw new TypeError('otpGenerator must return six digits');const otpVerifier=await hashOtp(otp), reservationId=randomUUID();this.sendReservations.set(reservationId,{key,passwordVerifier:clone(passwordVerifier),otpVerifier,otp,createdAt:now,expiresAt:now+RESERVATION_TTL_MS,sends,ipKey,ipSends});return {reservationId,otp,expiresAt:now+OTP_TTL_MS};});}
  commitSend(id){return this.mutate(async()=>{const r=this.sendReservations.get(id),now=Number(this.now());if(!r||now>=r.expiresAt){this.sendReservations.delete(id);throw trialError('INVALID_RESERVATION');}this.data.pending[r.key]={otpVerifier:r.otpVerifier,passwordVerifier:r.passwordVerifier,createdAt:now,expiresAt:now+OTP_TTL_MS,lastSentAt:now,sends:[...r.sends,now],attempts:0};if(r.ipKey)this.data.requestRates[r.ipKey]=[...r.ipSends,now];this.sendReservations.delete(id);return {expiresAt:now+OTP_TTL_MS};});}
  abortSend(id){this.ready();return this.enqueue(async()=>this.sendReservations.delete(id));}
  beginVerification(email,otp){return this.mutate(async()=>{const key=this.key(email),item=this.data.pending[key],now=Number(this.now());this.pruneReservations(now);if(!item)return {ok:false,reason:'not_found'};if(item.attempts>=MAX_ATTEMPTS)return {ok:false,reason:'attempts_exhausted',attemptsRemaining:0};if(now>=item.expiresAt)return {ok:false,reason:'expired'};if(!await verifyOtp(otp,item.otpVerifier)){item.attempts++;const n=MAX_ATTEMPTS-item.attempts;return {ok:false,reason:n?'invalid':'attempts_exhausted',attemptsRemaining:n};}if([...this.activationReservations.values()].some(r=>r.key===key))throw trialError('ACTIVATION_IN_PROGRESS');const reservationId=randomUUID();this.activationReservations.set(reservationId,{key,expiresAt:now+RESERVATION_TTL_MS});return {ok:true,reservationId,passwordVerifier:clone(item.passwordVerifier)};});}
  commitActivation(id,{userId,verifiedAt}={}){if(typeof userId!=='string'||!userId)throw new TypeError('userId is required');if(!Number.isFinite(verifiedAt))throw new TypeError('verifiedAt is required');return this.mutate(async()=>{const r=this.activationReservations.get(id),now=Number(this.now());if(!r||now>=r.expiresAt){this.activationReservations.delete(id);throw trialError('INVALID_RESERVATION');}this.data.consumed[r.key]={verifiedAt,userId,status:'consumed'};delete this.data.pending[r.key];this.activationReservations.delete(id);});}
  abortActivation(id){this.ready();return this.enqueue(async()=>this.activationReservations.delete(id));}
  async snapshot(){this.ready();await this.tail;return clone(this.data);}
  restore(snapshot){if(!snapshot||typeof snapshot!=='object')throw new TypeError('invalid snapshot');return this.mutate(async()=>{this.data=clone(snapshot);});}
  async getPending(email){this.ready();await this.tail;const x=this.data.pending[this.key(email)];return x?clone(x):null;}
  async hasConsumed(email){this.ready();await this.tail;return Boolean(this.data.consumed[this.key(email)]);}
  cleanup(){return this.mutate(async()=>{const now=Number(this.now()),cutoff=now-PENDING_RETENTION_MS;this.pruneReservations(now);let n=0;for(const [k,v] of Object.entries(this.data.pending))if(v.createdAt<cutoff){delete this.data.pending[k];n++;}for(const [k,v] of Object.entries(this.data.requestRates))if(!(this.data.requestRates[k]=v.filter(t=>t>now-SEND_WINDOW_MS)).length)delete this.data.requestRates[k];return n;});}
  async persist(){if(this.persistImpl)return this.persistImpl(clone(this.data));await mkdir(dirname(this.file),{recursive:true,mode:0o700});const tmp=`${this.file}.${process.pid}.${randomUUID()}.tmp`;try{await writeFile(tmp,JSON.stringify(this.data),{mode:0o600});await rename(tmp,this.file);}catch(e){await unlink(tmp).catch(()=>{});throw e;}}
  async close(){await this.tail;}
}
