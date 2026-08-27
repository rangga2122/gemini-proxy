import http from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {KeyStore} from './lib/auth.js';
import {AdminAuth,DashboardAuth,UserStore,normalizeEmail,publicUser,validUserInput} from './lib/admin.js';
import {FixedWindow,SingleFlight} from './lib/limits.js';
import {UsageStore} from './lib/usage.js';
import {ArtifactStore} from './lib/artifacts.js';
import {GenClient} from './lib/gen-client.js';
import {createTools} from './lib/tools.js';
import {dispatch} from './lib/protocol.js';
const MAX=12*1024*1024, ADMIN_MAX=64*1024;

export async function createApp(o={}){
  const state=o.stateDir||process.env.MCP_STATE_DIR||join(process.cwd(),'mcp-state'),now=o.now||Date.now;
  const keys=new KeyStore(join(state,'keys.json')),users=new UserStore(join(state,'users.json'),{now}),usage=new UsageStore(join(state,'usage.json'));
  const admin=new AdminAuth(join(state,'admin-sessions.json'),{email:o.adminEmail??process.env.ADMIN_EMAIL,salt:o.adminPasswordSalt??process.env.ADMIN_PASSWORD_SALT,hash:o.adminPasswordHash??process.env.ADMIN_PASSWORD_HASH,ttlMs:Number(o.adminSessionTtlMs??process.env.ADMIN_SESSION_TTL_MS??28800000),now});
  const dashboard=new DashboardAuth(join(state,'dashboard-sessions.json'),{users,keys,ttlMs:Number(o.dashboardSessionTtlMs??process.env.DASHBOARD_SESSION_TTL_MS??28800000),now});
  const artifacts=o.artifacts||new ArtifactStore(join(state,'artifacts'));
  await Promise.all([keys.load(),users.load(),usage.load(),admin.load(),dashboard.load(),artifacts.init()]);
  const cleanupIntervalMs=positive(o.artifactCleanupIntervalMs??process.env.ARTIFACT_CLEANUP_INTERVAL_MS,900000);let cleanupRunning=null;
  const cleanup=()=>cleanupRunning||(cleanupRunning=Promise.resolve().then(()=>artifacts.cleanup()).catch(()=>{}).finally(()=>cleanupRunning=null));await cleanup();
  const artifactCleanupTimer=setInterval(cleanup,cleanupIntervalMs);artifactCleanupTimer.unref();
  const gen=new GenClient({baseUrl:o.genUrl||process.env.GEN_URL,apiKey:o.genKey||process.env.GEN_API_KEY});
  const tools=createTools(gen,artifacts,{publicBaseUrl:o.publicBaseUrl||process.env.PUBLIC_BASE_URL||'',limits:o.limits});
  const rate=new FixedWindow(now,{maxKeys:o.rateLimitMaxKeys||10000}),singleFlight=new SingleFlight(),adminRate=new FixedWindow(now,{maxKeys:10000}),bodyTimeoutMs=positive(o.bodyTimeoutMs??process.env.BODY_TIMEOUT_MS,10000);let closing=false;
  let mutationTail=Promise.resolve();const mutate=fn=>{const run=mutationTail.then(fn,fn);mutationTail=run.catch(()=>{});return run};
  const server=http.createServer(async(req,res)=>{security(res);try{
    const url=new URL(req.url||'/','http://localhost');
    if(req.method==='GET'&&url.pathname==='/health')return json(res,closing?503:200,{status:closing?'stopping':'ok'});
    if(needsAdminBody(req.method,url.pathname)){const parsed=await readAdminJson(req,res,bodyTimeoutMs);if(!parsed.ok)return;req.parsedBody=parsed.value}
    if(url.pathname.startsWith('/auth/'))return await mutate(()=>handleAuth(req,res,url,{admin,dashboard,users,keys,adminRate,now,o}));
    if(url.pathname.startsWith('/profile'))return await mutate(()=>handleProfile(req,res,url,{dashboard,users,keys,adminRate,now,o}));
    if(url.pathname.startsWith('/dashboard/'))return await handleDashboard(req,res,url,{dashboard,users,gen,usage,rate,singleFlight});
    if(url.pathname.startsWith('/admin/'))return await mutate(()=>handleAdmin(req,res,url,{admin,dashboard,users,keys,usage,adminRate,now,o}));
    const match=url.pathname.match(/^\/artifacts\/([a-f0-9]{32})$/);
    if(req.method==='GET'&&match){const a=await artifacts.get(match[1]);if(!a){res.writeHead(404);return res.end()}res.writeHead(200,{'content-type':a.mime,'cache-control':'private, max-age=60','content-disposition':`attachment; filename="${match[1]}.${extension(a.mime)}"`});return res.end(a.data)}
    if(req.method!=='POST'||url.pathname!=='/mcp'){res.writeHead(404);return res.end()}if(closing){res.writeHead(503);return res.end()}
    const token=bearer(req),record=token&&await keys.authenticate(token);if(!record)return unauthorized(res);
    let user=null;if(record.userId){user=users.get(record.userId);if(!user||!user.active||(user.expiresAt!==null&&Date.parse(user.expiresAt)<=now())||user.keyId!==record.id)return unauthorized(res)}
    const actor=record.userId?`user:${record.userId}`:`key:${record.id}`,rpm=user?(user.rpmLimit??20):(record.limit??o.rateLimit??30);
    const rl=rate.take(actor,rpm);res.setHeader('x-ratelimit-limit',String(rpm));res.setHeader('x-ratelimit-remaining',String(Math.max(0,rl.remaining??0)));if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'rate limit',rpmLimit:rpm})}
    const release=singleFlight.acquire(actor);if(!release){res.setHeader('retry-after','1');return json(res,429,{error:'Only one active API request is allowed per account'})}
    try{let query;try{query=JSON.parse(await body(req,MAX))}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})}
      const answer=await dispatch(query,tools),feature=mcpFeature(query);if(feature&&answer&&!answer.result?.isError)await usage.record(actor,feature).catch(()=>{});if(answer===null){res.writeHead(202);return res.end()}return json(res,200,answer)
    }finally{release()}
  }catch{return json(res,500,{error:'Internal error'})}});
  async function close(){if(closing)return;closing=true;clearInterval(artifactCleanupTimer);await cleanupRunning;tools.close?.();await new Promise(resolve=>server.close(()=>resolve()));await usage.close()}
  return {server,keys,users,usage,admin,dashboard,artifacts,tools,rate,singleFlight,artifactCleanupTimer,close};
}

const DASHBOARD_ROUTES=new Map([
  ['POST /dashboard/v1/images/generations','/v1/images/generations'],
  ['POST /dashboard/v1/images/variations','/v1/images/variations'],
  ['POST /dashboard/v1/chat/completions','/v1/chat/completions'],
  ['POST /dashboard/v1/audio/speech','/v1/audio/speech'],
  ['GET /dashboard/v1/tts/voices','/v1/tts/voices'],
  ['GET /dashboard/v1/status','/v1/status']
]);
async function handleDashboard(req,res,url,{dashboard,users,gen,usage,rate,singleFlight}){
  const path=DASHBOARD_ROUTES.get(`${req.method} ${url.pathname}`);if(!path)return notFound(res);
  const session=await dashboard.validate(sessionCookie(req));if(!session)return unauthorized(res);
  const actor=session.role==='user'?`user:${session.user.id}`:'admin',rpm=session.role==='user'?(users.get(session.user.id)?.rpmLimit??20):null;
  let release=null;if(req.method==='POST'&&session.role==='user'){const rl=rate.take(actor,rpm);res.setHeader('x-ratelimit-limit',String(rpm));res.setHeader('x-ratelimit-remaining',String(Math.max(0,rl.remaining??0)));if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'rate limit',rpmLimit:rpm})}release=singleFlight.acquire(actor);if(!release){res.setHeader('retry-after','1');return json(res,429,{error:'Only one active API request is allowed per account'})}}
  let value; if(req.method==='POST'){try{value=JSON.parse(await body(req,MAX))}catch{release?.();return json(res,400,{error:'Invalid request'})}}
  try{const result=await gen.request(path,{method:req.method,body:value}),feature=dashboardFeature(path,value);if(feature)await usage.record(actor,feature,featureCount(feature,result.json)).catch(()=>{});if(result.json!==undefined)return json(res,200,result.json);res.writeHead(200,{'content-type':result.mime});return res.end(result.data)}catch{return json(res,502,{error:'Backend unavailable'})}finally{release?.()}
}

async function handleAuth(req,res,url,c){
  const ip=req.socket.remoteAddress||'unknown';
  if(req.method==='POST'&&url.pathname==='/auth/login'){
    const limit=c.adminRate.take(`dashboard-login:${ip}`,Number(c.o.adminLoginRateLimit||10));if(!limit.ok)return json(res,429,{error:'Too many requests'});
    const v=req.parsedBody;if(!v||Object.keys(v).some(k=>!['email','credential'].includes(k))||typeof v.email!=='string'||typeof v.credential!=='string')return json(res,400,{error:'Invalid request'});
    let identity=null,legacy=await c.admin.login(v.email,v.credential);if(legacy){await c.admin.logout(legacy);identity={role:'admin',user:{email:c.admin.email}}}
    if(!identity){const user=c.users.findByEmail(v.email);if(user&&user.active&&(user.expiresAt===null||Date.parse(user.expiresAt)>c.now())&&c.users.verifyPassword(user,v.credential))identity={role:'user',userId:user.id}}
    if(!identity)return json(res,401,{error:'Invalid credentials'});const token=await c.dashboard.create(identity);if(!token)return json(res,429,{error:'Session limit reached'});const session=await c.dashboard.validate(token);res.setHeader('set-cookie',sessionCookieHeader(token));return json(res,200,{authenticated:true,...session});
  }
  const token=sessionCookie(req),session=await c.dashboard.validate(token);
  if(req.method==='GET'&&url.pathname==='/auth/session')return session?json(res,200,{authenticated:true,...session}):unauthorized(res);
  if(req.method==='POST'&&url.pathname==='/auth/logout'){if(token)await c.dashboard.logout(token);res.setHeader('set-cookie',sessionCookieHeader('',true));res.writeHead(204);return res.end()}
  return notFound(res);
}

async function handleProfile(req,res,url,c){
  const oldToken=sessionCookie(req),session=await c.dashboard.validate(oldToken);if(!session)return unauthorized(res);
  if(req.method==='GET'&&url.pathname==='/profile'){if(session.role==='admin')return json(res,200,{role:'admin',user:session.user,remainingMs:null});const u=c.users.get(session.user.id),key=u.keyId&&c.keys.records.find(k=>k.id===u.keyId&&k.active),remainingMs=u.expiresAt===null?null:Math.max(0,Math.floor(Date.parse(u.expiresAt)-c.now()));return json(res,200,{role:'user',user:publicUser(u),remainingMs,hasApiKey:Boolean(key),...(key?{keyId:key.id,keyCreatedAt:key.createdAt}:{})})}
  if(session.role!=='user')return json(res,403,{error:'Forbidden'});const u=c.users.get(session.user.id);
  const rl=c.adminRate.take(`profile:${u.id}`,Number(c.o.profileRateLimit??30));if(!rl.ok)return json(res,429,{error:'Too many requests'});
  if(req.method==='POST'&&url.pathname==='/profile/password'){const v=req.parsedBody,allowed=['currentPassword','newPassword','confirmPassword'];if(!v||Object.keys(v).length!==3||Object.keys(v).some(k=>!allowed.includes(k))||typeof v.currentPassword!=='string'||typeof v.newPassword!=='string'||typeof v.confirmPassword!=='string'||v.newPassword!==v.confirmPassword||v.newPassword.length<10||v.newPassword.length>1024)return json(res,400,{error:'Invalid request'});if(!c.users.verifyPassword(u,v.currentPassword))return json(res,401,{error:'Invalid credentials'});await c.users.setPassword(u.id,v.newPassword);await c.dashboard.revokeUser(u.id);const token=await c.dashboard.create({role:'user',userId:u.id});res.setHeader('set-cookie',sessionCookieHeader(token));return json(res,200,{changed:true})}
  if(req.method==='POST'&&url.pathname==='/profile/api-key'){const made=await c.keys.replaceForUser(u.keyId,u.label||u.email,{userId:u.id,email:u.email,limit:u.rpmLimit??20},{commit:id=>c.users.commitKey(u.id,id),rollback:id=>c.users.restoreKey(u.id,id)});return json(res,201,{key:made.key,keyId:made.id,createdAt:c.keys.records.find(k=>k.id===made.id).createdAt,rpmLimit:u.rpmLimit??20})}
  if(req.method==='DELETE'&&url.pathname==='/profile/api-key'){await deleteKey(c,u);res.writeHead(204);return res.end()}
  return notFound(res);
}

async function handleAdmin(req,res,url,c){
  const ip=req.socket.remoteAddress||'unknown',limit=c.adminRate.take(`admin:${ip}`,Number(c.o.adminRateLimit||60));if(!limit.ok)return json(res,429,{error:'Too many requests'});
  if(req.method==='POST'&&url.pathname==='/admin/login'){
    if(!c.admin.configured)return json(res,503,{error:'Admin authentication unavailable'});
    const loginLimit=c.adminRate.take(`login:${ip}`,Number(c.o.adminLoginRateLimit||10));if(!loginLimit.ok)return json(res,429,{error:'Too many requests'});
    const value=req.parsedBody;if(!value||Object.keys(value).some(k=>!['email','password'].includes(k))||typeof value.email!=='string'||typeof value.password!=='string')return json(res,400,{error:'Invalid request'});
    const token=await c.admin.login(value.email,value.password);return token?json(res,200,{token,expiresInMs:c.admin.ttlMs}):json(res,401,{error:'Invalid credentials'});
  }
  const token=bearer(req),legacy=token&&await c.admin.validate(token),session=!legacy&&await c.dashboard.validate(sessionCookie(req));if(!legacy&&!session)return unauthorized(res);if(session&&session.role!=='admin')return json(res,403,{error:'Forbidden'});
  if(req.method==='POST'&&url.pathname==='/admin/logout'){await c.admin.logout(token);res.writeHead(204);return res.end()}
  if(req.method==='GET'&&url.pathname==='/admin/users')return json(res,200,{users:c.users.list()});
  if(req.method==='GET'&&url.pathname==='/admin/stats')return json(res,200,await c.usage.report(c.users.list()));
  if(req.method==='POST'&&url.pathname==='/admin/users'){
    const value=req.parsedBody;if(!validUserInput(value))return json(res,400,{error:'Invalid request'});
    const result=await c.users.upsert(value);return json(res,result.created?201:200,{user:publicUser(result.user),...(result.password?{password:result.password}:{})});
  }
  const match=url.pathname.match(/^\/admin\/users\/([0-9a-f-]+)(\/(?:reset-password|api-key|rotate))?$/i);if(!match)return notFound(res);const user=c.users.get(match[1]);if(!user)return notFound(res);
  if(req.method==='POST'&&match[2]==='/reset-password'){const result=await c.users.resetPassword(user.id);await c.dashboard.revokeUser(user.id);return json(res,200,{user:publicUser(user),password:result.password})}
  if(req.method==='POST'&&match[2]==='/rotate'){const made=await c.keys.replaceForUser(user.keyId,user.label||user.email,{userId:user.id,email:user.email,limit:user.rpmLimit??20},{commit:id=>c.users.commitKey(user.id,id),rollback:id=>c.users.restoreKey(user.id,id)});return json(res,201,{key:made.key,keyId:made.id,createdAt:c.keys.records.find(k=>k.id===made.id).createdAt,rpmLimit:user.rpmLimit??20})}
  if(req.method==='DELETE'&&match[2]==='/api-key'){await deleteKey(c,user);res.writeHead(204);return res.end()}
  if(req.method==='PATCH'&&!match[2]){const value=req.parsedBody;if(!validUserInput(value,{partial:true}))return json(res,400,{error:'Invalid request'});await c.users.update(user.id,value);return json(res,200,{user:publicUser(user)})}
  if(req.method==='DELETE'&&!match[2]){await hardDelete(c,user.id);res.writeHead(204);return res.end()}
  return notFound(res);
}
async function deleteKey(c,user){const us=c.users.snapshot(),ks=c.keys.snapshot();try{if(user.keyId)await c.keys.revoke(user.keyId);await c.users.update(user.id,{keyId:null})}catch(error){try{await c.keys.restore(ks)}catch{}try{await c.users.restore(us)}catch{}throw error}}
async function hardDelete(c,id){const us=c.users.snapshot(),ks=c.keys.snapshot(),ss=c.dashboard.snapshot();try{const u=c.users.get(id);if(u?.keyId)await c.keys.revoke(u.keyId);await c.dashboard.revokeUser(id);await c.users.delete(id)}catch(error){try{await c.keys.restore(ks)}catch{}try{await c.dashboard.restore(ss)}catch{}try{await c.users.restore(us)}catch{}throw error}}
function needsAdminBody(method,path){return method==='POST'&&(path==='/auth/login'||path==='/profile/password'||path==='/admin/login'||path==='/admin/users')||method==='PATCH'&&/^\/admin\/users\/[0-9a-f-]+$/i.test(path)}
async function readAdminJson(req,res,timeoutMs){try{return {ok:true,value:JSON.parse(await body(req,ADMIN_MAX,timeoutMs))}}catch(error){if(error.code==='BODY_TIMEOUT'){res.setHeader('connection','close');json(res,408,{error:'Request timeout'});return {ok:false}}json(res,400,{error:'Invalid request'});return {ok:false}}}
function body(req,max,timeoutMs=10000){return new Promise((resolve,reject)=>{let n=0,a=[],done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};const timer=setTimeout(()=>{const error=new Error('body timeout');error.code='BODY_TIMEOUT';finish(error);req.resume()},timeoutMs);req.on('data',chunk=>{n+=chunk.length;if(n>max){const error=new Error('too large');error.code='BODY_TOO_LARGE';finish(error);req.resume()}else if(!done)a.push(chunk)});req.on('end',()=>finish(null,Buffer.concat(a).toString()));req.on('aborted',()=>finish(new Error('aborted')));req.on('error',finish)})}
function bearer(req){return req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,})$/)?.[1]}
function sessionCookie(req){const raw=req.headers.cookie;return typeof raw==='string'?raw.split(';').map(x=>x.trim()).find(x=>x.startsWith('dashboard_session='))?.slice('dashboard_session='.length):undefined}
function sessionCookieHeader(token,clear=false){return `dashboard_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${clear?'; Max-Age=0':''}`}
function json(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}function unauthorized(res){return json(res,401,{error:'Unauthorized'})}function notFound(res){res.writeHead(404);res.end()}
function positive(v,fallback){v=Number(v);return Number.isFinite(v)&&v>0?v:fallback}
function mcpFeature(query){if(query?.method!=='tools/call')return null;return {generate_image:'imageGenerate',edit_image:'imageEdit',analyze_image:'vision',chat_text:'chat',generate_audio:'audio'}[query.params?.name]||null}
function dashboardFeature(path,value){if(path==='/v1/images/generations')return'imageGenerate';if(path==='/v1/images/variations')return'imageEdit';if(path==='/v1/audio/speech')return'audio';if(path==='/v1/chat/completions')return value?.referenceImage||value?.image?'vision':'chat';return null}
function featureCount(feature,value){if(feature!=='imageGenerate'&&feature!=='imageEdit')return 1;const data=Array.isArray(value?.data)?value.data.length:0,images=Array.isArray(value?.images)?value.images.length:0,results=Array.isArray(value?.results)?value.results.filter(item=>item?.image||item?.url||item?.dataUrl).length:0;return Math.max(1,data,images,results)}
function security(res){res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('cache-control','no-store')}
function extension(mime){return {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg'}[mime]||'bin'}
if(process.argv[1]===fileURLToPath(import.meta.url)){const app=await createApp(),port=Number(process.env.PORT||3101);app.server.listen(port,process.env.HOST||'127.0.0.1');const stop=async()=>{await app.close();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop)}
