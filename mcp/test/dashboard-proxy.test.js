import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scryptSync} from 'node:crypto';
import {createApp} from '../server.js';

const password='dashboard password',salt='dashboard-salt',hash=scryptSync(password,salt,32).toString('hex');
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`}

test('dashboard proxy authenticates and forwards only the exact allowlist',async t=>{
  const seen=[];const gen=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;seen.push({method:req.method,url:req.url,auth:req.headers.authorization,raw});if(req.url==='/v1/audio/speech'){res.writeHead(200,{'content-type':'audio/mpeg'});return res.end('audio')}res.writeHead(200,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:true,path:req.url}))});
  const genUrl=await listen(gen);t.after(()=>new Promise(r=>gen.close(r)));
  const app=await createApp({stateDir:await mkdtemp(join(tmpdir(),'dashboard-proxy-')),genUrl,genKey:'configured-key',adminEmail:'admin@example.com',adminPasswordSalt:salt,adminPasswordHash:hash});const base=await listen(app.server);t.after(()=>app.close());
  let r=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@example.com',credential:password})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie');
  assert.equal((await fetch(base+'/dashboard/v1/status')).status,401);
  assert.equal((await fetch(base+'/dashboard/v1/models',{headers:{cookie}})).status,404);
  const routes=[['POST','images/generations'],['POST','images/variations'],['POST','chat/completions'],['POST','audio/speech'],['GET','tts/voices'],['GET','status']];
  for(const [method,path]of routes){const options={method,headers:{cookie}};if(method==='POST'){options.headers['content-type']='application/json';options.body=JSON.stringify({marker:path})}r=await fetch(`${base}/dashboard/v1/${path}`,options);assert.equal(r.status,200,path);if(path==='audio/speech'){assert.equal(r.headers.get('content-type'),'audio/mpeg');assert.equal(await r.text(),'audio')}else assert.deepEqual(await r.json(),{ok:true,path:`/v1/${path}`})}
  assert.equal(seen.length,6);for(const request of seen)assert.equal(request.auth,'Bearer configured-key');assert.deepEqual(JSON.parse(seen[0].raw),{marker:'images/generations'});assert.equal(seen.at(-1).raw,'');
  const stats=await (await fetch(base+'/admin/stats',{headers:{cookie}})).json();assert.deepEqual(stats.totals,{imageGenerate:1,imageEdit:1,vision:0,chat:1,audio:1,images:2,overall:4});
  r=await fetch(base+'/admin/users',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({email:'limited@example.com',rpmLimit:1})});assert.equal(r.status,201);const made=await r.json();
  r=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'limited@example.com',credential:made.password})});assert.equal(r.status,200);const userCookie=r.headers.get('set-cookie'),options={method:'POST',headers:{cookie:userCookie,'content-type':'application/json'},body:JSON.stringify({prompt:'hello'})};
  assert.equal((await fetch(base+'/dashboard/v1/chat/completions',options)).status,200);const limited=await fetch(base+'/dashboard/v1/chat/completions',options);assert.equal(limited.status,429);assert.equal(limited.headers.get('x-ratelimit-limit'),'1');
});

test('dashboard proxy converts malformed input and backend failures safely',async t=>{
  const gen=http.createServer((req,res)=>{res.writeHead(500,{'content-type':'application/json'});res.end('{"secret":"backend detail"}')});const genUrl=await listen(gen);t.after(()=>new Promise(r=>gen.close(r)));
  const app=await createApp({stateDir:await mkdtemp(join(tmpdir(),'dashboard-proxy-')),genUrl,adminEmail:'admin@example.com',adminPasswordSalt:salt,adminPasswordHash:hash});const base=await listen(app.server);t.after(()=>app.close());
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@example.com',credential:password})});const headers={cookie:login.headers.get('set-cookie'),'content-type':'application/json'};
  assert.equal((await fetch(base+'/dashboard/v1/chat/completions',{method:'POST',headers,body:'{'})).status,400);
  const failed=await fetch(base+'/dashboard/v1/status',{headers});assert.equal(failed.status,502);assert.deepEqual(await failed.json(),{error:'Backend unavailable'});
});
