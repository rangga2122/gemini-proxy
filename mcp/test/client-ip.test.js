import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clientIp,createApp} from '../server.js';

const req=(remoteAddress,xff)=>({socket:{remoteAddress},headers:xff===undefined?{}:{'x-forwarded-for':xff}});

test('forwarded addresses are ignored unless proxy trust is enabled',()=>{
  assert.equal(clientIp(req('127.0.0.1','198.51.100.1')), '127.0.0.1');
  assert.equal(clientIp(req('::ffff:127.0.0.1','198.51.100.1')), '127.0.0.1');
});

test('trusted private proxy walks forwarded hops from right to left',()=>{
  assert.equal(clientIp(req('10.2.3.4','::ffff:192.0.2.8, 172.16.0.2'),true),'192.0.2.8');
  assert.equal(clientIp(req('fd12::1','2001:db8::7, 10.0.0.1'),true),'2001:db8::7');
  assert.equal(clientIp(req('127.0.0.1','198.51.100.99, 203.0.113.7'),true),'203.0.113.7');
  assert.equal(clientIp(req('192.168.1.2','198.51.100.1, 10.0.0.2'),true),'198.51.100.1');
});

test('all-trusted forwarded chain uses rightmost address as immediate client',()=>{
  assert.equal(clientIp(req('127.0.0.1','10.0.0.99, 192.168.1.10'),true),'192.168.1.10');
});

test('malformed forwarded chain falls back to socket peer',()=>{
  for(const value of ['198.51.100.1, nope','198.51.100.1,','198.51.100.1\t, 10.0.0.1',['198.51.100.1']])
    assert.equal(clientIp(req('192.168.1.2',value),true),'192.168.1.2');
});

test('public immediate peer can never spoof forwarded address',()=>{
  assert.equal(clientIp(req('8.8.8.8','198.51.100.1'),true),'8.8.8.8');
});

test('trusted proxy separates trial limiter identities',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mcp-ip-'));
  const trial={load:async()=>{},cleanup:async()=>{},close:async()=>{},opaqueIpKey:x=>x};
  const app=await createApp({stateDir:dir,trialStore:trial,mailer:{},trustProxy:true,trialRequestAttemptLimit:1});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  const url=`http://127.0.0.1:${app.server.address().port}/auth/trial/request`;
  const send=ip=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':ip},body:'{}'});
  assert.equal((await send('198.51.100.1')).status,400);
  assert.equal((await send('198.51.100.1')).status,429);
  assert.equal((await send('198.51.100.2')).status,400);
});
