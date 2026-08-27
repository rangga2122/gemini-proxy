import {createHash,randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

async function atomic(file,value){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp,JSON.stringify(value),{mode:0o600});
  await rename(tmp,file);
}
async function load(file){try{const value=JSON.parse(await readFile(file,'utf8'));return Array.isArray(value)?value:[]}catch(e){if(e.code==='ENOENT')return [];throw e}}
export const normalizeEmail=value=>typeof value==='string'?value.trim().toLowerCase():'';
const publicUser=u=>({id:u.id,email:u.email,label:u.label,active:u.active,expiresAt:u.expiresAt,maxSessions:u.maxSessions,keyId:u.keyId,createdAt:u.createdAt,updatedAt:u.updatedAt});

export class UserStore{
  constructor(file,{now=Date.now}={}){this.file=file;this.now=now;this.records=[]}
  async load(){this.records=await load(this.file)}
  list(){return this.records.map(publicUser)}
  get(id){return this.records.find(u=>u.id===id)||null}
  async upsert(input){
    const email=normalizeEmail(input.email), stamp=new Date(this.now()).toISOString();let user=this.records.find(u=>u.email===email),created=!user;
    if(!user){user={id:randomUUID(),email,label:input.label??'',active:input.active??true,expiresAt:input.expiresAt??null,maxSessions:input.maxSessions??1,keyId:null,createdAt:stamp,updatedAt:stamp};this.records.push(user)}
    else {if(input.label!==undefined)user.label=input.label;if(input.maxSessions!==undefined)user.maxSessions=input.maxSessions;if(input.expiresAt!==undefined)user.expiresAt=input.expiresAt;if(input.active!==undefined)user.active=input.active;user.updatedAt=stamp}
    await atomic(this.file,this.records);return {user,created};
  }
  async update(id,changes){const u=this.get(id);if(!u)return null;Object.assign(u,changes,{updatedAt:new Date(this.now()).toISOString()});await atomic(this.file,this.records);return u}
}

export class AdminAuth{
  constructor(file,{email,salt,hash,ttlMs=8*60*60*1000,now=Date.now}={}){this.file=file;this.email=normalizeEmail(email);this.salt=salt;this.expected=validHex(hash)?Buffer.from(hash,'hex'):Buffer.alloc(32);this.configured=Boolean(this.email&&salt&&validHex(hash));this.ttlMs=ttlMs;this.now=now;this.sessions=[]}
  async load(){this.sessions=await load(this.file);await this.prune()}
  async prune(){const before=this.sessions.length;this.sessions=this.sessions.filter(s=>s.expiresAt>this.now());if(before!==this.sessions.length)await atomic(this.file,this.sessions)}
  async login(email,password){
    const actual=scryptSync(typeof password==='string'?password:'',this.salt||'unconfigured',this.expected.length||32);const passwordOk=actual.length===this.expected.length&&timingSafeEqual(actual,this.expected);
    const emailHash=createHash('sha256').update(normalizeEmail(email)).digest(),expectedEmail=createHash('sha256').update(this.email).digest();const emailOk=timingSafeEqual(emailHash,expectedEmail);
    if(!this.configured||!passwordOk||!emailOk)return null;
    const token=randomBytes(32).toString('base64url');this.sessions.push({id:randomUUID(),hash:createHash('sha256').update(token).digest('hex'),expiresAt:this.now()+this.ttlMs});await atomic(this.file,this.sessions);return token;
  }
  async validate(token){if(typeof token!=='string')return false;await this.prune();const h=createHash('sha256').update(token).digest();return this.sessions.some(s=>{const x=Buffer.from(s.hash,'hex');return x.length===h.length&&timingSafeEqual(x,h)})}
  async logout(token){const h=createHash('sha256').update(String(token)).digest('hex');this.sessions=this.sessions.filter(s=>s.hash!==h);await atomic(this.file,this.sessions)}
}
function validHex(v){return typeof v==='string'&&v.length>=64&&v.length%2===0&&/^[a-f0-9]+$/i.test(v)}
export function validUserInput(v,{partial=false}={}){
  if(!v||typeof v!=='object'||Array.isArray(v))return false;const allowed=partial?['label','active','expiresAt','maxSessions']:['email','label','active','expiresAt','maxSessions'];if(Object.keys(v).some(k=>!allowed.includes(k)))return false;
  if(!partial&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(v.email)))return false;
  if(v.label!==undefined&&(typeof v.label!=='string'||v.label.length>200))return false;if(v.active!==undefined&&typeof v.active!=='boolean')return false;if(v.maxSessions!==undefined&&(!Number.isInteger(v.maxSessions)||v.maxSessions<1||v.maxSessions>1000))return false;
  if(v.expiresAt!==undefined&&v.expiresAt!==null&&(typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))))return false;return !partial||Object.keys(v).length>0;
}
export {publicUser};
