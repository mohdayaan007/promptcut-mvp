import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { POST } from "@/app/api/webhooks/dodo/route";
import * as store from "@/lib/jobs/job-store";
import { cliponautPaymentEvent } from "@/lib/dodo-test-mode";

if (!process.env.DATABASE_URL?.includes("cliponaut_paid_period") || process.env.CLIPONAUT_ISOLATED_BILLING_TESTS !== "true") throw new Error("Disposable paid-period DB required");
const secret = Buffer.alloc(32, 7), origin = "https://staging.example.test";
const config = { productId: "product", brandId: "brand", businessId: "business", mode: "test" };
async function fixture(run, { end = Date.now()+3600000 } = {}) {
  const saved = { ...process.env }, fetch = globalThis.fetch;
  Object.assign(process.env, { DODO_ENVIRONMENT: "test", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "dodo_test_mock", DODO_TEST_WEBHOOK_SECRET: `whsec_${secret.toString("base64")}`, DODO_TEST_CLIPONAUT_PRODUCT_ID: "product", DODO_TEST_BRAND_ID: "brand", DODO_TEST_BUSINESS_ID: "business", DODO_TEST_RETURN_URL: `${origin}/account`, CUSTOMER_CHECKOUT_ORIGIN: origin, CUSTOMER_AUTH_TOKEN_SECRET: "isolated-paid-period-secret-with-at-least-thirty-two", PAID_EDITING_ENFORCEMENT_ENABLED: "true", PAID_RENDER_ALLOWANCE: "15", DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED: "true" });
  globalThis.fetch = async () => { throw new Error("No provider/network calls permitted"); };
  await store.migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("TRUNCATE subscriber_identities CASCADE; DELETE FROM dodo_webhook_events;");
    const owner = crypto.randomUUID(), other = crypto.randomUUID(), now = Date.now(), start = new Date(now-86400000).toISOString(), finish = new Date(end).toISOString(); let sequence = 0;
    for (const id of [owner,other]) await db.query("INSERT INTO subscriber_identities(id,email,google_subject,verified_at) VALUES($1,$2,$3,now())", [id,`${id}@example.test`,`google-${id}`]);
    const { reference } = await store.reserveCustomerCheckout(owner); await store.recordCustomerCheckoutSession(owner,reference,"checkout");
    const envelope = (type,data,extra={}) => ({ type,business_id:"business",timestamp:new Date(now+sequence++).toISOString(),data,...extra });
    const subscription = (type="subscription.active",a=start,b=finish,fields={},extra={}) => envelope(type,{ subscription_id:"subscription",product_id:"product",brand_id:"brand",customer:{customer_id:"customer"},status:"active",created_at:start,previous_billing_date:a,next_billing_date:b,cancel_at_next_billing_date:false,...fields },extra);
    const payment = (id="initial",checkout="checkout",fields={},extra={}) => envelope("payment.succeeded",{payment_id:id,checkout_session_id:checkout,subscription_id:"subscription",brand_id:"brand",customer:{customer_id:"customer"},product_cart:null,status:"succeeded",...fields},extra);
    const deliver = async (event,id=`msg-${sequence++}`,status=200,badSignature=false) => {
      const body=JSON.stringify(event),timestamp=String(Math.floor(Date.now()/1000));
      const signature=crypto.createHmac("sha256",secret).update(`${id}.${timestamp}.${body}`).digest("base64");
      const response=await POST(new Request(`${origin}/api/webhooks/dodo`,{method:"POST",headers:{"webhook-id":id,"webhook-timestamp":timestamp,"webhook-signature":`v1,${badSignature?"invalid":signature}`},body}));
      assert.equal(response.status,status,JSON.stringify(await response.json())); return id;
    };
    const bootstrap = async (paymentFirst=false) => { const active=subscription(),paid=payment();if(paymentFirst){await deliver(paid);assert.equal(await store.getEditingEntitlement(owner),null);await deliver(active);}else{await deliver(active);assert.equal(await store.getEditingEntitlement(owner),null);await deliver(paid);} };
    const consume = async () => {const reservationId=await store.reserveRenderCapacity(owner);assert.ok(reservationId);const {job}=await store.createUploadJob([],null,{subscriberId:owner,reservationId});await db.query("UPDATE edit_jobs SET status='rendering',worker_id='fixture' WHERE id=$1",[job.id]);await store.completeJob(job.id,"fixture","private-fixture-output");return job.id;};
    await run({db,owner,other,start,end:finish,now,subscription,payment,deliver,bootstrap,consume});
  } finally {await db.end();await store.closeJobStorePool();globalThis.fetch=fetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
}

test("initial signed checkout/payment ownership grants exactly one paid period in either order",async()=>{
  for(const first of [false,true])await fixture(async({db,owner,other,bootstrap})=>{await bootstrap(first);assert.ok(await store.getEditingEntitlement(owner));assert.equal(await store.getEditingEntitlement(other),null);assert.equal((await store.getCustomerRenderUsage(owner)).remainingRenders,15);assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,1);});
});

test("Processing, failed and missing renewal payments cannot reset or extend the paid allowance",async()=>fixture(async({db,owner,start,end,now,bootstrap,consume,subscription,payment,deliver})=>{
  await bootstrap();await consume();const future=new Date(now+40*86400000).toISOString();
  await deliver(subscription("subscription.updated",new Date(now-1000).toISOString(),future));
  await deliver(subscription("subscription.renewed",new Date(now-1000).toISOString(),future,{payment_id:"unpaid"}));
  for(const type of ["payment.processing","payment.failed"])await deliver({...payment("unpaid",null),type,data:{...payment("unpaid",null).data,status:type.split(".")[1]}});
  await deliver(payment("unpaid",null,{status:"processing"}),undefined,400);
  const usage=await store.getCustomerRenderUsage(owner);assert.equal(usage.remainingRenders,14);assert.equal(usage.billingPeriod.start,start);assert.equal(usage.billingPeriod.end,end);
  assert.equal((await store.getCustomerCancellableSubscription(owner)).billing_period_end.toISOString(),end);
  assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,1);
}));

test("an expired last paid period stays denied despite an active Processing-renewal snapshot",async()=>fixture(async({owner,bootstrap,subscription,deliver,now})=>{
  await bootstrap();await deliver(subscription("subscription.updated",new Date(now-1000).toISOString(),new Date(now+86400000).toISOString()));
  assert.equal(await store.getEditingEntitlement(owner),null);assert.equal(await store.reserveRenderCapacity(owner),null);assert.equal(await store.getCustomerCancellableSubscription(owner),null);assert.equal(await store.getCustomerSubscriptionStatus(owner),"expired");
},{end:Date.now()-3600000}));

test("matching signed renewal and successful payment without checkout ID grant a new period in either order",async()=>{
  for(const first of [false,true])await fixture(async({owner,bootstrap,subscription,payment,deliver,end,now})=>{await bootstrap();const renewal=subscription("subscription.renewed",end,new Date(now+30*86400000).toISOString(),{payment_id:"renewal"});const paid=payment("renewal",null);if(first){await deliver(paid);assert.equal(await store.getEditingEntitlement(owner),null);await deliver(renewal);}else{await deliver(renewal);assert.equal(await store.getEditingEntitlement(owner),null);await deliver(paid);}const usage=await store.getCustomerRenderUsage(owner);assert.equal(usage.remainingRenders,15);assert.equal(usage.successfulRenders,0);assert.equal(usage.reservedRenders,0);assert.equal(usage.billingPeriod.start,end);},{end:Date.now()-3600000});
});

test("later subscription.updated cannot discard delayed paid-period evidence; duplicates and reused payments never extend it",async()=>fixture(async({db,owner,bootstrap,subscription,payment,deliver,end,now})=>{
  await bootstrap();const finish=new Date(now+30*86400000).toISOString();await deliver(subscription("subscription.updated",end,new Date(now+80*86400000).toISOString(),{},{timestamp:new Date(now+10000).toISOString()}));
  const renewal=subscription("subscription.renewed",end,finish,{payment_id:"late"});const paid=payment("late",null);await deliver(paid,"msg-payment");await deliver(renewal,"msg-renewal");await deliver(paid,"msg-payment");await deliver(renewal,"msg-renewal");await deliver(renewal,"msg-renewal-copy");
  await deliver(subscription("subscription.renewed",end,new Date(now+90*86400000).toISOString(),{payment_id:"late"}));await deliver(subscription("subscription.renewed",new Date(now-100).toISOString(),new Date(now+90*86400000).toISOString(),{payment_id:"late"}));
  assert.equal((await store.getCustomerRenderUsage(owner)).billingPeriod.end,finish);assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,2);
},{end:Date.now()-3600000}));

test("missing payment-period linkage, forged signatures and conflicting identities fail closed",async()=>fixture(async({db,owner,bootstrap,subscription,payment,deliver,end,now})=>{
  await bootstrap();const finish=new Date(now+30*86400000).toISOString();await deliver(payment("renewal",null));await deliver(subscription("subscription.renewed",end,finish));assert.equal(await store.getEditingEntitlement(owner),null);
  for(const fields of [{product_id:"foreign"},{brand_id:"foreign"}])await deliver(subscription("subscription.renewed",end,finish,{payment_id:"renewal",...fields}),undefined,400);
  await deliver(subscription("subscription.renewed",end,finish,{payment_id:"renewal"},{business_id:"foreign"}),undefined,400);
  await deliver(subscription("subscription.renewed",end,finish,{payment_id:"renewal"}),undefined,400,true);
  await deliver(subscription("subscription.renewed",end,finish,{payment_id:"renewal",customer:{customer_id:"another-customer"}}));
  assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,1);
},{end:Date.now()-3600000}));

test("a no-checkout payment cannot establish initial ownership; correct checkout evidence remains required",async()=>fixture(async({db,owner,subscription,payment,deliver})=>{
  await deliver(subscription());await deliver(payment("initial",null));assert.equal(await store.getEditingEntitlement(owner),null);assert.equal((await db.query("SELECT subscriber_id FROM dodo_subscriptions")).rows[0].subscriber_id,null);
}));

test("concurrent reservations remain capped at 15 and another account cannot reserve or claim them",async()=>fixture(async({db,owner,other,bootstrap})=>{
  await bootstrap();const reservations=await Promise.all(Array.from({length:24},()=>store.reserveRenderCapacity(owner)));assert.equal(reservations.filter(Boolean).length,15);assert.equal(await store.reserveRenderCapacity(other),null);
  assert.equal((await store.getCustomerRenderUsage(owner)).remainingRenders,0);assert.equal(await store.getEditingEntitlement(other),null);
  const reserved=reservations.find(Boolean);const {job}=await store.createUploadJob([],null,{subscriberId:owner,reservationId:reserved});await store.queueJob(job.id,{prompt:"fixture",exportQuality:"standard",sources:[]});
  assert.equal((await store.claimNextJob("test-worker")).id,job.id);assert.equal((await db.query("SELECT count(*)::int n FROM render_quota_reservations WHERE state='reserved'")).rows[0].n,15);
}));

test("paid access and cancellation display remain until the confirmed boundary, then deny",async()=>fixture(async({owner,bootstrap,start,end})=>{
  await bootstrap();assert.ok(await store.beginCustomerPeriodEndCancellation(owner,"subscription"));assert.ok(await store.confirmCustomerPeriodEndCancellation(owner,"subscription",start,end));assert.ok(await store.getEditingEntitlement(owner));assert.equal((await store.getCustomerCancellationManagementState(owner)).periodEnd,end);
  await new Promise(resolve=>setTimeout(resolve,1800));assert.equal(await store.getEditingEntitlement(owner),null);assert.equal(await store.reserveRenderCapacity(owner),null);assert.equal(await store.getCustomerSubscriptionStatus(owner),"expired");
},{end:Date.now()+1500}));

test("additive migration preserves historical rows but never infers paid periods from mutable dates",async()=>fixture(async({db,owner})=>{
  await db.query("INSERT INTO dodo_subscriptions(dodo_subscription_id,subscriber_id,product_id,dodo_customer_id,status,ownership_provenance,billing_period_start,billing_period_end) VALUES('historical',$1,'product','customer','active','verified',now()-interval '1 day',now()+interval '30 days')",[owner]);
  await store.migrateEditJobs();assert.equal((await db.query("SELECT count(*)::int n FROM dodo_subscriptions")).rows[0].n,1);assert.equal(await store.getEditingEntitlement(owner),null);assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,0);
}));

test("recurring parser retains all payment identity pins without weakening initial session proof",()=>{
  const event={type:"payment.succeeded",business_id:"business",timestamp:new Date().toISOString(),data:{payment_id:"payment",subscription_id:"subscription",brand_id:"brand",customer:{customer_id:"customer"},status:"succeeded"}};
  assert.equal(cliponautPaymentEvent(event,config).checkoutSessionId,null);
  assert.throws(()=>cliponautPaymentEvent({...event,data:{...event.data,customer:null}},config));
});

test("past-due snapshots retain only the old paid window and current mode/identity pins remain mandatory",async()=>fixture(async({owner,bootstrap,subscription,deliver,start,end})=>{
  await bootstrap();await deliver(subscription("subscription.past_due",start,end,{status:"past_due"}));assert.ok(await store.getEditingEntitlement(owner));
  process.env.DODO_TEST_BRAND_ID="different";assert.equal(await store.getEditingEntitlement(owner),null);process.env.DODO_TEST_BRAND_ID="brand";
  process.env.DODO_ENVIRONMENT="live";process.env.DODO_LIVE_MODE_ENABLED="true";process.env.DODO_LIVE_CLIPONAUT_PRODUCT_ID="product";process.env.DODO_LIVE_BRAND_ID="brand";process.env.DODO_LIVE_BUSINESS_ID="business";
  assert.equal(await store.getEditingEntitlement(owner),null);
}));

test("conflicting signed period or customer evidence cannot be guessed into a renewal grant",async()=>fixture(async({db,owner,bootstrap,subscription,payment,deliver,end,now})=>{
  await bootstrap();const finish=new Date(now+30*86400000).toISOString();
  await deliver(subscription("subscription.renewed",end,finish,{payment_id:"ambiguous"}));
  await deliver(subscription("subscription.renewed",end,new Date(now+40*86400000).toISOString(),{payment_id:"ambiguous"}));await deliver(payment("ambiguous",null));
  await deliver(payment("wrong-customer",null,{customer:{customer_id:"other"}}));await deliver(payment("wrong-customer",null));await deliver(subscription("subscription.renewed",end,finish,{payment_id:"wrong-customer"}));
  assert.equal(await store.getEditingEntitlement(owner),null);assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,1);
},{end:Date.now()-3600000}));

test("verified duplicate receipts may fill missing migration evidence without inferring old mutable dates",async()=>fixture(async({db,owner,subscription,payment,deliver})=>{
  const active=subscription(),paid=payment();await deliver(active,"old-active");await deliver(paid,"old-payment");assert.ok(await store.getEditingEntitlement(owner));
  await db.query("DELETE FROM dodo_paid_periods; UPDATE dodo_webhook_events SET billing_evidence=NULL;");assert.equal(await store.getEditingEntitlement(owner),null);
  await deliver(active,"old-active");assert.equal(await store.getEditingEntitlement(owner),null);await deliver(paid,"old-payment");assert.ok(await store.getEditingEntitlement(owner));
}));
