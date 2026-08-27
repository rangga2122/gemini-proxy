import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scryptSync} from 'node:crypto';
import {createApp} from '../server.js';
import {DashboardAuth} from '../lib/admin.js';

const password='correct horse battery staple', salt='test-salt';
const hash=scryptSync(password,salt,32).toString('hex');
async function fixture(extra={}) {
  const stateDir=extra.stateDir||await mkdtemp(join(tmpdir(),'mcp-admin-'));
  const app=await createApp({stateDir,adminEmail:' Admin@Example.COM ',adminPasswordSalt:salt,adminPasswordHash:hash,...extra});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=(path,options={})=>fetch(base+path,options);
  return {app,stateDir,request};
}
async function login(request,email='admin@example.com',pass=password){return request('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:pass})})}
const auth=t=>({authorization:`Bearer ${t}`,'content-type':'application/json'});

test('dashboard sessions persist hash-only, expire, revoke, and revalidate managed users',async()=>{
  let now=1_700_000_000_000;const dir=await mkdtemp(join(tmpdir(),'dashboard-auth-'));const file=join(dir,'sessions.json');
  const users={get:id=>id==='u1'?{id,email:'u@example.com',label:'U',active:true,expiresAt:null,keyId:'k1',maxSessions:1}:null};
  const keys={records:[{id:'k1',active:true,userId:'u1'}],reloadIfChanged:async()=>{}};
  const sessions=new DashboardAuth(file,{users,keys,now:()=>now,ttlMs:1000});await sessions.load();
  const token=await sessions.create({role:'user',userId:'u1',keyId:'k1'});assert.ok(token.length>=32);
  const disk=await readFile(file,'utf8');assert.equal(disk.includes(token),false);assert.equal(disk.includes('credential'),false);
  assert.equal((await sessions.validate(token)).role,'user');keys.records[0].active=false;assert.equal(await sessions.validate(token),null);
  keys.records[0].active=true;const second=await sessions.create({role:'admin',user:{email:'admin@example.com'}});await sessions.logout(second);assert.equal(await sessions.validate(second),null);
  const expiring=await sessions.create({role:'admin',user:{email:'admin@example.com'}});now+=1001;assert.equal(await sessions.validate(expiring),null);
  const reloaded=new DashboardAuth(file,{users,keys,now:()=>now,ttlMs:1000});await reloaded.load();assert.equal(await reloaded.validate(token),null);
});

test('dashboard auth HTTP supports both roles, cookies, generic failures, revalidation, and admin authorization',async t=>{
  let now=1_700_000_000_000;const f=await fixture({now:()=>now});t.after(()=>f.app.close());
  const legacy=(await(await login(f.request)).json()).token;let r=await f.request('/admin/users',{method:'POST',headers:auth(legacy),body:JSON.stringify({email:'user@example.com',label:'User'})});const made=await r.json();
  const signIn=body=>f.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  r=await signIn({email:'admin@example.com',credential:password});assert.equal(r.status,200);assert.equal((await r.json()).role,'admin');const adminCookie=r.headers.get('set-cookie');assert.match(adminCookie,/HttpOnly/i);assert.match(adminCookie,/Secure/i);assert.match(adminCookie,/SameSite=Lax/i);
  assert.equal((await f.request('/auth/session',{headers:{cookie:adminCookie}})).status,200);assert.equal((await f.request('/admin/users',{headers:{cookie:adminCookie}})).status,200);
  r=await signIn({email:' USER@example.com ',credential:made.key});assert.equal(r.status,200);const userBody=await r.json();assert.equal(userBody.role,'user');assert.equal(userBody.user.email,'user@example.com');assert.equal(JSON.stringify(userBody).includes(made.key),false);const userCookie=r.headers.get('set-cookie');
  assert.equal((await f.request('/admin/users',{headers:{cookie:userCookie}})).status,403);assert.equal((await f.request('/admin/users')).status,401);
  r=await signIn({email:'user@example.com',credential:made.key});assert.equal(r.status,429);assert.deepEqual(await r.json(),{error:'Session limit reached'});
  r=await f.request('/auth/logout',{method:'POST',headers:{cookie:userCookie}});assert.equal(r.status,204);
  r=await signIn({email:'user@example.com',credential:made.key});assert.equal(r.status,200);const replacementCookie=r.headers.get('set-cookie');assert.equal((await f.request('/auth/session',{headers:{cookie:replacementCookie}})).status,200);
  for(const body of [{email:'wrong@example.com',credential:made.key},{email:'user@example.com',credential:'bad-key'}]){r=await signIn(body);assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'Invalid credentials'})}
  await f.request(`/admin/users/${made.user.id}`,{method:'PATCH',headers:auth(legacy),body:JSON.stringify({active:false})});assert.equal((await f.request('/auth/session',{headers:{cookie:replacementCookie}})).status,401);
  r=await f.request('/auth/logout',{method:'POST',headers:{cookie:adminCookie}});assert.equal(r.status,204);assert.match(r.headers.get('set-cookie'),/Max-Age=0/i);assert.equal((await f.request('/auth/session',{headers:{cookie:adminCookie}})).status,401);
});

test('admin rejects wrong email/password generically; login, logout and expiry',async t=>{
  let now=1_700_000_000_000; const f=await fixture({now:()=>now,adminSessionTtlMs:1000});t.after(()=>f.app.close());
  for(const [email,p] of [['other@example.com',password],['admin@example.com','wrong']]){const r=await login(f.request,email,p);assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'Invalid credentials'});}
  let r=await login(f.request);assert.equal(r.status,200);const {token}=await r.json();assert.ok(token.length>=32);
  assert.equal((await f.request('/admin/users',{headers:auth(token)})).status,200);
  now+=1001;assert.equal((await f.request('/admin/users',{headers:auth(token)})).status,401);
  r=await login(f.request);const second=(await r.json()).token;
  assert.equal((await f.request('/admin/logout',{method:'POST',headers:auth(second)})).status,204);
  assert.equal((await f.request('/admin/users',{headers:auth(second)})).status,401);
  const sessions=JSON.parse(await readFile(join(f.stateDir,'admin-sessions.json'),'utf8'));assert.ok(sessions.every(x=>!Object.values(x).includes(token)&&!Object.values(x).includes(second)));
});

test('user upsert normalizes email, creates one key, sanitizes list, persists restart',async t=>{
  const f=await fixture();let closed=false;t.after(()=>closed||f.app.close());const token=(await (await login(f.request)).json()).token;
  let r=await f.request('/admin/users',{method:'POST',headers:auth(token),body:JSON.stringify({email:' Alice@Example.COM ',label:'Alice',maxSessions:2})});assert.equal(r.status,201);const first=await r.json();assert.match(first.key,/^cosmic-mcp-/);assert.equal(first.user.email,'alice@example.com');
  r=await f.request('/admin/users',{method:'POST',headers:auth(token),body:JSON.stringify({email:'alice@example.com',label:'Alice 2',maxSessions:3})});assert.equal(r.status,200);const again=await r.json();assert.equal(again.key,undefined);assert.equal(again.user.id,first.user.id);
  const listed=await (await f.request('/admin/users',{headers:auth(token)})).json();assert.equal(listed.users.length,1);assert.equal(listed.users[0].label,'Alice 2');assert.equal(JSON.stringify(listed).includes('hash'),false);assert.equal(JSON.stringify(listed).includes(first.key),false);
  const mode=(await stat(join(f.stateDir,'users.json'))).mode&0o777;assert.equal(mode,0o600);
  await f.app.close();closed=true;const f2=await fixture({stateDir:f.stateDir});t.after(()=>f2.app.close());const token2=(await(await login(f2.request)).json()).token;assert.equal((await(await f2.request('/admin/users',{headers:auth(token2)})).json()).users.length,1);
});

test('disabled/expired managed users rejected, rotate revokes old, enable preserves current key',async t=>{
  let now=1_700_000_000_000;const f=await fixture({now:()=>now});t.after(()=>f.app.close());const token=(await(await login(f.request)).json()).token;
  let r=await f.request('/admin/users',{method:'POST',headers:auth(token),body:JSON.stringify({email:'bob@example.com'})});let {user,key}=await r.json();
  const mcp=k=>f.request('/mcp',{method:'POST',headers:{authorization:`Bearer ${k}`},body:'{"jsonrpc":"2.0","id":1,"method":"ping"}'});
  assert.equal((await mcp(key)).status,200);
  r=await f.request(`/admin/users/${user.id}`,{method:'PATCH',headers:auth(token),body:JSON.stringify({active:false})});assert.equal(r.status,200);assert.equal((await mcp(key)).status,401);
  await f.request(`/admin/users/${user.id}`,{method:'PATCH',headers:auth(token),body:JSON.stringify({active:true,expiresAt:new Date(now+100).toISOString()})});assert.equal((await mcp(key)).status,200);now+=101;assert.equal((await mcp(key)).status,401);
  r=await f.request(`/admin/users/${user.id}/rotate`,{method:'POST',headers:auth(token)});assert.equal(r.status,200);const rotated=await r.json();assert.notEqual(rotated.key,key);assert.equal((await mcp(key)).status,401);
  await f.request(`/admin/users/${user.id}`,{method:'DELETE',headers:auth(token)});assert.equal((await mcp(rotated.key)).status,401);
});

test('invalid JSON/payload and traversal are rejected',async t=>{const f=await fixture();t.after(()=>f.app.close());const token=(await(await login(f.request)).json()).token;
  assert.equal((await f.request('/admin/users',{method:'POST',headers:auth(token),body:'{'})).status,400);
  assert.equal((await f.request('/admin/users',{method:'POST',headers:auth(token),body:JSON.stringify({email:'bad',maxSessions:0})})).status,400);
  assert.equal((await f.request('/admin/users/..%2Fkeys',{method:'PATCH',headers:auth(token),body:'{}'})).status,404);
});

test('legacy key without user metadata remains valid',async t=>{const f=await fixture();t.after(()=>f.app.close());const {key}=await f.app.keys.create('legacy');const r=await f.request('/mcp',{method:'POST',headers:{authorization:`Bearer ${key}`},body:'{"jsonrpc":"2.0","id":1,"method":"ping"}'});assert.equal(r.status,200)});

test('unconfigured admin authentication is unavailable',async t=>{const stateDir=await mkdtemp(join(tmpdir(),'mcp-admin-'));const app=await createApp({stateDir});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const r=await fetch(`http://127.0.0.1:${app.server.address().port}/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'x@y.com',password:'x'})});assert.equal(r.status,503)});
