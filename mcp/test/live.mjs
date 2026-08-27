import fs from 'node:fs';
const URL=process.env.MCP_URL||'http://127.0.0.1:3101/mcp';
const key=process.env.MCP_KEY||fs.readFileSync('/tmp/cosmic-mcp-test-key','utf8').trim();
let id=0;
async function rpc(method,params={}){
  const r=await fetch(URL,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
  const body=await r.json();
  if(!r.ok||body.error)throw new Error(`${method}: ${r.status} ${JSON.stringify(body.error||body).slice(0,300)}`);
  return body.result;
}
function text(result){return result?.content?.[0]?.text||''}
async function call(name,args={}){return rpc('tools/call',{name,arguments:args})}
const health=await fetch(URL.replace(/\/mcp$/,'/health')).then(r=>r.json());
console.log('health',health.status);
const init=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'live-test',version:'1.0'}});
console.log('initialize',init.protocolVersion,init.serverInfo?.name);
const tools=await rpc('tools/list',{});
console.log('tools',tools.tools.length,tools.tools.map(x=>x.name).join(','));
for(const name of ['get_service_status','get_pool_status','list_voices']){
  const r=await call(name,{}); console.log(name,'ok',text(r).length);
}
const chat=await call('chat_text',{prompt:'Jawab persis: MCP CHAT OK'});
console.log('chat_text',text(chat).slice(0,120));
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4k8AAAAASUVORK5CYII=';
const vision=await call('analyze_image',{prompt:'Jawab singkat: gambar ini sangat kecil. Tulis VISION OK.',image:pixel});
console.log('analyze_image',text(vision).slice(0,120));
const media=[];
for(const [name,args] of [
  ['generate_image',{prompt:'Minimal blue circle on white background',aspect_ratio:'1:1'}],
  ['edit_image',{prompt:'Turn this tiny image blue',image:pixel,aspect_ratio:'1:1'}],
  ['generate_audio',{text:'MCP audio berhasil dibuat',voice:'Charon'}]
]) {
  const out=await call(name,args);
  console.log(name,out.isError?'upstream-error':'ok',text(out).slice(0,180));
  if(!out.isError) media.push([name,text(out)]);
}
for(const [name,url] of media){
  const r=await fetch(url); const b=Buffer.from(await r.arrayBuffer());
  console.log('artifact',name,r.status,r.headers.get('content-type'),b.length);
  if(!r.ok||b.length<32)throw new Error(`bad artifact ${name}`);
}
if(media.length===0) throw new Error('No media tool produced an artifact');
console.log('LIVE_MCP_PASS_WITH_MEDIA',media.length);
