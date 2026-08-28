import http from 'node:http';
import net from 'node:net';
import {dirname,join} from 'node:path';
import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {KeyStore} from './lib/auth.js';
import {AdminAuth,DashboardAuth,UserStore,normalizeEmail,publicUser,validUserInput,passwordVerifier,userEntitlement,DEFAULT_RPM,DEFAULT_WORKERS,normalizeWorkerLimit} from './lib/admin.js';
import {TrialStore} from './lib/trial.js';
import {createMailer} from './lib/mailer.js';
import {BillingService,PakasirClient} from './lib/billing.js';
import {FixedWindow,SingleFlight} from './lib/limits.js';
import {UsageStore} from './lib/usage.js';
import {ArtifactStore} from './lib/artifacts.js';
import {GenClient} from './lib/gen-client.js';
import {createTools} from './lib/tools.js';
import {dispatch} from './lib/protocol.js';
const MAX=12*1024*1024, ADMIN_MAX=64*1024;

export async function createApp(o={}){
  const trustProxy=o.trustProxy===true||process.env.TRUST_PROXY==='true'||process.env.TRUST_PROXY==='1';
  const state=o.stateDir||process.env.MCP_STATE_DIR||join(process.cwd(),'mcp-state'),now=o.now||Date.now;
  const keys=new KeyStore(join(state,'keys.json')),users=new UserStore(join(state,'users.json'),{now}),usage=new UsageStore(join(state,'usage.json'));
  const admin=new AdminAuth(join(state,'admin-sessions.json'),{email:o.adminEmail??process.env.ADMIN_EMAIL,salt:o.adminPasswordSalt??process.env.ADMIN_PASSWORD_SALT,hash:o.adminPasswordHash??process.env.ADMIN_PASSWORD_HASH,ttlMs:Number(o.adminSessionTtlMs??process.env.ADMIN_SESSION_TTL_MS??28800000),now});
  const dashboard=new DashboardAuth(join(state,'dashboard-sessions.json'),{users,keys,ttlMs:Number(o.dashboardSessionTtlMs??process.env.DASHBOARD_SESSION_TTL_MS??28800000),now});
  const artifacts=o.artifacts||new ArtifactStore(join(state,'artifacts'));
  let trial=o.trialStore??null,mailer=o.mailer??null,trialConfigured=true;
  try{if(!trial)trial=new TrialStore(join(state,'trial.json'),{ledgerSecret:o.trialLedgerSecret??process.env.TRIAL_LEDGER_SECRET});if(!mailer)mailer=createMailer(process.env)}catch{trialConfigured=false;trial=null;mailer=null}
  await Promise.all([keys.load(),users.load(),usage.load(),admin.load(),dashboard.load(),artifacts.init(),trial?.load?.()]);
  const pakasir=o.pakasirClient||new PakasirClient({baseUrl:o.pakasirBaseUrl??process.env.PAKASIR_BASE_URL,projectSlug:o.pakasirProjectSlug??process.env.PAKASIR_PROJECT_SLUG,apiKey:o.pakasirApiKey??process.env.PAKASIR_API_KEY,fetchImpl:o.pakasirFetch||fetch});
  const billing=o.billing||new BillingService(join(state,'billing.json'),{users,client:pakasir,mailer,onCredentialsSet:userId=>dashboard.revokeUser(userId),credentialGenerator:o.billingCredentialGenerator,now,price:Number(o.planPriceIdr??process.env.PLAN_PRICE_IDR??35000),orderTtlMs:positive(o.billingOrderTtlMs??process.env.BILLING_ORDER_TTL_MS,1200000)});await billing.load();
  const activationJournal=join(state,'activation-journal.json');
  if(trial)await recoverActivationJournal(activationJournal,{users,trial,dashboard});
  const cleanupIntervalMs=positive(o.artifactCleanupIntervalMs??process.env.ARTIFACT_CLEANUP_INTERVAL_MS,900000);let cleanupRunning=null;
  const cleanup=()=>cleanupRunning||(cleanupRunning=Promise.resolve().then(()=>artifacts.cleanup()).catch(()=>{}).finally(()=>cleanupRunning=null));await cleanup();
  const artifactCleanupTimer=setInterval(cleanup,cleanupIntervalMs);artifactCleanupTimer.unref();
  let trialCleanupRunning=null;const trialCleanup=()=>trial&&!trialCleanupRunning?(trialCleanupRunning=trial.cleanup().catch(()=>{}).finally(()=>trialCleanupRunning=null)):trialCleanupRunning;await trialCleanup();const trialCleanupTimer=setInterval(trialCleanup,positive(o.trialCleanupIntervalMs,900000));trialCleanupTimer.unref();
  let billingCheckRunning=null;const billingCheck=()=>!billingCheckRunning?(billingCheckRunning=billing.checkPending().catch(()=>{}).finally(()=>billingCheckRunning=null)):billingCheckRunning;const billingCheckTimer=setInterval(billingCheck,positive(o.billingCheckIntervalMs??process.env.BILLING_CHECK_INTERVAL_MS,60000));billingCheckTimer.unref();
  const gen=new GenClient({baseUrl:o.genUrl||process.env.GEN_URL,apiKey:o.genKey||process.env.GEN_API_KEY});
  const tools=createTools(gen,artifacts,{publicBaseUrl:o.publicBaseUrl||process.env.PUBLIC_BASE_URL||'',limits:o.limits});
  const rate=new FixedWindow(now,{maxKeys:o.rateLimitMaxKeys||10000}),singleFlight=new SingleFlight(DEFAULT_WORKERS),adminRate=new FixedWindow(now,{maxKeys:10000}),trialAttemptRate=new FixedWindow(now,{maxKeys:positive(o.trialAttemptRateMaxKeys??process.env.TRIAL_ATTEMPT_RATE_MAX_KEYS,10000)}),bodyTimeoutMs=positive(o.bodyTimeoutMs??process.env.BODY_TIMEOUT_MS,10000);let closing=false;
  let mutationTail=Promise.resolve();const mutate=fn=>{const run=mutationTail.then(fn,fn);mutationTail=run.catch(()=>{});return run};
  const server=http.createServer(async(req,res)=>{security(res);try{
    req.clientIp=clientIp(req,trustProxy);
    const url=new URL(req.url||'/','http://localhost');
    if(req.method==='GET'&&url.pathname==='/health')return json(res,closing?503:200,{status:closing?'stopping':'ok',trial:trialConfigured?'ready':'unavailable'});
    if(req.method==='GET'&&url.pathname==='/billing/plan')return json(res,200,billing.plan());
    if(req.method==='POST'&&(url.pathname==='/auth/trial/request'||url.pathname==='/auth/trial/verify')){if(!trialConfigured)return json(res,503,{error:'Service unavailable'});const kind=url.pathname.endsWith('/verify')?'verify':'request',limit=Number(kind==='verify'?(o.trialVerifyAttemptLimit??process.env.TRIAL_VERIFY_ATTEMPT_LIMIT??20):(o.trialRequestAttemptLimit??process.env.TRIAL_REQUEST_ATTEMPT_LIMIT??10)),ipKey=trial.opaqueIpKey(req.clientIp),rl=trialAttemptRate.take(`${kind}:${ipKey}`,limit);if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'Too many requests'})}}
    if(needsAdminBody(req.method,url.pathname)){const parsed=await readAdminJson(req,res,bodyTimeoutMs);if(!parsed.ok)return;req.parsedBody=parsed.value}
    if(url.pathname==='/auth/trial/request')return await handleTrialRequest(req,res,{trial,mailer,trialConfigured,users,adminRate,now,o,mutate});
    if(url.pathname.startsWith('/auth/'))return await mutate(()=>handleAuth(req,res,url,{admin,dashboard,users,keys,trial,trialConfigured,adminRate,now,o,activationJournal}));
    if(url.pathname.startsWith('/profile'))return await mutate(()=>handleProfile(req,res,url,{dashboard,users,keys,adminRate,now,o}));
    if(url.pathname.startsWith('/billing/'))return await handleBilling(req,res,url,{billing,dashboard,users,adminRate,o});
    if(url.pathname.startsWith('/dashboard/'))return await handleDashboard(req,res,url,{dashboard,users,gen,usage,rate,singleFlight});
    if(url.pathname.startsWith('/admin/'))return await mutate(()=>handleAdmin(req,res,url,{admin,dashboard,users,keys,usage,adminRate,now,o}));
    const match=url.pathname.match(/^\/artifacts\/([a-f0-9]{32})$/);
    if(req.method==='GET'&&match){const a=await artifacts.get(match[1]);if(!a){res.writeHead(404);return res.end()}res.writeHead(200,{'content-type':a.mime,'cache-control':'private, max-age=60','content-disposition':`attachment; filename="${match[1]}.${extension(a.mime)}"`});return res.end(a.data)}
    if(req.method!=='POST'||url.pathname!=='/mcp'){res.writeHead(404);return res.end()}if(closing){res.writeHead(503);return res.end()}
    const token=bearer(req),record=token&&await keys.authenticate(token);if(!record)return unauthorized(res);
    let user=null;if(record.userId){user=users.get(record.userId);if(!user||!user.active||(user.expiresAt!==null&&Date.parse(user.expiresAt)<=now())||user.keyId!==record.id)return unauthorized(res)}
    const actor=record.userId?`user:${record.userId}`:`key:${record.id}`,rpm=user?(user.rpmLimit??DEFAULT_RPM):(record.limit??o.rateLimit??30),workers=normalizeWorkerLimit(user?.workerLimit);
    const rl=rate.take(actor,rpm);res.setHeader('x-ratelimit-limit',String(rpm));res.setHeader('x-ratelimit-remaining',String(Math.max(0,rl.remaining??0)));if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'rate limit',rpmLimit:rpm})}
    const release=singleFlight.acquire(actor,workers);if(!release){res.setHeader('retry-after','1');return json(res,429,{error:`Maximum ${workers} active API requests are allowed per account`,workerLimit:workers})}
    try{let query;try{query=JSON.parse(await body(req,MAX))}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})}
      const answer=await dispatch(query,tools),feature=mcpFeature(query);if(feature&&answer&&!answer.result?.isError)await usage.record(actor,feature).catch(()=>{});if(answer===null){res.writeHead(202);return res.end()}return json(res,200,answer)
    }finally{release()}
  }catch{return json(res,500,{error:'Internal error'})}});
  async function close(){if(closing)return;closing=true;clearInterval(artifactCleanupTimer);clearInterval(trialCleanupTimer);clearInterval(billingCheckTimer);await Promise.all([cleanupRunning,trialCleanupRunning,billingCheckRunning]);tools.close?.();await new Promise(resolve=>server.close(()=>resolve()));await Promise.all([usage.close(),trial?.close?.(),billing.close()])}
  return {server,keys,users,usage,admin,dashboard,trial,billing,artifacts,tools,rate,trialAttemptRate,singleFlight,artifactCleanupTimer,billingCheckTimer,close};
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
  if(session.entitlement==='profile-only')return json(res,403,{error:'Forbidden'});
  const actor=session.role==='user'?`user:${session.user.id}`:'admin',user=session.role==='user'?users.get(session.user.id):null,rpm=user?(user.rpmLimit??DEFAULT_RPM):null,workers=normalizeWorkerLimit(user?.workerLimit);
  let release=null;if(req.method==='POST'&&session.role==='user'){const rl=rate.take(actor,rpm);res.setHeader('x-ratelimit-limit',String(rpm));res.setHeader('x-ratelimit-remaining',String(Math.max(0,rl.remaining??0)));if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'rate limit',rpmLimit:rpm})}release=singleFlight.acquire(actor,workers);if(!release){res.setHeader('retry-after','1');return json(res,429,{error:`Maximum ${workers} active API requests are allowed per account`,workerLimit:workers})}}
  let value; if(req.method==='POST'){try{value=JSON.parse(await body(req,MAX))}catch{release?.();return json(res,400,{error:'Invalid request'})}}
  try{const result=await gen.request(path,{method:req.method,body:value}),feature=dashboardFeature(path,value);if(feature)await usage.record(actor,feature,featureCount(feature,result.json)).catch(()=>{});if(result.json!==undefined)return json(res,200,result.json);res.writeHead(200,{'content-type':result.mime});return res.end(result.data)}catch{return json(res,502,{error:'Backend unavailable'})}finally{release?.()}
}

async function handleAuth(req,res,url,c){
  const ip=req.clientIp;
  if(req.method==='POST'&&url.pathname==='/auth/login'){
    const limit=c.adminRate.take(`dashboard-login:${ip}`,Number(c.o.adminLoginRateLimit||10));if(!limit.ok)return json(res,429,{error:'Too many requests'});
    const v=req.parsedBody;if(!v||Object.keys(v).some(k=>!['email','credential'].includes(k))||typeof v.email!=='string'||typeof v.credential!=='string')return json(res,400,{error:'Invalid request'});
    let identity=null,legacy=await c.admin.login(v.email,v.credential);if(legacy){await c.admin.logout(legacy);identity={role:'admin',user:{email:c.admin.email}}}
    if(!identity){const user=c.users.findByEmail(v.email);if(user&&userEntitlement(user,c.now())&&await c.users.consumeLoginCredential(user,v.credential))identity={role:'user',userId:user.id}}
    if(!identity)return json(res,401,{error:'Invalid credentials'});const token=await c.dashboard.create(identity);if(!token)return json(res,429,{error:'Session limit reached'});const session=await c.dashboard.validate(token);res.setHeader('set-cookie',sessionCookieHeader(token));return json(res,200,{authenticated:true,...session});
  }
  if(req.method==='POST'&&url.pathname==='/auth/trial/verify'){
    if(!c.trialConfigured)return json(res,503,{error:'Service unavailable'});const v=req.parsedBody;
    if(!v||Object.keys(v).length!==2||typeof v.email!=='string'||typeof v.otp!=='string'||!/^\d{6}$/.test(v.otp))return json(res,400,{error:'Invalid request'});let email;try{email=normalizeTrialEmail(v.email)}catch{return json(res,400,{error:'Invalid request'})}
    const begun=await c.trial.beginVerification(email,v.otp).catch(()=>null);if(!begun?.ok)return json(res,400,{error:'Invalid or expired code'});const us=c.users.snapshot(),ts=await c.trial.snapshot(),ss=c.dashboard.snapshot();await writeJournal(c.activationJournal,{version:1,users:us,trial:ts,dashboard:ss});try{const stamp=c.now(),user=await c.users.createTrial({email,label:email.split('@')[0].slice(0,200),passwordVerifier:begun.passwordVerifier,now:stamp});await c.trial.commitActivation(begun.reservationId,{userId:user.id,verifiedAt:stamp});const token=await c.dashboard.create({role:'user',userId:user.id});if(!token)throw new Error('session failed');await unlink(c.activationJournal);const session=await c.dashboard.validate(token);res.setHeader('set-cookie',sessionCookieHeader(token));return json(res,201,{authenticated:true,...session})}catch(e){let clean=true;for(const op of [()=>c.users.restore(us),()=>c.trial.restore(ts),()=>c.dashboard.restore(ss),()=>c.trial.abortActivation(begun.reservationId)])try{await op()}catch{clean=false}if(clean)await unlink(c.activationJournal).catch(()=>{clean=false});throw e}
  }
  const token=sessionCookie(req),session=await c.dashboard.validate(token);
  if(req.method==='GET'&&url.pathname==='/auth/session')return session?json(res,200,{authenticated:true,...session}):unauthorized(res);
  if(req.method==='POST'&&url.pathname==='/auth/logout'){if(token)await c.dashboard.logout(token);res.setHeader('set-cookie',sessionCookieHeader('',true));res.writeHead(204);return res.end()}
  return notFound(res);
}
async function handleTrialRequest(req,res,c){
  if(!c.trialConfigured)return json(res,503,{error:'Service unavailable'});const v=req.parsedBody;if(!v||Object.keys(v).length!==3||typeof v.email!=='string'||typeof v.password!=='string'||typeof v.confirmPassword!=='string'||v.password!==v.confirmPassword||v.password.length<10||v.password.length>1024)return json(res,400,{error:'Invalid request'});let email;try{email=normalizeTrialEmail(v.email)}catch{return json(res,400,{error:'Invalid request'})}const started=Date.now(),floor=Math.max(0,Number(c.o.trialRequestMinResponseMs??process.env.TRIAL_REQUEST_MIN_RESPONSE_MS??500)||0),accepted=async()=>{const wait=floor-(Date.now()-started);if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));return json(res,202,{accepted:true,message:'Jika memenuhi syarat, kode verifikasi telah dikirim.'})};const ip=req.clientIp;let r;try{r=await c.mutate(async()=>{if(c.users.findByEmail(email)||await c.trial.hasConsumed(email))return null;return c.trial.reserveSend(email,passwordVerifier(v.password),{opaqueIp:ip})})}catch{return accepted()}if(!r)return accepted();try{await c.mailer.sendTrialOtp({to:email,otp:r.otp,expiresMinutes:10});await c.mutate(()=>c.trial.commitSend(r.reservationId))}catch{await c.trial.abortSend(r.reservationId).catch(()=>{})}return accepted()
}

async function handleBilling(req,res,url,c){
  try{
    if(req.method==='POST'&&url.pathname==='/billing/public/order'){
      const rl=c.adminRate.take(`billing-public-create:${req.clientIp}`,Number(c.o.publicBillingRateLimit??10));if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'Terlalu banyak percobaan. Coba lagi nanti.'})}const value=req.parsedBody,allowed=['email','phone'];if(!value||Object.keys(value).length!==2||Object.keys(value).some(key=>!allowed.includes(key))||typeof value.email!=='string'||typeof value.phone!=='string')return json(res,400,{error:'Email atau nomor HP tidak valid.'});let email,phone;try{email=normalizeTrialEmail(value.email);phone=normalizePhone(value.phone)}catch{return json(res,400,{error:'Email atau nomor HP tidak valid.'})}const user=c.users.findByEmail(email),created=await c.billing.createPublic({email,phone,user});res.setHeader('set-cookie',checkoutCookieHeader(created.checkoutToken));return json(res,201,created.order)
    }
    if(req.method==='GET'&&url.pathname==='/billing/public/order'){const rl=c.adminRate.take(`billing-public-status:${req.clientIp}`,60);if(!rl.ok)return json(res,429,{error:'Terlalu banyak pemeriksaan.'});const result=await c.billing.latestPublic(checkoutCookie(req),{force:true});return finishPublicCheckout(res,result)}
    const publicMatch=url.pathname.match(/^\/billing\/public\/order\/([A-Za-z0-9-]{8,80})$/);if(req.method==='GET'&&publicMatch){const rl=c.adminRate.take(`billing-public-status:${req.clientIp}`,60);if(!rl.ok)return json(res,429,{error:'Terlalu banyak pemeriksaan.'});const result=await c.billing.statusPublic(publicMatch[1],checkoutCookie(req),{force:true});return finishPublicCheckout(res,result)}
    const session=await c.dashboard.validate(sessionCookie(req));if(!session)return unauthorized(res);if(session.role!=='user')return json(res,403,{error:'Forbidden'});
    const rl=c.adminRate.take(`billing:${session.user.id}:${req.clientIp}`,30);if(!rl.ok){res.setHeader('retry-after',String(Math.ceil(rl.retryAfterMs/1000)));return json(res,429,{error:'Too many requests'})}
    if(req.method==='POST'&&url.pathname==='/billing/order'){const user=c.billing.users.get(session.user.id);return json(res,201,await c.billing.create(user))}
    if(req.method==='GET'&&url.pathname==='/billing/order')return json(res,200,{order:await c.billing.latest(session.user.id)});
    const match=url.pathname.match(/^\/billing\/order\/([A-Za-z0-9-]{8,80})$/);if(req.method==='GET'&&match)return json(res,200,await c.billing.status(match[1],session.user.id,{force:true}));
    return notFound(res);
  }catch(error){return json(res,Number.isInteger(error?.status)?error.status:500,{error:Number.isInteger(error?.status)?error.message:'Pembayaran belum dapat diproses.'})}
}
async function finishPublicCheckout(res,result){if(result.order.status==='paid'&&result.order.credentialDeliveryStatus==='sent')res.setHeader('set-cookie',checkoutCookieHeader('',true));return json(res,200,result.order)}

async function writeJournal(file,value){await mkdir(dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,file)}
async function recoverActivationJournal(file,stores){let value;try{value=JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return;throw e}if(value?.version!==1||!Array.isArray(value.users)||!value.trial||!Array.isArray(value.dashboard))throw new Error('Invalid activation recovery journal');await stores.users.restore(value.users);await stores.trial.restore(value.trial);await stores.dashboard.restore(value.dashboard);await unlink(file)}
function normalizeTrialEmail(v){if(typeof v!=='string')throw new Error();const e=v.trim().toLowerCase();if(!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e))throw new Error();return e}

async function handleProfile(req,res,url,c){
  const oldToken=sessionCookie(req),session=await c.dashboard.validate(oldToken);if(!session)return unauthorized(res);
  if(req.method==='GET'&&url.pathname==='/profile'){if(session.role==='admin')return json(res,200,{role:'admin',user:session.user,remainingMs:null});const u=c.users.get(session.user.id),key=u.keyId&&c.keys.records.find(k=>k.id===u.keyId&&k.active),remainingMs=u.expiresAt===null?null:Math.max(0,Math.floor(Date.parse(u.expiresAt)-c.now()));return json(res,200,{role:'user',entitlement:session.entitlement,user:publicUser(u),remainingMs,rpmLimit:u.rpmLimit??DEFAULT_RPM,workerLimit:normalizeWorkerLimit(u.workerLimit),hasApiKey:Boolean(key),...(key?{keyId:key.id,keyCreatedAt:key.createdAt}:{})})}
  if(session.role!=='user')return json(res,403,{error:'Forbidden'});const u=c.users.get(session.user.id);
  const rl=c.adminRate.take(`profile:${u.id}:${req.clientIp}`,Number(c.o.profileRateLimit??30));if(!rl.ok)return json(res,429,{error:'Too many requests'});
  if(req.method==='POST'&&url.pathname==='/profile/password'){const v=req.parsedBody,allowed=['currentPassword','newPassword','confirmPassword'];if(!v||Object.keys(v).length!==3||Object.keys(v).some(k=>!allowed.includes(k))||typeof v.currentPassword!=='string'||typeof v.newPassword!=='string'||typeof v.confirmPassword!=='string'||v.newPassword!==v.confirmPassword||v.newPassword.length<10||v.newPassword.length>1024)return json(res,400,{error:'Invalid request'});if(!c.users.verifyPassword(u,v.currentPassword))return json(res,401,{error:'Invalid credentials'});await c.users.setPassword(u.id,v.newPassword);await c.dashboard.revokeUser(u.id);const token=await c.dashboard.create({role:'user',userId:u.id});res.setHeader('set-cookie',sessionCookieHeader(token));return json(res,200,{changed:true})}
  if(req.method==='POST'&&url.pathname==='/profile/api-key'){if(session.entitlement==='profile-only')return json(res,403,{error:'Forbidden'});const made=await c.keys.replaceForUser(u.keyId,u.label||u.email,{userId:u.id,email:u.email,limit:u.rpmLimit??DEFAULT_RPM},{commit:id=>c.users.commitKey(u.id,id),rollback:id=>c.users.restoreKey(u.id,id)});return json(res,201,{key:made.key,keyId:made.id,createdAt:c.keys.records.find(k=>k.id===made.id).createdAt,rpmLimit:u.rpmLimit??DEFAULT_RPM,workerLimit:normalizeWorkerLimit(u.workerLimit)})}
  if(req.method==='DELETE'&&url.pathname==='/profile/api-key'){await deleteKey(c,u);res.writeHead(204);return res.end()}
  return notFound(res);
}

async function handleAdmin(req,res,url,c){
  const ip=req.clientIp,limit=c.adminRate.take(`admin:${ip}`,Number(c.o.adminRateLimit||60));if(!limit.ok)return json(res,429,{error:'Too many requests'});
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
  if(req.method==='POST'&&match[2]==='/rotate'){const made=await c.keys.replaceForUser(user.keyId,user.label||user.email,{userId:user.id,email:user.email,limit:user.rpmLimit??DEFAULT_RPM},{commit:id=>c.users.commitKey(user.id,id),rollback:id=>c.users.restoreKey(user.id,id)});return json(res,201,{key:made.key,keyId:made.id,createdAt:c.keys.records.find(k=>k.id===made.id).createdAt,rpmLimit:user.rpmLimit??DEFAULT_RPM,workerLimit:normalizeWorkerLimit(user.workerLimit)})}
  if(req.method==='DELETE'&&match[2]==='/api-key'){await deleteKey(c,user);res.writeHead(204);return res.end()}
  if(req.method==='PATCH'&&!match[2]){const value=req.parsedBody;if(!validUserInput(value,{partial:true}))return json(res,400,{error:'Invalid request'});await c.users.update(user.id,value);return json(res,200,{user:publicUser(user)})}
  if(req.method==='DELETE'&&!match[2]){await hardDelete(c,user.id);res.writeHead(204);return res.end()}
  return notFound(res);
}
async function deleteKey(c,user){const us=c.users.snapshot(),ks=c.keys.snapshot();try{if(user.keyId)await c.keys.revoke(user.keyId);await c.users.update(user.id,{keyId:null})}catch(error){try{await c.keys.restore(ks)}catch{}try{await c.users.restore(us)}catch{}throw error}}
async function hardDelete(c,id){const us=c.users.snapshot(),ks=c.keys.snapshot(),ss=c.dashboard.snapshot();try{const u=c.users.get(id);if(u?.keyId)await c.keys.revoke(u.keyId);await c.dashboard.revokeUser(id);await c.users.delete(id)}catch(error){try{await c.keys.restore(ks)}catch{}try{await c.dashboard.restore(ss)}catch{}try{await c.users.restore(us)}catch{}throw error}}
function needsAdminBody(method,path){return method==='POST'&&(path==='/auth/login'||path==='/auth/trial/request'||path==='/auth/trial/verify'||path==='/profile/password'||path==='/admin/login'||path==='/admin/users'||path==='/billing/public/order')||method==='PATCH'&&/^\/admin\/users\/[0-9a-f-]+$/i.test(path)}
async function readAdminJson(req,res,timeoutMs){try{return {ok:true,value:JSON.parse(await body(req,ADMIN_MAX,timeoutMs))}}catch(error){if(error.code==='BODY_TIMEOUT'){res.setHeader('connection','close');json(res,408,{error:'Request timeout'});return {ok:false}}json(res,400,{error:'Invalid request'});return {ok:false}}}
function body(req,max,timeoutMs=10000){return new Promise((resolve,reject)=>{let n=0,a=[],done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};const timer=setTimeout(()=>{const error=new Error('body timeout');error.code='BODY_TIMEOUT';finish(error);req.resume()},timeoutMs);req.on('data',chunk=>{n+=chunk.length;if(n>max){const error=new Error('too large');error.code='BODY_TOO_LARGE';finish(error);req.resume()}else if(!done)a.push(chunk)});req.on('end',()=>finish(null,Buffer.concat(a).toString()));req.on('aborted',()=>finish(new Error('aborted')));req.on('error',finish)})}
function bearer(req){return req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,})$/)?.[1]}
function sessionCookie(req){const raw=req.headers.cookie;return typeof raw==='string'?raw.split(';').map(x=>x.trim()).find(x=>x.startsWith('dashboard_session='))?.slice('dashboard_session='.length):undefined}
function sessionCookieHeader(token,clear=false){return `dashboard_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${clear?'; Max-Age=0':''}`}
function checkoutCookie(req){const raw=req.headers.cookie;return typeof raw==='string'?raw.split(';').map(value=>value.trim()).find(value=>value.startsWith('checkout_session='))?.slice('checkout_session='.length):undefined}
function checkoutCookieHeader(token,clear=false){return `checkout_session=${token}; Path=/billing/public; HttpOnly; Secure; SameSite=Lax${clear?'; Max-Age=0':'; Max-Age=1800'}`}
function normalizePhone(value){if(typeof value!=='string')throw new Error();let phone=value.trim().replace(/[\s().-]/g,'');if(phone.startsWith('0'))phone=`+62${phone.slice(1)}`;else if(phone.startsWith('62'))phone=`+${phone}`;if(!/^\+628\d{7,11}$/.test(phone))throw new Error();return phone}
function json(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}function unauthorized(res){return json(res,401,{error:'Unauthorized'})}function notFound(res){res.writeHead(404);res.end()}
function positive(v,fallback){v=Number(v);return Number.isFinite(v)&&v>0?v:fallback}
export function clientIp(req,trustProxy=false){
  const socket=normalizeIp(req?.socket?.remoteAddress)||'unknown';
  if(trustProxy!==true||!isTrustedPeer(socket))return socket;
  const raw=req?.headers?.['x-forwarded-for'];
  if(typeof raw!=='string'||raw.length===0||/[\x00-\x1f\x7f]/.test(raw))return socket;
  const parts=raw.split(',');
  if(!parts.length)return socket;
  const parsed=[];
  for(const part of parts){const value=part.trim(),ip=normalizeIp(value);if(!value||!ip)return socket;parsed.push(ip)}
  for(let i=parsed.length-1;i>=0;i--)if(!isTrustedPeer(parsed[i]))return parsed[i];
  return parsed.at(-1)||socket;
}
function normalizeIp(value){if(typeof value!=='string')return null;const mapped=value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);if(mapped&&net.isIP(mapped[1])===4)return mapped[1];return net.isIP(value)?value.toLowerCase():null}
function isTrustedPeer(ip){const family=net.isIP(ip);if(family===4){const n=ip.split('.').map(Number);return n[0]===10||n[0]===127||n[0]===169&&n[1]===254||n[0]===172&&n[1]>=16&&n[1]<=31||n[0]===192&&n[1]===168}if(family===6)return ip==='::1'||ip.startsWith('fc')||ip.startsWith('fd')||/^fe[89ab]/.test(ip);return false}
function mcpFeature(query){if(query?.method!=='tools/call')return null;return {generate_image:'imageGenerate',edit_image:'imageEdit',analyze_image:'vision',chat_text:'chat',generate_audio:'audio'}[query.params?.name]||null}
function dashboardFeature(path,value){if(path==='/v1/images/generations')return'imageGenerate';if(path==='/v1/images/variations')return'imageEdit';if(path==='/v1/audio/speech')return'audio';if(path==='/v1/chat/completions')return value?.referenceImage||value?.image?'vision':'chat';return null}
function featureCount(feature,value){if(feature!=='imageGenerate'&&feature!=='imageEdit')return 1;const data=Array.isArray(value?.data)?value.data.length:0,images=Array.isArray(value?.images)?value.images.length:0,results=Array.isArray(value?.results)?value.results.filter(item=>item?.image||item?.url||item?.dataUrl).length:0;return Math.max(1,data,images,results)}
function security(res){res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('cache-control','no-store')}
function extension(mime){return {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg'}[mime]||'bin'}
if(process.argv[1]===fileURLToPath(import.meta.url)){const app=await createApp(),port=Number(process.env.PORT||3101);app.server.listen(port,process.env.HOST||'127.0.0.1');const stop=async()=>{await app.close();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop)}
