import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { POST as checkout } from "@/app/api/billing/dodo/customer-checkout/route";
import { POST as cancel } from "@/app/api/billing/dodo/cancel/route";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { closeJobStorePool, getEditingEntitlement, migrateEditJobs } from "@/lib/jobs/job-store";

if (!process.env.DATABASE_URL?.includes("cliponaut_founder_checkout_tests") || process.env.CLIPONAUT_ISOLATED_BILLING_TESTS !== "true") throw new Error("Disposable founder-checkout database required");
const origin = "https://cliponaut.example.test";
const subject = "synthetic-founder-google-subject";
const pin = crypto.createHash("sha256").update(subject).digest("hex");
const product = "pdt_0Nr1dKa0axNc4wD0dg8c4", brand = "brnd_0NqfnWquQ3BudsIBEK782", business = "bus_0NdkBSex5ZRNxaB4G66cb";

async function fixture(run) {
  const saved = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { DODO_ENVIRONMENT: "live", DODO_LIVE_MODE_ENABLED: "true", DODO_LIVE_API_KEY: "dodo_live_synthetic", DODO_LIVE_WEBHOOK_SECRET: Buffer.alloc(32, 4).toString("base64"), DODO_TEST_WEBHOOK_SECRET: Buffer.alloc(32, 5).toString("base64"), DODO_LIVE_CLIPONAUT_PRODUCT_ID: product, DODO_LIVE_BRAND_ID: brand, DODO_LIVE_BUSINESS_ID: business, DODO_LIVE_RETURN_URL: `${origin}/account`, DODO_LIVE_CUSTOMER_CHECKOUT_ENABLED: "false", DODO_LIVE_SUBSCRIPTION_CANCELLATION_ENABLED: "true", DODO_TEST_CUSTOMER_CHECKOUT_ENABLED: "false", DODO_TEST_CANCELLATION_RECOVERY_ENABLED: "false", DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256: pin, CUSTOMER_CHECKOUT_ORIGIN: origin, CUSTOMER_AUTH_TOKEN_SECRET: "synthetic-auth-secret-longer-than-thirty-two-characters", PAID_EDITING_ENFORCEMENT_ENABLED: "true", PAID_RENDER_ALLOWANCE: "15" });
  await migrateEditJobs();
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("TRUNCATE subscriber_identities CASCADE; DELETE FROM dodo_webhook_events;");
    const founder = crypto.randomUUID(), other = crypto.randomUUID();
    const tokens = { founder: crypto.randomUUID(), other: crypto.randomUUID() };
    for (const [id,email,google,token] of [[founder,"founder@gmail.com",subject,tokens.founder],[other,"other@gmail.com","other-google-subject",tokens.other]]) {
      await db.query("INSERT INTO subscriber_identities(id,email,google_subject,google_email_authority,verified_at) VALUES($1,$2,$3,'gmail',now())", [id,email,google]);
      await db.query("INSERT INTO customer_sessions(id,subscriber_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [crypto.randomUUID(),id,hashCustomerToken(token)]);
    }
    const calls = [];
    globalThis.fetch = async (url,options) => {
      assert.equal(url,"https://live.dodopayments.com/checkouts"); assert.equal(options.method,"POST");
      calls.push({url,body:JSON.parse(options.body)});
      return Response.json({session_id:"cks_synthetic",checkout_url:"https://checkout.dodopayments.com/session/cks_synthetic"});
    };
    const request = (token=tokens.founder, { url="/api/billing/dodo/customer-checkout", requestOrigin=origin, body, headers={} } = {}) => new Request(`http://localhost:8080${url}`, { method:"POST", headers:{ ...(requestOrigin ? {Origin:requestOrigin}:{}), ...(token ? {cookie:`${CUSTOMER_SESSION_COOKIE}=${token}`} : {}), ...headers }, ...(body ? {body:JSON.stringify(body)} : {}) });
    const counts = async () => (await db.query("SELECT (SELECT count(*)::int FROM customer_checkout_correlations) checkouts,(SELECT count(*)::int FROM dodo_webhook_events) receipts,(SELECT count(*)::int FROM dodo_subscriptions) subscriptions,(SELECT count(*)::int FROM dodo_paid_periods) paid_periods")).rows[0];
    const paidPeriod = async (hours=1) => {
      const start=new Date(Date.now()-15*86400000).toISOString(),end=new Date(Date.now()+hours*3600000).toISOString();
      await db.query("INSERT INTO dodo_webhook_events(event_id,event_type,payload_sha256) VALUES('synthetic-activation','subscription.active','synthetic'),('synthetic-payment','payment.succeeded','synthetic')");
      await db.query("INSERT INTO dodo_subscriptions(dodo_subscription_id,product_id,dodo_customer_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES('sub_synthetic',$1,'cus_synthetic',$2,'verified','active',$3,$4)",[product,founder,start,end]);
      await db.query("INSERT INTO dodo_paid_periods(subscription_id,subscriber_id,mode,product_id,customer_id,brand_id,business_id,period_start,period_end,payment_id,payment_event_id,period_event_id) VALUES('sub_synthetic',$1,'live',$2,'cus_synthetic',$3,$4,$5,$6,'pay_synthetic','synthetic-payment','synthetic-activation')",[founder,product,brand,business,start,end]);
      return {start,end};
    };
    await run({db,founder,other,tokens,calls,request,counts,paidPeriod});
  } finally {
    await db.end(); await closeJobStorePool(); globalThis.fetch=originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env,saved);
  }
}

test("founder checkout requires a server-verified Google subject and ignores all caller-selected ownership/product fields", async()=>fixture(async({db,founder,request,calls})=>{
  const response=await checkout(request(undefined,{body:{email:"attacker@example.test",subscriberId:"foreign",google_subject:subject,founder:true,product_id:"foreign",quantity:99}}));
  assert.equal(response.status,200); assert.equal(calls.length,1);
  assert.deepEqual(calls[0].body.product_cart,[{product_id:product,quantity:1}]);
  assert.deepEqual(calls[0].body.customer,{email:"founder@gmail.com"});
  const correlation=(await db.query("SELECT subscriber_id,status,checkout_session_id FROM customer_checkout_correlations")).rows;
  assert.deepEqual(correlation,[{subscriber_id:founder,status:"created",checkout_session_id:"cks_synthetic"}]);
  assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,0);
  assert.equal(process.env.DODO_LIVE_CUSTOMER_CHECKOUT_ENABLED,"false");
}));

test("anonymous, forged-session and other authenticated accounts cause zero billing writes and zero provider calls",async()=>fixture(async({tokens,request,counts,calls})=>{
  const before=await counts();
  assert.equal((await checkout(request(null))).status,401);
  assert.equal((await checkout(request("forged-session"))).status,401);
  assert.equal((await checkout(request(tokens.other,{body:{email:"founder@gmail.com",founder:true,google_subject:subject},headers:{"x-google-subject":subject,"x-founder":"true"}}))).status,403);
  assert.deepEqual(await counts(),before); assert.equal(calls.length,0);
}));

test("email changes do not transfer founder authorization to another Google identity",async()=>fixture(async({db,founder,other,tokens,request,calls})=>{
  await db.query("UPDATE subscriber_identities SET email='new-founder@gmail.com' WHERE id=$1",[founder]);
  await db.query("UPDATE subscriber_identities SET email='founder@gmail.com' WHERE id=$1",[other]);
  assert.equal((await checkout(request(tokens.other))).status,403);
  assert.equal((await checkout(request())).status,200);
  assert.equal(calls[0].body.customer.email,"new-founder@gmail.com");
}));

test("revoked, expired and unverified sessions cannot use the founder exception",async()=>fixture(async({db,founder,request,calls,counts})=>{
  const before=await counts();
  await db.query("UPDATE customer_sessions SET revoked_at=now() WHERE subscriber_id=$1",[founder]);
  assert.equal((await checkout(request())).status,401);
  await db.query("UPDATE customer_sessions SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE subscriber_id=$1",[founder]);
  assert.equal((await checkout(request())).status,401);
  await db.query("UPDATE customer_sessions SET expires_at=now()+interval '1 hour' WHERE subscriber_id=$1",[founder]);
  await db.query("UPDATE subscriber_identities SET verified_at=NULL WHERE id=$1",[founder]);
  assert.equal((await checkout(request())).status,401);
  assert.equal(calls.length,0);assert.deepEqual(await counts(),before);
}));

test("absent, malformed and Test-mode pilot pins never open disabled public checkout",async()=>fixture(async({request,calls,counts})=>{
  const before=await counts();
  for(const value of [undefined,"","not-a-digest","A".repeat(64)]) {
    if(value===undefined) delete process.env.DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256;else process.env.DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256=value;
    assert.equal((await checkout(request())).status,404);
  }
  process.env.DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256=pin;process.env.DODO_ENVIRONMENT="test";
  assert.equal((await checkout(request())).status,404);
  assert.equal(calls.length,0);assert.deepEqual(await counts(),before);
}));

test("a configured pilot fails closed if global public checkout is accidentally enabled",async()=>fixture(async({tokens,request,counts,calls})=>{
  process.env.DODO_LIVE_CUSTOMER_CHECKOUT_ENABLED="true";const before=await counts();
  assert.equal((await checkout(request())).status,404);
  assert.equal((await checkout(request(tokens.other))).status,404);
  assert.equal(calls.length,0);assert.deepEqual(await counts(),before);
}));

test("a wrong identity pin and missing or foreign Origin fail before reservation or provider access",async()=>fixture(async({request,counts,calls})=>{
  const before=await counts();process.env.DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256="0".repeat(64);
  assert.equal((await checkout(request())).status,403);
  process.env.DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256=pin;
  for(const requestOrigin of [null,"https://foreign.example"])assert.equal((await checkout(request(undefined,{requestOrigin,headers:{"x-forwarded-host":"cliponaut.example.test","x-forwarded-proto":"https"}}))).status,403);
  assert.equal(calls.length,0);assert.deepEqual(await counts(),before);
}));

test("missing Live identity configuration fails before making a founder checkout reservation",async()=>fixture(async({request,calls,counts})=>{
  const before=await counts();delete process.env.DODO_LIVE_BRAND_ID;
  assert.equal((await checkout(request())).status,503);
  assert.equal(calls.length,0);assert.deepEqual(await counts(),before);
}));

test("duplicate and concurrent founder requests never create a second provider checkout",async()=>fixture(async({request,calls,counts})=>{
  const responses=await Promise.all([checkout(request()),checkout(request())]);
  assert.ok(responses.every(r=>[200,409].includes(r.status)));assert.ok(responses.some(r=>r.status===200));
  assert.equal((await checkout(request())).status,409);
  assert.equal(calls.length,1);assert.equal((await counts()).checkouts,1);
}));

function publicCheckout() {
  delete process.env.DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256;
  process.env.DODO_LIVE_CUSTOMER_CHECKOUT_ENABLED="true";
}

test("checkout recovery: a fresh public checkout returns the exact provider URL once",async()=>fixture(async({request,calls,db})=>{
  publicCheckout();
  const originalProvider=globalThis.fetch;
  const providerUrl="https://checkout.dodopayments.com/session/cks_synthetic?opaque=synthetic%2Bvalue&locale=en";
  globalThis.fetch=async(...args)=>{await originalProvider(...args);return Response.json({session_id:"cks_synthetic",checkout_url:providerUrl});};
  const created=await checkout(request());assert.equal(created.status,200);
  assert.equal((await created.json()).checkoutUrl,providerUrl);
  const before=(await db.query("SELECT * FROM customer_checkout_correlations")).rows;
  for(let i=0;i<3;i++) {
    const retry=await checkout(request());assert.equal(retry.status,409);
    assert.equal(retry.headers.get("cache-control"),"no-store");
    const body=await retry.json();assert.equal(body.code,"checkout_reconciliation_required");
    assert.equal(body.checkoutUrl,undefined);assert.equal(body.checkoutId,undefined);
  }
  assert.equal(calls.length,1);
  assert.deepEqual((await db.query("SELECT * FROM customer_checkout_correlations")).rows,before);
}));

test("checkout recovery: expired, provider-invalid and ambiguous recorded sessions never yield URLs or replacements",async()=>fixture(async({db,founder,request,calls})=>{
  publicCheckout();
  for(const [status,expired] of [["created",false],["created",true],["pending",false],["payment_verified",false]]) {
    await db.query("DELETE FROM customer_checkout_correlations");
    await db.query("INSERT INTO customer_checkout_correlations(reference_hash,subscriber_id,checkout_session_id,status,created_at,expires_at) VALUES('live:synthetic-review',$1,'cks_unusable',$2,now()-interval '3 days',now()+($3 * interval '1 day'))",[founder,status,expired?-1:4]);
    const before=(await db.query("SELECT * FROM customer_checkout_correlations")).rows;
    const response=await checkout(request());assert.equal(response.status,409);
    assert.equal((await response.json()).code,"checkout_reconciliation_required");
    assert.deepEqual((await db.query("SELECT * FROM customer_checkout_correlations")).rows,before);
  }
  assert.equal(calls.length,0);
}));

test("checkout recovery: multiple pending rows are preserved and block without choosing the newest",async()=>fixture(async({db,founder,request,calls})=>{
  publicCheckout();
  for(const n of [1,2])await db.query("INSERT INTO customer_checkout_correlations(reference_hash,subscriber_id,checkout_session_id,status,expires_at) VALUES($1,$2,$3,'created',now()+interval '1 day')",[`live:ambiguous-${n}`,founder,`cks_ambiguous_${n}`]);
  const before=(await db.query("SELECT * FROM customer_checkout_correlations ORDER BY reference_hash")).rows;
  assert.equal((await checkout(request())).status,409);assert.equal(calls.length,0);
  assert.deepEqual((await db.query("SELECT * FROM customer_checkout_correlations ORDER BY reference_hash")).rows,before);
}));

test("checkout recovery: cross-account inputs cannot resume or clear another subscriber's correlation",async()=>fixture(async({db,founder,other,tokens,request,calls})=>{
  publicCheckout();
  await db.query("INSERT INTO customer_checkout_correlations(reference_hash,subscriber_id,checkout_session_id,status,expires_at) VALUES('live:foreign-review',$1,'cks_foreign','created',now()+interval '1 day')",[other]);
  const before=(await db.query("SELECT * FROM customer_checkout_correlations WHERE subscriber_id=$1",[other])).rows;
  const response=await checkout(request(tokens.founder,{body:{subscriberId:other,checkoutId:'cks_foreign',retry:true}}));
  assert.equal(response.status,200);assert.equal(calls.length,1);
  assert.equal((await response.json()).checkoutId,'cks_synthetic');
  assert.deepEqual((await db.query("SELECT * FROM customer_checkout_correlations WHERE subscriber_id=$1",[other])).rows,before);
  assert.equal((await checkout(request(tokens.other,{body:{subscriberId:founder,checkoutId:'cks_synthetic'}}))).status,409);
  assert.equal(calls.length,1);
  assert.equal((await checkout(request(null))).status,401);
}));

test("checkout recovery: unknown creation outcomes including malformed success never authorize a retry",async()=>fixture(async({db,request})=>{
  publicCheckout();
  for(const mode of ['timeout','processing-error','malformed-success','invalid-url']) {
    await db.query("DELETE FROM customer_checkout_correlations");let attempts=0;
    globalThis.fetch=async()=>{attempts++;if(mode==='timeout')throw Error('synthetic timeout');
      if(mode==='processing-error')return new Response('synthetic failure',{status:500});
      if(mode==='malformed-success')return new Response('not-json',{status:200});
      return Response.json({session_id:'cks_synthetic',checkout_url:'https://foreign.example.test/session/cks_synthetic'});};
    assert.equal((await checkout(request())).status,503);
    const before=(await db.query("SELECT * FROM customer_checkout_correlations")).rows;
    assert.equal(before[0].status,'pending');
    assert.equal((await checkout(request())).status,409);assert.equal((await checkout(request())).status,409);
    assert.equal(attempts,1);
    assert.deepEqual((await db.query("SELECT * FROM customer_checkout_correlations")).rows,before);
  }
}));

test("checkout recovery: a verified active subscription and successful payment stay untouched",async()=>fixture(async({db,founder,request,calls,paidPeriod})=>{
  publicCheckout();await paidPeriod();
  await db.query("INSERT INTO customer_checkout_correlations(reference_hash,subscriber_id,checkout_session_id,status,provider_payment_id,provider_subscription_id,payment_provenance,expires_at) VALUES('live:paid',$1,'cks_paid','bound','pay_synthetic','sub_synthetic','verified',now()+interval '1 day')",[founder]);
  const before=(await db.query("SELECT row_to_json(s) AS subscription,(SELECT json_agg(p) FROM dodo_paid_periods p) AS periods FROM dodo_subscriptions s")).rows;
  assert.equal((await checkout(request())).status,409);assert.equal(calls.length,0);
  assert.deepEqual((await db.query("SELECT row_to_json(s) AS subscription,(SELECT json_agg(p) FROM dodo_paid_periods p) AS periods FROM dodo_subscriptions s")).rows,before);
}));

test("checkout recovery: a pre-reviewed failed unpaid correlation is preserved when the customer starts fresh",async()=>fixture(async({db,founder,request,calls})=>{
  publicCheckout();
  // Represents a separately approved, provider-confirmed terminal/unpaid reconciliation. This route never performs it.
  await db.query("INSERT INTO customer_checkout_correlations(reference_hash,subscriber_id,checkout_session_id,status,expires_at) VALUES('live:reviewed-failure',$1,'cks_reviewed','failed',now()-interval '1 day')",[founder]);
  const before=(await db.query("SELECT * FROM customer_checkout_correlations")).rows[0];
  assert.equal((await checkout(request())).status,200);assert.equal(calls.length,1);
  assert.deepEqual((await db.query("SELECT * FROM customer_checkout_correlations WHERE reference_hash='live:reviewed-failure'")).rows[0],before);
  assert.equal((await db.query("SELECT count(*)::int n FROM customer_checkout_correlations")).rows[0].n,2);
}));

test("uncertain checkout creation remains pending and cannot be blindly retried",async()=>fixture(async({request,counts})=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("synthetic transport timeout");};
  assert.equal((await checkout(request())).status,503);
  assert.equal((await checkout(request())).status,409);
  assert.equal(calls,1);assert.equal((await counts()).checkouts,1);
}));

test("an existing active subscription prevents another founder purchase",async()=>fixture(async({db,founder,request,calls})=>{
  await db.query("INSERT INTO dodo_subscriptions(dodo_subscription_id,product_id,subscriber_id,status) VALUES('existing',$1,$2,'active')",[product,founder]);
  assert.equal((await checkout(request())).status,409);assert.equal(calls.length,0);
}));

test("mocked period-end cancellation accepts 47 hours, 1 hour and 1 minute before renewal without shortening paid access",async()=>{
  for(const hours of [47,1,1/60])await fixture(async({founder,request,paidPeriod,db})=>{
    const {start,end}=await paidPeriod(hours);let calls=0;
    globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,"https://live.dodopayments.com/subscriptions/sub_synthetic");assert.equal(options.method,"PATCH");assert.deepEqual(JSON.parse(options.body),{cancel_at_next_billing_date:true});return Response.json({subscription_id:"sub_synthetic",product_id:product,brand_id:brand,status:"active",cancel_at_next_billing_date:true,previous_billing_date:start,next_billing_date:end});};
    const response=await cancel(request(undefined,{url:"/api/billing/dodo/cancel"}));assert.equal(response.status,200);
    assert.equal((await response.json()).scheduled,true);assert.equal(calls,1);
    const row=(await db.query("SELECT cancellation_scheduled,cancellation_confirmed_at FROM dodo_subscriptions")).rows[0];assert.equal(row.cancellation_scheduled,true);assert.ok(row.cancellation_confirmed_at);
    assert.equal((await getEditingEntitlement(founder)).billing_period_end.toISOString(),end);
  });
});

test("provider rejection or timeout never reports cancellation success or removes already-paid access",async()=>{
  for(const failure of ["rejected","timeout"])await fixture(async({founder,request,paidPeriod,db})=>{
    const {end}=await paidPeriod(1);let calls=0;
    globalThis.fetch=async()=>{calls++;if(failure==="timeout")throw new Error("synthetic timeout");return Response.json({error:"synthetic provider requires advance contact"},{status:422});};
    const response=await cancel(request(undefined,{url:"/api/billing/dodo/cancel"}));assert.equal(response.status,failure==="timeout"?503:502);assert.notEqual((await response.json()).scheduled,true);assert.equal(calls,1);
    const row=(await db.query("SELECT cancellation_scheduled,cancellation_request_started_at FROM dodo_subscriptions")).rows[0];assert.equal(row.cancellation_scheduled,false);assert.equal(Boolean(row.cancellation_request_started_at),failure==="timeout");
    assert.equal((await getEditingEntitlement(founder)).billing_period_end.toISOString(),end);
  });
});

test("another authenticated account cannot cancel the founder subscription",async()=>fixture(async({tokens,request,paidPeriod,db})=>{
  await paidPeriod(1);let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("must not dispatch");};
  assert.equal((await cancel(request(tokens.other,{url:"/api/billing/dodo/cancel"}))).status,404);
  assert.equal(calls,0);const row=(await db.query("SELECT cancellation_scheduled,cancellation_request_started_at FROM dodo_subscriptions")).rows[0];assert.equal(row.cancellation_scheduled,false);assert.equal(row.cancellation_request_started_at,null);
}));
