import test from 'node:test'; import assert from 'node:assert/strict'; import {mkdtemp} from 'node:fs/promises'; import {tmpdir} from 'node:os'; import {join} from 'node:path';
import {KeyStore} from '../lib/auth.js';
test('persistent keys validate and revoke', async()=>{const dir=await mkdtemp(join(tmpdir(),'mcp-')); const file=join(dir,'keys.json'); const s=new KeyStore(file); await s.load(); const {key,id}=await s.create('alice',{limit:2}); assert.match(key,/^cosmic-mcp-/); assert.equal((await s.authenticate(key)).label,'alice'); const s2=new KeyStore(file); await s2.load(); assert.ok(await s2.authenticate(key)); await s2.revoke(id); assert.equal(await s2.authenticate(key),null); assert.equal(await s2.authenticate('bad'),null)});

test('accepts a key created externally after startup without reload or restart', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcp-')); const file=join(dir,'keys.json');
  const serverStore=new KeyStore(file); await serverStore.load();
  const externalStore=new KeyStore(file); await externalStore.load();
  const {key}=await externalStore.create('external');
  assert.equal((await serverStore.authenticate(key))?.label,'external');
});

test('rejects a key revoked externally after startup without reload or restart', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcp-')); const file=join(dir,'keys.json');
  const externalStore=new KeyStore(file); await externalStore.load();
  const {key,id}=await externalStore.create('external');
  const serverStore=new KeyStore(file); await serverStore.load();
  assert.ok(await serverStore.authenticate(key));
  await externalStore.revoke(id);
  assert.equal(await serverStore.authenticate(key),null);
});
