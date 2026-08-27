import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTools} from '../lib/tools.js';
import {FixedWindow} from '../lib/limits.js';
import {dispatch} from '../lib/protocol.js';
import {createApp} from '../server.js';

const store={putBase64:async(_b,mime)=>({id:'a'.repeat(32),mime}),put:async(_b,mime)=>({id:'b'.repeat(32),mime})};

test('schemas expose Gen options and require only genuine inputs',()=>{
  const tools=createTools({},store); const by=Object.fromEntries(tools.list().map(x=>[x.name,x.inputSchema]));
  assert.deepEqual(by.generate_image.required,['prompt']);
  assert.equal(by.generate_image.properties.aspect_ratio.type,'string');
  assert.equal(by.generate_audio.properties.voice.type,'string');
  assert.deepEqual(by.analyze_image.properties.image.oneOf.map(x=>x.type),['string','object']);
  assert.deepEqual(by.list_voices.required,[]);
});

test('tool payloads, live voice endpoint, timeouts, MIME and URL joining match Gen',async()=>{
  const calls=[]; const client={post:async(path,body,o)=>{calls.push({path,body,o}); if(path.includes('images'))return{json:{data:[{b64_json:'eA==',mimeType:'image/jpeg'}]}}; if(path.includes('speech'))return{data:Buffer.from('x'),mime:'audio/wav'}; return{json:{choices:[{message:{content:'ok'}}]}}},get:async(path,o)=>{calls.push({path,o});return{json:{voices:['A']}}}};
  const tools=createTools(client,store,{publicBaseUrl:'https://x.example/',limits:{queueMax:7}});
  assert.equal((await tools.call('generate_image',{prompt:'p',aspect_ratio:'16:9'})).content[0].text,'https://x.example/artifacts/'+'a'.repeat(32));
  await tools.call('edit_image',{prompt:'p',image:{mimeType:'image/webp',base64:'eA=='}});
  await tools.call('generate_audio',{text:'p',voice:'Charon'}); await tools.call('chat_text',{prompt:'p'}); await tools.call('list_voices');
  assert.equal(calls[0].body.ratio,'16:9'); assert.equal(calls[0].o.timeoutMs,120000);
  assert.equal(calls[1].o.timeoutMs,120000); assert.equal(calls[2].o.timeoutMs,60000); assert.equal(calls[3].o.timeoutMs,45000);
  assert.equal(calls[4].path,'/v1/tts/voices'); assert.equal(tools.semaphores.image.queueMax,7);
});

test('tool failures are tool results, including unknown, invalid and overload',async()=>{
  for(const thrown of [Object.assign(new Error('unknown tool'),{code:-32601}),Object.assign(new Error('prompt is required'),{code:-32602}),Object.assign(new Error('busy'),{code:-32002})]){
    const r=await dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'x',arguments:{}}},{call:async()=>{throw thrown},list:()=>[]});
    assert.equal(r.result.isError,true); assert.match(r.result.content[0].text,/unknown|prompt|busy/);
  }
});

test('FixedWindow evicts stale keys',()=>{let now=0;const f=new FixedWindow(()=>now,{maxKeys:3});for(let i=0;i<3;i++)f.take(String(i));now=60001;f.take('new');assert.ok(f.map.size<=3)});

test('server security and artifact download headers',async t=>{const dir=await mkdtemp(join(tmpdir(),'mcp-hard-'));const app=await createApp({stateDir:dir});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;let r=await fetch(base+'/health');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('referrer-policy'),'no-referrer');const a=await app.artifacts.put(Buffer.from('x'),'image/webp');r=await fetch(base+'/artifacts/'+a.id);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-disposition'),/^attachment; filename=/);assert.equal(r.headers.get('content-type'),'image/webp')});
