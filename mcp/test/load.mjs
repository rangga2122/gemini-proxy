import fs from 'node:fs';
const url=process.env.MCP_URL||'http://127.0.0.1:3101/mcp';
const keys=JSON.parse(fs.readFileSync(process.env.MCP_LOAD_KEYS||'/tmp/cosmic-mcp-load-keys.json','utf8'));
async function call(key,id,method='tools/list',params={}){
 const started=performance.now();
 const r=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
 const body=await r.json().catch(()=>null);
 return {status:r.status,ms:performance.now()-started,ok:r.ok&&!body?.error,body};
}
const jobs=[];
for(let i=0;i<keys.length;i++) for(let j=0;j<10;j++) jobs.push(call(keys[i],`${i}-${j}`,j%2?'tools/list':'tools/call',j%2?{}:{name:'get_service_status',arguments:{}}));
const results=await Promise.all(jobs);
const ok=results.filter(x=>x.ok).length, p95=results.map(x=>x.ms).sort((a,b)=>a-b)[Math.floor(results.length*.95)-1];
console.log(JSON.stringify({requests:results.length,ok,failed:results.length-ok,p95ms:Math.round(p95),statuses:Object.groupBy(results,x=>x.status)},(k,v)=>k==='statuses'?Object.fromEntries(Object.entries(v).map(([s,a])=>[s,a.length])):v));
if(ok!==results.length)process.exit(1);
// Dedicated rate-limit key: 35 parallel calls should include 429 but service stays healthy.
const rate=await Promise.all(Array.from({length:35},(_,i)=>call(keys.at(-1),`r${i}`)));
const limited=rate.filter(x=>x.status===429).length;
const health=await fetch(url.replace(/\/mcp$/,'/health/mcp')).then(r=>({status:r.status}));
console.log(JSON.stringify({rateLimit429:limited,health:health.status}));
if(limited<1||health.status!==200)process.exit(1);
console.log('LOAD_PASS');
