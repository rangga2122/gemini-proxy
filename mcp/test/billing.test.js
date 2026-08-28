import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BillingService, PakasirClient, addCalendarMonths } from '../lib/billing.js';
import { UserStore, passwordVerifier } from '../lib/admin.js';
import { createApp } from '../server.js';

test('calendar month extension clamps month-end without losing the time',()=>{
  assert.equal(addCalendarMonths('2024-01-31T12:34:56.789Z').toISOString(),'2024-02-29T12:34:56.789Z');
  assert.equal(addCalendarMonths('2025-01-31T12:34:56.789Z').toISOString(),'2025-02-28T12:34:56.789Z');
});

test('Pakasir client sends the exact contract and rejects mismatched details',async()=>{
  const calls=[],client=new PakasirClient({baseUrl:'https://pakasir.test',projectSlug:'gen',apiKey:'secret',fetchImpl:async(url,options={})=>{calls.push({url:String(url),options});if(String(url).includes('transactioncreate'))return new Response(JSON.stringify({payment:{project:'gen',order_id:'ORDER-1',amount:35000,fee:500,total_payment:35500,payment_method:'qris',payment_number:'000201'}}),{status:200});return new Response(JSON.stringify({transaction:{project:'wrong',order_id:'ORDER-1',amount:35000,status:'completed'}}),{status:200})}});
  const made=await client.create({orderId:'ORDER-1',amount:35000});assert.equal(made.totalPayment,35500);assert.deepEqual(JSON.parse(calls[0].options.body),{project:'gen',order_id:'ORDER-1',amount:35000,api_key:'secret'});await assert.rejects(client.detail({orderId:'ORDER-1',amount:35000}),/tidak cocok/);assert.match(calls[1].url,/project=gen/);assert.match(calls[1].url,/amount=35000/);
});

test('paid orders accumulate exactly once and concurrent create reuses one pending order',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gen-billing-'));let now=Date.parse('2024-01-15T00:00:00.000Z'),creates=0,details=0;
  const users=new UserStore(join(dir,'users.json'),{now:()=>now});await users.load();const {user}=await users.upsert({email:'paid@example.test',expiresAt:'2024-01-31T12:34:56.789Z'});
  const client={configured:true,create:async({orderId,amount})=>{creates++;await new Promise(resolve=>setTimeout(resolve,10));return{project:'gen',orderId,amount,fee:0,totalPayment:amount,paymentMethod:'qris',paymentNumber:'000201010212',expiredAt:new Date(now+1200000).toISOString()}},detail:async()=>{details++;return{status:'completed',completedAt:new Date(now).toISOString()}}};
  const billing=new BillingService(join(dir,'billing.json'),{users,client,now:()=>now});await billing.load();
  const [first,same]=await Promise.all([billing.create(user),billing.create(user)]);assert.equal(creates,1);assert.equal(first.orderCode,same.orderCode);assert.match(first.qrisDataUrl,/^data:image\/svg\+xml;base64,/);
  const paid=await billing.status(first.orderCode,user.id,{force:true});assert.equal(paid.status,'paid');assert.equal(paid.newExpiresAt,'2024-02-29T12:34:56.789Z');assert.equal(users.get(user.id).accountType,'paid');assert.equal(users.get(user.id).active,true);assert.equal(users.get(user.id).rpmLimit,60);
  const repeat=await billing.status(first.orderCode,user.id,{force:true});assert.equal(repeat.newExpiresAt,paid.newExpiresAt);assert.equal(details,1);
  const second=await billing.create(users.get(user.id));await billing.status(second.orderCode,user.id,{force:true});assert.equal(users.get(user.id).expiresAt,'2024-03-29T12:34:56.789Z');assert.equal(JSON.parse(await readFile(join(dir,'billing.json'),'utf8')).orders.filter(order=>order.status==='paid').length,2);await billing.close();
});

test('expired account extension starts at payment time and order ownership is enforced',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gen-billing-expired-'));let now=Date.parse('2025-06-10T08:00:00.000Z');const users=new UserStore(join(dir,'users.json'),{now:()=>now});await users.load();const {user}=await users.upsert({email:'expired@example.test',expiresAt:'2025-01-01T00:00:00.000Z'}),other=(await users.upsert({email:'other@example.test',expiresAt:'2025-01-01T00:00:00.000Z'})).user;
  const client={configured:true,create:async({orderId,amount})=>({project:'gen',orderId,amount,fee:0,totalPayment:amount,paymentMethod:'qris',paymentNumber:'000201010212',expiredAt:new Date(now+1200000).toISOString()}),detail:async()=>({status:'completed',completedAt:new Date(now).toISOString()})};const billing=new BillingService(join(dir,'billing.json'),{users,client,now:()=>now});await billing.load();const order=await billing.create(user);await assert.rejects(billing.status(order.orderCode,other.id),error=>error.status===403);const paid=await billing.status(order.orderCode,user.id,{force:true});assert.equal(paid.newExpiresAt,'2025-07-10T08:00:00.000Z');await billing.close();
});

test('billing HTTP routes require the owning user session and reactivate an expired account',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'gen-billing-http-')),now=Date.parse('2025-06-10T08:00:00.000Z'),password='user-password-long';const client={configured:true,create:async({orderId,amount})=>({project:'gen',orderId,amount,fee:0,totalPayment:amount,paymentMethod:'qris',paymentNumber:'000201010212',expiredAt:new Date(now+1200000).toISOString()}),detail:async()=>({status:'completed',completedAt:new Date(now).toISOString()})};const app=await createApp({stateDir,now:()=>now,pakasirClient:client});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`,post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.deepEqual(await (await fetch(base+'/billing/plan')).json(),{provider:'pakasir',configured:true,priceIdr:35000,durationMonths:1,rpmLimit:60});assert.equal((await post('/billing/order')).status,401);
  const user=await app.users.createTrial({email:'user@example.test',passwordVerifier:passwordVerifier(password),now:now-4*24*60*60*1000});let response=await post('/auth/login',{email:user.email,credential:password}),session=await response.json();assert.equal(session.entitlement,'profile-only');const cookie=response.headers.get('set-cookie');response=await post('/billing/order',undefined,{cookie});assert.equal(response.status,201);const order=await response.json();assert.equal((await fetch(base+'/billing/order',{headers:{cookie}})).status,200);response=await fetch(`${base}/billing/order/${order.orderCode}`,{headers:{cookie}});const paid=await response.json();assert.equal(paid.status,'paid');assert.equal(app.users.get(user.id).expiresAt,'2025-07-10T08:00:00.000Z');assert.equal((await (await fetch(base+'/auth/session',{headers:{cookie}})).json()).entitlement,'full');await app.users.update(user.id,{expiresAt:'2025-06-01T00:00:00.000Z'});assert.equal((await (await fetch(base+'/auth/session',{headers:{cookie}})).json()).entitlement,'profile-only');assert.equal((await post('/billing/order',undefined,{cookie})).status,201);
});
