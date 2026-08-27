import http from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {KeyStore} from './lib/auth.js';
import {AdminAuth,UserStore,publicUser,validUserInput} from './lib/admin.js';
import {FixedWindow} from './lib/limits.js';
import {ArtifactStore} from './lib/artifacts.js';
import {GenClient} from './lib/gen-client.js';
import {createTools} from './lib/tools.js';
import {dispatch} from './lib/protocol.js';
const MAX=12*1024*1024, ADMIN_MAX=64*1024;

export async function createApp(o={}){
  const state=o.stateDir||process.env.MCP_STATE_DIR||join(process.cwd(),'mcp-state'),now=o.now||Date.now;
  const keys=new KeyStore(join(state,'keys.json')),users=new UserStore(join(state,'users.json'),{now});
  const admin=new AdminAuth(join(state,'admin-sessions.json'),{email:o.adminEmail??process.env.ADMIN_EMAIL,salt:o.adminPasswordSalt??process.env.ADMIN_PASSWORD_SALT,hash:o.adminPasswordHash??process.env.ADMIN_PASSWORD_HASH,ttlMs:Number(o.adminSessionTtlMs??process.env.ADMIN_SESSION_TTL_MS??28800000),now});
  const artifacts=o.artifacts||new ArtifactStore(join(state,'artifacts'));
  await Promise.all([keys.load(),users.load(),admin.load(),artifacts.init()]);
  const cleanupIntervalMs=positive(o.artifactCleanupIntervalMs??process.env.ARTIFACT_CLEANUP_INTERVAL_MS,900000);let cleanupRunning=null;
  const cleanup=()=>cleanupRunning||(cleanupRunning=Promise.resolve().then(()=>artifacts.cleanup()).catch(()=>{}).finally(()=>cleanupRunning=null));await cleanup();
  const artifactCleanupTimer=setInterval(cleanup,cleanupIntervalMs);artifactCleanupTimer.unref();
  const tools=createTools(new GenClient({baseUrl:o.genUrl||process.env.GEN_URL,apiKey:o.genKey||process.env.GEN_API_KEY}),artifacts,{publicBaseUrl:o.publicBaseUrl||process.env.PUBLIC_BASE_URL||'',limits:o.limits});
  const rate=new FixedWindow(now,{maxKeys:o.rateLimitMaxKeys||10000}),adminRate=new FixedWindow(now,{maxKeys:10000});let closing=false;
  const server=http.createServer(async(req,res)=>{security(res);try{
    const url=new URL(req.url||'/','http://localhost');
    if(req.method==='GET'&&url.pathname==='/health')return json(res,closing?503:200,{status:closing?'stopping':'ok'});
    if(url.pathname.startsWith('/admin/'))return await handleAdmin(req,res,url,{admin,users,keys,adminRate,now,o});
    const match=url.pathname.match(/^\/artifacts\/([a-f0-9]{32})$/);
    if(req.method==='GET'&&match){const a=await artifacts.get(match[1]);if(!a){res.writeHead(404);return res.end()}res.writeHead(200,{'content-type':a.mime,'cache-control':'private, max-age=60','content-disposition':`attachment; filename="${match[1]}.${extension(a.mime)}"`});return res.end(a.data)}
    if(req.method!=='POST'||url.pathname!=='/mcp'){res.writeHead(404);return res.end()}if(closing){res.writeHead(503);return res.end()}
    const token=bearer(req),record=token&&await keys.authenticate(token);if(!record)return unauthorized(res);
    if(record.userId){const user=users.get(record.userId);if(!user||!user.active||(user.expiresAt!==null&&Date.parse(user.expiresAt)<=now())||user.keyId!==record.id)return unauthorized(res)}
    const rl=rate.take(record.id,record.limit||o.rateLimit||30);if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'rate limit'})}
    let query;try{query=JSON.parse(await body(req,MAX))}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})}
    const answer=await dispatch(query,tools);if(answer===null){res.writeHead(202);return res.end()}return json(res,200,answer);
  }catch{return json(res,500,{error:'Internal error'})}});
  async function close(){if(closing)return;closing=true;clearInterval(artifactCleanupTimer);await cleanupRunning;tools.close?.();await new Promise(resolve=>server.close(()=>resolve()))}
  return {server,keys,users,admin,artifacts,tools,artifactCleanupTimer,close};
}

async function handleAdmin(req,res,url,c){
  const ip=req.socket.remoteAddress||'unknown',limit=c.adminRate.take(`admin:${ip}`,Number(c.o.adminRateLimit||60));if(!limit.ok)return json(res,429,{error:'Too many requests'});
  if(req.method==='POST'&&url.pathname==='/admin/login'){
    if(!c.admin.configured)return json(res,503,{error:'Admin authentication unavailable'});
    const loginLimit=c.adminRate.take(`login:${ip}`,Number(c.o.adminLoginRateLimit||10));if(!loginLimit.ok)return json(res,429,{error:'Too many requests'});
    const value=await jsonBody(req);if(!value||Object.keys(value).some(k=>!['email','password'].includes(k))||typeof value.email!=='string'||typeof value.password!=='string')return json(res,400,{error:'Invalid request'});
    const token=await c.admin.login(value.email,value.password);return token?json(res,200,{token,expiresInMs:c.admin.ttlMs}):json(res,401,{error:'Invalid credentials'});
  }
  const token=bearer(req);if(!token||!await c.admin.validate(token))return unauthorized(res);
  if(req.method==='POST'&&url.pathname==='/admin/logout'){await c.admin.logout(token);res.writeHead(204);return res.end()}
  if(req.method==='GET'&&url.pathname==='/admin/users')return json(res,200,{users:c.users.list()});
  if(req.method==='POST'&&url.pathname==='/admin/users'){
    const value=await jsonBody(req);if(!validUserInput(value))return json(res,400,{error:'Invalid request'});
    const result=await c.users.upsert(value);let key;if(result.created){const made=await c.keys.create(result.user.label||result.user.email,{userId:result.user.id,email:result.user.email});key=made.key;await c.users.update(result.user.id,{keyId:made.id})}
    return json(res,result.created?201:200,{user:publicUser(result.user),...(key?{key}:{})});
  }
  const match=url.pathname.match(/^\/admin\/users\/([0-9a-f-]+)(\/rotate)?$/i);if(!match)return notFound(res);const user=c.users.get(match[1]);if(!user)return notFound(res);
  if(req.method==='POST'&&match[2]==='/rotate'){
    if(user.keyId)await c.keys.revoke(user.keyId);const made=await c.keys.create(user.label||user.email,{userId:user.id,email:user.email});await c.users.update(user.id,{keyId:made.id});return json(res,200,{user:publicUser(user),key:made.key});
  }
  if(req.method==='PATCH'&&!match[2]){const value=await jsonBody(req);if(!validUserInput(value,{partial:true}))return json(res,400,{error:'Invalid request'});await c.users.update(user.id,value);return json(res,200,{user:publicUser(user)})}
  if(req.method==='DELETE'&&!match[2]){if(user.keyId)await c.keys.revoke(user.keyId);await c.users.update(user.id,{active:false});res.writeHead(204);return res.end()}
  return notFound(res);
}
async function jsonBody(req){try{const raw=await body(req,ADMIN_MAX);return JSON.parse(raw)}catch{return null}}
function body(req,max){return new Promise((resolve,reject)=>{let n=0,a=[];req.on('data',chunk=>{n+=chunk.length;if(n>max){reject(new Error('too large'));req.destroy()}else a.push(chunk)});req.on('end',()=>resolve(Buffer.concat(a).toString()));req.on('error',reject)})}
function bearer(req){return req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,})$/)?.[1]}
function json(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}function unauthorized(res){return json(res,401,{error:'Unauthorized'})}function notFound(res){res.writeHead(404);res.end()}
function positive(v,fallback){v=Number(v);return Number.isFinite(v)&&v>0?v:fallback}
function security(res){res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('cache-control','no-store')}
function extension(mime){return {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg'}[mime]||'bin'}
if(process.argv[1]===fileURLToPath(import.meta.url)){const app=await createApp(),port=Number(process.env.PORT||3101);app.server.listen(port,process.env.HOST||'127.0.0.1');const stop=async()=>{await app.close();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop)}
