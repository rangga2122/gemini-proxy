import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import QRCode from 'qrcode';
import { DEFAULT_RPM, DEFAULT_WORKERS, passwordVerifier } from './admin.js';

export const PLAN_PRICE_IDR = 35_000;
export const PLAN_MONTHS = 1;
const DEFAULT_BASE_URL = 'https://app.pakasir.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_ORDER_TTL_MS = 20 * 60_000;

const clean = value => String(value || '').trim();

export function addCalendarMonths(value, months = PLAN_MONTHS) {
  const source = new Date(value);
  if (!Number.isFinite(source.getTime()) || !Number.isInteger(months) || months < 1) throw new TypeError('invalid extension date');
  const year = source.getUTCFullYear(), month = source.getUTCMonth() + months, day = source.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay), source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()));
}

export class PakasirClient {
  constructor({ baseUrl = process.env.PAKASIR_BASE_URL || DEFAULT_BASE_URL, projectSlug = process.env.PAKASIR_PROJECT_SLUG, apiKey = process.env.PAKASIR_API_KEY, fetchImpl = fetch } = {}) {
    this.baseUrl = clean(baseUrl).replace(/\/+$/, '');
    this.projectSlug = clean(projectSlug);
    this.apiKey = clean(apiKey);
    this.fetch = fetchImpl;
  }
  get configured() { return Boolean(this.baseUrl && this.projectSlug && this.apiKey); }
  requireConfig() { if (!this.configured) throw billingError('Pembayaran Pakasir belum dikonfigurasi.', 503); }
  async create({ orderId, amount }) {
    this.requireConfig();
    const response = await this.fetch(`${this.baseUrl}/api/transactioncreate/qris`, { method:'POST', headers:{'content-type':'application/json',accept:'application/json'}, body:JSON.stringify({project:this.projectSlug,order_id:orderId,amount,api_key:this.apiKey}), signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data = await readJson(response), payment = data?.payment;
    if (!response.ok || !payment?.payment_number) throw billingError(providerMessage(data, 'Gagal membuat pembayaran Pakasir.'), 502);
    if (clean(payment.project)!==this.projectSlug || clean(payment.order_id)!==orderId || Math.round(Number(payment.amount||0))!==amount) throw billingError('Respons transaksi Pakasir tidak cocok dengan order.', 502);
    return { project:this.projectSlug, orderId, amount, fee:nonNegative(payment.fee), totalPayment:Math.max(amount,nonNegative(payment.total_payment)||amount), paymentMethod:clean(payment.payment_method||'qris').toLowerCase(), paymentNumber:clean(payment.payment_number), expiredAt:validDate(payment.expired_at) };
  }
  async detail({ orderId, amount }) {
    this.requireConfig();
    const query = new URLSearchParams({project:this.projectSlug,amount:String(amount),order_id:orderId,api_key:this.apiKey});
    const response = await this.fetch(`${this.baseUrl}/api/transactiondetail?${query}`, { headers:{accept:'application/json'}, signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data = await readJson(response), transaction = data?.transaction;
    if (!response.ok || !transaction?.order_id) throw billingError(providerMessage(data, 'Gagal memeriksa pembayaran Pakasir.'), 502);
    if (clean(transaction.project)!==this.projectSlug || clean(transaction.order_id)!==orderId || Math.round(Number(transaction.amount||0))!==amount) throw billingError('Detail transaksi Pakasir tidak cocok dengan order.', 502);
    return { status:clean(transaction.status).toLowerCase(), completedAt:validDate(transaction.completed_at) };
  }
}

export class BillingService {
  constructor(file, { users, client = new PakasirClient(), mailer = null, onCredentialsSet = null, credentialGenerator = generateCredentials, now = Date.now, price = PLAN_PRICE_IDR, orderTtlMs = DEFAULT_ORDER_TTL_MS, persist } = {}) {
    if (!users) throw new TypeError('users is required');
    this.file=file;this.users=users;this.client=client;this.mailer=mailer;this.onCredentialsSet=onCredentialsSet;this.credentialGenerator=credentialGenerator;this.now=now;this.price=price;this.orderTtlMs=orderTtlMs;this.persistImpl=persist;this.data={version:1,orders:[]};this.tail=Promise.resolve();this.checking=new Map();this.creating=new Map();this.delivering=new Map();this.lastChecks=new Map();
  }
  get configured(){return this.client.configured}
  plan(){return {provider:'pakasir',configured:this.configured,publicCheckoutConfigured:this.configured&&typeof this.mailer?.sendPaidAccess==='function',priceIdr:this.price,durationMonths:PLAN_MONTHS,rpmLimit:DEFAULT_RPM,workerLimit:DEFAULT_WORKERS}}
  async load(){try{const value=JSON.parse(await readFile(this.file,'utf8'));this.data={version:1,orders:Array.isArray(value?.orders)?value.orders:[]}}catch(error){if(error.code!=='ENOENT')throw error}await this.recoverApplying()}
  enqueue(op){const run=this.tail.then(op);this.tail=run.catch(()=>{});return run}
  async persist(){if(this.persistImpl)return this.persistImpl(this.file,this.data);await mkdir(dirname(this.file),{recursive:true,mode:0o700});const temporary=`${this.file}.${process.pid}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(this.data),{mode:0o600});await rename(temporary,this.file)}
  get(code){return this.data.orders.find(order=>order.orderCode===code)||null}
  async create(user){
    if(this.creating.has(user?.id))return this.creating.get(user.id);
    const pending=this.createOrder(user).finally(()=>this.creating.delete(user?.id));this.creating.set(user?.id,pending);return pending;
  }
  async createOrder(user){
    if(!this.configured)throw billingError('Pembayaran Pakasir belum dikonfigurasi.',503);
    if(!user?.id)throw billingError('Pengguna tidak valid.',400);
    if(user.expiresAt===null&&user.accountType!=='trial')throw billingError('Akun tanpa batas waktu tidak memerlukan perpanjangan.',409);
    await this.expireOrders();
    const existing=this.data.orders.find(order=>order.userId===user.id&&order.status==='pending'&&Date.parse(order.expiresAt)>this.now());
    if(existing)return this.publicOrder(existing);
    const order=await this.newOrder({userId:user.id,email:user.email,phone:user.phone??null,accountAction:'extend'});
    return this.publicOrder(order);
  }
  async createPublic({email,phone,user=null}){
    if(!this.configured)throw billingError('Pembayaran Pakasir belum dikonfigurasi.',503);if(typeof this.mailer?.sendPaidAccess!=='function')throw billingError('Pengiriman akses email belum dikonfigurasi.',503);if(!email||!phone)throw billingError('Data order tidak valid.',400);if(user?.expiresAt===null&&user.accountType!=='trial')throw billingError('Akun tanpa batas waktu tidak memerlukan perpanjangan.',409);if(!user&&this.users.findByEmail(email))throw billingError('Email baru saja digunakan. Silakan ulangi order.',409);
    const key=`public:${user?.id||email}`;if(this.creating.has(key))return this.creating.get(key);const pending=this.createPublicOrder({email,phone,user}).finally(()=>this.creating.delete(key));this.creating.set(key,pending);return pending;
  }
  async createPublicOrder({email,phone,user}){
    await this.expireOrders();const existing=this.data.orders.find(order=>order.status==='pending'&&(user?order.userId===user.id:!order.userId&&order.email===email)&&Date.parse(order.expiresAt)>this.now()),checkoutToken=randomBytes(32).toString('base64url'),checkoutTokenHash=hashCheckout(checkoutToken);
    if(existing){await this.enqueue(async()=>{existing.checkoutTokenHash=checkoutTokenHash;existing.phone=phone;existing.publicCheckout=true;existing.credentialDeliveryStatus='pending';existing.onboarding=null;existing.replacementVerifier=null;await this.persist()});return {order:await this.publicOrder(existing),checkoutToken}}
    const order=await this.newOrder({userId:user?.id??null,email,phone,accountAction:user?'extend':'new',checkoutTokenHash,publicCheckout:true,credentialDeliveryStatus:'pending',credentialDeliveryAttempts:0,lastCredentialDeliveryAttemptAt:null,credentialsDeliveredAt:null,onboarding:null,replacementVerifier:null});return {order:await this.publicOrder(order),checkoutToken};
  }
  async newOrder(fields){const orderCode=makeOrderCode(this.now()),payment=await this.client.create({orderId:orderCode,amount:this.price}),stamp=new Date(this.now()).toISOString(),expiresAt=payment.expiredAt||new Date(this.now()+this.orderTtlMs).toISOString(),order={id:randomUUID(),orderCode,...fields,priceIdr:this.price,status:'pending',provider:'pakasir',gatewayProject:payment.project,gatewayOrderId:payment.orderId,gatewayAmount:payment.amount,gatewayFee:payment.fee,totalPayment:payment.totalPayment,paymentMethod:payment.paymentMethod,paymentNumber:payment.paymentNumber,gatewayStatus:'pending',createdAt:stamp,expiresAt,completedAt:null,previousExpiry:null,targetExpiry:null,appliedAt:null};await this.enqueue(async()=>{this.data.orders.push(order);try{await this.persist()}catch(error){this.data.orders=this.data.orders.filter(value=>value!==order);throw error}});return order}
  async status(code,userId,{force=false}={}){
    let order=this.get(clean(code));if(!order)throw billingError('Order tidak ditemukan.',404);if(order.userId!==userId)throw billingError('Order tidak cocok dengan akun.',403);
    order=await this.refresh(order,{force});return this.publicOrder(order);
  }
  async statusPublic(code,checkoutToken,{force=false}={}){
    let order=this.get(clean(code));if(!order||!validCheckout(order.checkoutTokenHash,checkoutToken))throw billingError('Order tidak ditemukan atau sesi checkout telah berakhir.',401);order=await this.refresh(order,{force});return {order:await this.publicOrder(order),userId:order.status==='paid'?order.userId:null};
  }
  async latestPublic(checkoutToken,{force=false}={}){let order=[...this.data.orders].reverse().find(value=>validCheckout(value.checkoutTokenHash,checkoutToken));if(!order)throw billingError('Sesi checkout tidak ditemukan.',401);order=await this.refresh(order,{force});return {order:await this.publicOrder(order),userId:order.status==='paid'?order.userId:null}}
  async refresh(order,{force=false}={}){
    if(order.status==='pending')order=await this.verify(order.orderCode,{force});
    if(order.status==='pending'&&Date.parse(order.expiresAt)<=this.now()){await this.markExpired(order.orderCode);order=this.get(order.orderCode)}
    if(order.status==='applying')order=await this.apply(order.orderCode,order.completedAt||new Date(this.now()).toISOString());
    if(order.status==='paid'&&order.publicCheckout===true&&order.credentialDeliveryStatus!=='sent')await this.deliverCredentials(order);
    return order;
  }
  async latest(userId){const order=[...this.data.orders].reverse().find(value=>value.userId===userId);if(!order)return null;return order.status==='pending'?this.status(order.orderCode,userId):this.publicOrder(order)}
  async verify(code,{force=false}={}){
    if(this.checking.has(code))return this.checking.get(code);
    const now=this.now();if(!force&&now-Number(this.lastChecks.get(code)||0)<3000)return this.get(code);this.lastChecks.set(code,now);
    const pending=(async()=>{let order=this.get(code);if(!order||order.status!=='pending')return order;const detail=await this.client.detail({orderId:order.gatewayOrderId,amount:order.gatewayAmount});if(detail.status==='completed')return this.apply(code,detail.completedAt||new Date(this.now()).toISOString());await this.enqueue(async()=>{order.gatewayStatus=detail.status||order.gatewayStatus;await this.persist()});return order})().finally(()=>this.checking.delete(code));this.checking.set(code,pending);return pending;
  }
  async apply(code,completedAt){return this.enqueue(async()=>{
    const order=this.get(code);if(!order)throw billingError('Order tidak ditemukan.',404);if(order.status==='paid')return order;if(!['pending','applying'].includes(order.status))return order;
    const modernPublic=order.publicCheckout===true;let user=order.userId?this.users.get(order.userId):this.users.findByEmail(order.email);if(!user&&!modernPublic&&!order.onboarding){order.status='review';order.completedAt=completedAt;order.gatewayStatus='completed';order.replacementVerifier=null;await this.persist();return order}if(!order.userId&&user&&!modernPublic&&user.sourceOrderCode!==order.orderCode){order.status='review';order.completedAt=completedAt;order.gatewayStatus='completed';order.onboarding=null;order.replacementVerifier=null;await this.persist();return order}if(!order.userId&&user&&modernPublic&&user.expiresAt===null&&user.accountType!=='trial'){order.status='review';order.completedAt=completedAt;order.gatewayStatus='completed';await this.persist();return order}
    if(order.status==='pending'){const current=validDate(user?.expiresAt),base=current&&Date.parse(current)>this.now()?new Date(current):new Date(this.now());order.previousExpiry=current;order.targetExpiry=addCalendarMonths(base).toISOString();order.completedAt=completedAt;order.gatewayStatus='completed';order.status='applying';await this.persist()}
    if(!user){user=await this.users.createPaid({email:order.email,phone:order.phone,passwordVerifier:order.onboarding??passwordVerifier(randomBytes(32).toString('base64url')),expiresAt:order.targetExpiry,sourceOrderCode:order.orderCode,now:this.now()});order.userId=user.id;order.onboarding=null;await this.persist()}else{await this.users.applyPaidOrder(user.id,{expiresAt:order.targetExpiry,phone:order.phone,passwordVerifier:modernPublic?null:(order.replacementVerifier??null),orderCode:order.orderCode});order.userId=user.id;order.accountAction='extend';order.replacementVerifier=null;await this.persist()}
    order.status='paid';order.appliedAt=new Date(this.now()).toISOString();try{await this.persist()}catch(error){order.status='applying';order.appliedAt=null;throw error}return order;
  })}
  async deliverCredentials(order){if(order?.publicCheckout!==true||order.status!=='paid'||order.credentialDeliveryStatus==='sent')return order;if(this.delivering.has(order.orderCode))return this.delivering.get(order.orderCode);const task=this.performCredentialDelivery(order).finally(()=>this.delivering.delete(order.orderCode));this.delivering.set(order.orderCode,task);return task}
  async performCredentialDelivery(order){const last=Date.parse(order.lastCredentialDeliveryAttemptAt||'');if(Number.isFinite(last)&&this.now()-last<60000)return order;const user=this.users.get(order.userId);if(!user||typeof this.mailer?.sendPaidAccess!=='function')return order;await this.enqueue(async()=>{order.credentialDeliveryStatus='pending';order.credentialDeliveryAttempts=Number(order.credentialDeliveryAttempts||0)+1;order.lastCredentialDeliveryAttemptAt=new Date(this.now()).toISOString();await this.persist()});const credentials=this.credentialGenerator();try{await this.mailer.sendPaidAccess({to:user.email,password:credentials.password,orderCode:order.orderCode,newExpiresAt:order.targetExpiry});await this.users.setPassword(user.id,credentials.password);try{await this.onCredentialsSet?.(user.id)}catch{}await this.enqueue(async()=>{order.credentialDeliveryStatus='sent';order.credentialsDeliveredAt=new Date(this.now()).toISOString();await this.persist()})}catch{return order}return order}
  async recoverApplying(){for(const order of this.data.orders.filter(value=>value.status==='applying'))await this.apply(order.orderCode,order.completedAt||new Date(this.now()).toISOString())}
  async checkPending(){for(const order of this.data.orders.filter(value=>value.status==='pending').slice(0,10))try{await this.verify(order.orderCode,{force:true})}catch{}for(const order of this.data.orders.filter(value=>value.status==='paid'&&value.publicCheckout===true&&value.credentialDeliveryStatus!=='sent').slice(0,10))try{await this.deliverCredentials(order)}catch{}await this.expireOrders()}
  async expireOrders(){return this.enqueue(async()=>{let changed=false;for(const order of this.data.orders)if(order.status==='pending'&&Date.parse(order.expiresAt)<=this.now()){order.status='expired';order.onboarding=null;order.replacementVerifier=null;changed=true}if(changed)await this.persist()})}
  async markExpired(code){return this.enqueue(async()=>{const order=this.get(code);if(order?.status==='pending'){order.status='expired';order.onboarding=null;order.replacementVerifier=null;await this.persist()}return order})}
  async publicOrder(order){const svg=order.status==='pending'?await QRCode.toString(order.paymentNumber,{type:'svg',errorCorrectionLevel:'M',margin:1,width:320,color:{dark:'#000000',light:'#ffffff'}}):null;return {orderCode:order.orderCode,status:order.status==='applying'?'pending':order.status,accountAction:order.accountAction||'extend',email:order.publicCheckout===true?order.email:undefined,credentialDeliveryStatus:order.publicCheckout===true?(order.credentialDeliveryStatus||'pending'):undefined,priceIdr:order.priceIdr,totalPayment:order.totalPayment,gatewayFee:order.gatewayFee,paymentMethod:order.paymentMethod,expiresAt:order.expiresAt,completedAt:order.completedAt,newExpiresAt:order.status==='paid'?order.targetExpiry:null,qrisDataUrl:svg?`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`:null}}
  async close(){await this.tail}
}

async function readJson(response){const text=await response.text();if(!text)return null;try{return JSON.parse(text)}catch{return null}}
function providerMessage(data,fallback){const value=data&&typeof data==='object'?clean(data.message||data.error):'';return value||fallback}
function nonNegative(value){value=Math.round(Number(value||0));return Number.isFinite(value)&&value>=0?value:0}
function validDate(value){if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null}
function billingError(message,status=400){return Object.assign(new Error(message),{status})}
function hashCheckout(value){return createHash('sha256').update(value).digest('hex')}
function validCheckout(expected,value){if(typeof expected!=='string'||typeof value!=='string')return false;const a=Buffer.from(expected,'hex'),b=Buffer.from(hashCheckout(value),'hex');return a.length===b.length&&timingSafeEqual(a,b)}
function generateCredentials(){return {password:randomBytes(24).toString('base64url')}}
function makeOrderCode(now){const date=new Date(now),ymd=`${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,'0')}${String(date.getUTCDate()).padStart(2,'0')}`;return `GEN-${ymd}-${randomBytes(4).toString('hex').toUpperCase()}`}
