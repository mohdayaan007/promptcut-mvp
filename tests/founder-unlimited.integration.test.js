import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import * as store from "@/lib/jobs/job-store";
import { hashCustomerToken } from "@/lib/customer-auth";
import { founderSubjectDigests, isFounderSubjectDigest } from "@/lib/founder-identity";
import { authorizePaidEdit, authorizePaidJob, authorizePaidSession } from "@/lib/paid-editing";
import { GET as accessGET } from "@/app/api/editor-access/route";
import { GET as usageGET } from "@/app/api/account/usage/route";
import { POST as revisionPOST } from "@/app/api/editing-sessions/[id]/route";
import { POST as uploadPOST } from "@/app/api/uploads/route";
import { GET as jobGET } from "@/app/api/jobs/[id]/route";
import { GET as sessionGET } from "@/app/api/editing-sessions/[id]/route";
import { editingReadiness } from "@/lib/account-presentation";
import { editorAccessState } from "@/lib/editor-access-presentation";
import { grantFounderTestAccess } from "@/lib/founder-test-access";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";

if (!process.env.DATABASE_URL?.includes("cliponaut_founder_unlimited_tests") || process.env.CLIPONAUT_ISOLATED_FOUNDER_TESTS !== "true") throw new Error("Disposable founder test database required");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const subject = "isolated-stable-founder-google-subject", pin = digest(subject);
const source = { index: 0, name: "test.mp4", type: "video/mp4", size: 100 };
const catalog = createSourceCatalog([source], [{duration:8,width:320,height:180,hasAudio:false}]);
const plan = {version:"2",operations:[{type:"sequence",clips:[{sourceId:"source-1",start:1,end:7}]}]};

function request(token, body, extra = {}) {
  return new Request("https://isolated.example.test/api/edit", {method:body ? "POST" : "GET",headers:{...(token ? {cookie:`cliponaut_customer=${token}`} : {}),...extra},...(body ? {body:JSON.stringify(body)} : {})});
}

async function fixture(run, {mode="test", enforced=true} = {}) {
  const saved = {...process.env}, fetch = globalThis.fetch;
  Object.assign(process.env,{DODO_ENVIRONMENT:mode,DODO_TEST_MODE_ENABLED:"true",DODO_LIVE_MODE_ENABLED:"true",DODO_TEST_CLIPONAUT_PRODUCT_ID:"isolated-product",DODO_LIVE_CLIPONAUT_PRODUCT_ID:"isolated-live-product",DODO_TEST_BRAND_ID:"brand",DODO_LIVE_BRAND_ID:"live-brand",DODO_TEST_BUSINESS_ID:"business",DODO_LIVE_BUSINESS_ID:"live-business",CUSTOMER_AUTH_TOKEN_SECRET:"isolated-session-secret-at-least-thirty-two-characters",FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST:pin,PAID_EDITING_ENFORCEMENT_ENABLED:String(enforced),PAID_RENDER_ALLOWANCE:"15"});
  globalThis.fetch = async () => { throw new Error("Provider/network requests prohibited"); };
  const db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
  try {
    assert.equal((await db.query("SELECT current_database() AS name")).rows[0].name,"cliponaut_founder_unlimited_tests");
    await store.migrateEditJobs();
    await db.query("TRUNCATE subscriber_identities,edit_jobs,dodo_webhook_events CASCADE");
    const founder=crypto.randomUUID(),other=crypto.randomUUID(),unverified=crypto.randomUUID();
    for (const [id,email,sub,verified] of [[founder,"founder@example.test",subject,true],[other,"other@example.test","another-google-subject",true],[unverified,"unverified@example.test","unverified-subject",false]]) {
      await db.query("INSERT INTO subscriber_identities(id,email,google_subject,verified_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() END)",[id,email,sub,verified]);
      await db.query("INSERT INTO customer_sessions(id,subscriber_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[crypto.randomUUID(),id,hashCustomerToken(id)]);
    }
    const paid = async id => {
      const product = mode === "live" ? "isolated-live-product" : "isolated-product";
      const start = new Date(Date.now()-3600000),end = new Date(Date.now()+86400000);
      const sub=`sub-${id}`,payment=`pay-${id}`,pe=`payment-${id}`,se=`active-${id}`;
      for (const [eid,type] of [[pe,"payment.succeeded"],[se,"subscription.active"]]) await db.query("INSERT INTO dodo_webhook_events(event_id,event_type,payload_sha256) VALUES($1,$2,$3)",[eid,type,"a".repeat(64)]);
      await db.query("INSERT INTO dodo_subscriptions(dodo_subscription_id,product_id,dodo_customer_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES($1,$2,$3,$4,'verified','active',$5,$6)",[sub,product,`cus-${id}`,id,start,end]);
      await db.query("INSERT INTO dodo_paid_periods(subscription_id,subscriber_id,mode,product_id,customer_id,brand_id,business_id,period_start,period_end,payment_id,payment_event_id,period_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[sub,id,mode,product,`cus-${id}`,mode === "live" ? "live-brand" : "brand",mode === "live" ? "live-business" : "business",start,end,payment,pe,se]);
    };
    const queue = async (id, reservationId=null) => {
      const next=await store.createUploadJob([source],null,{subscriberId:id,reservationId});
      await store.queueJob(next.job.id,{prompt:"Trim from 0:01 to 0:07",exportQuality:"standard",sources:[source],reference:null});
      return next;
    };
    const finish = async expected => {
      const claimed=await store.claimNextJob("isolated-worker");assert.equal(claimed?.id,expected);
      await store.saveJobPlan(expected,"isolated-worker",claimed.editPlan || plan,catalog);
      assert.ok(await store.setJobStatus(expected,"isolated-worker","rendering"));
      assert.ok(await store.completeJob(expected,"isolated-worker","private-test-output"));
      await store.syncVersionStatus(expected,"completed");
      return claimed;
    };
    await run({db,founder,other,unverified,paid,queue,finish});
  } finally {
    await db.end();await store.closeJobStorePool();globalThis.fetch=fetch;
    for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k];Object.assign(process.env,saved);
  }
}

test("allowlist is explicit, strict and independent of founder checkout and bearer-cookie pins",async()=>fixture(async()=>{
  assert.deepEqual(founderSubjectDigests(),[pin]);assert.equal(isFounderSubjectDigest(pin),true);
  for(const value of [undefined,"","*","founder@example.test",pin.toUpperCase(),`${pin},invalid`]) {
    if(value===undefined) delete process.env.FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST;else process.env.FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST=value;
    assert.deepEqual(founderSubjectDigests(),[]);assert.equal(isFounderSubjectDigest(pin),false);
  }
  process.env.DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256=pin;assert.equal(isFounderSubjectDigest(pin),false);
  process.env.FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST=`${digest("other")}, ${pin}`;assert.equal(isFounderSubjectDigest(pin),true);
}));

for(const mode of ["test","live"]) test(`${mode}: founder completes more than 15 jobs without subscription or quota reservations`,async()=>fixture(async({db,founder,queue,finish})=>{
  for(let i=0;i<17;i++) {
    const auth=await authorizePaidEdit(request(founder));assert.equal(auth.subscriberId,founder);assert.equal(auth.founderUnlimited,true);assert.equal(auth.reservationId,null);
    const next=await queue(founder);await finish(next.job.id);
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM edit_jobs WHERE status='completed'")).rows[0].n,17);
  assert.equal((await db.query("SELECT count(*)::int n FROM render_quota_reservations")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM dodo_paid_periods")).rows[0].n,0);
},{mode}));

test("founder renders preserve the existing paid subscription, period and consumed allowance",async()=>fixture(async({db,founder,paid,queue,finish})=>{
  await paid(founder);const reservation=await store.reserveRenderCapacity(founder);const initial=await queue(founder,reservation);await finish(initial.job.id);
  const before={sub:(await db.query("SELECT * FROM dodo_subscriptions")).rows,period:(await db.query("SELECT * FROM dodo_paid_periods")).rows,quota:(await db.query("SELECT * FROM render_quota_reservations")).rows};
  const next=await queue(founder);await finish(next.job.id);
  assert.deepEqual((await db.query("SELECT * FROM dodo_subscriptions")).rows,before.sub);assert.deepEqual((await db.query("SELECT * FROM dodo_paid_periods")).rows,before.period);assert.deepEqual((await db.query("SELECT * FROM render_quota_reservations")).rows,before.quota);
  assert.equal((await store.getCustomerRenderUsage(founder)).remainingRenders,14);
}));

test("Google subject, verification and session lifecycle prevent email/flag/cookie impersonation",async()=>fixture(async({db,founder,other,unverified})=>{
  for(const token of [null,"forged-cookie",other,unverified]) await assert.rejects(()=>authorizePaidEdit(request(token,{email:"founder@example.test",founderUnlimited:true},{"x-founder":"true"})),e=>[401,403].includes(e.status));
  process.env.FOUNDER_CONVERSATIONAL_EDITING_ENABLED="true";process.env.FOUNDER_TEST_ACCESS_SECRET="isolated-legacy-cookie-secret-at-least-thirty-two";
  const cookie=grantFounderTestAccess(process.env.FOUNDER_TEST_ACCESS_SECRET).split(";")[0];await assert.rejects(()=>authorizePaidEdit(request(null,null,{cookie})),e=>e.status===401);
  await db.query("UPDATE subscriber_identities SET email='renamed@example.test' WHERE id=$1",[founder]);await db.query("UPDATE subscriber_identities SET email='founder@example.test' WHERE id=$1",[other]);
  assert.equal((await authorizePaidEdit(request(founder))).founderUnlimited,true);await assert.rejects(()=>authorizePaidEdit(request(other)),e=>e.status===403);
  await db.query("UPDATE customer_sessions SET revoked_at=now() WHERE subscriber_id=$1",[founder]);await assert.rejects(()=>authorizePaidEdit(request(founder)),e=>e.status===401);
}));

test("allowlist absence, mismatch and revoked verification stop both authorization and queued worker claims",async()=>fixture(async({db,founder,queue})=>{
  const next=await queue(founder);
  for(const value of ["",digest("foreign"),`${pin},invalid`]) {process.env.FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST=value;await assert.rejects(()=>authorizePaidEdit(request(founder)),e=>e.status===403);assert.equal(await store.claimNextJob("worker"),null);}
  process.env.FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST=pin;await db.query("UPDATE subscriber_identities SET verified_at=NULL WHERE id=$1",[founder]);assert.equal(await store.claimNextJob("worker"),null);
  assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1",[next.job.id])).rows[0].status,"queued");
}));

test("founder job/session access still requires the exact owner and opaque token",async()=>fixture(async({founder,other,paid,queue,finish})=>{
  await paid(other);const next=await queue(founder);await finish(next.job.id);const session=await store.createEditingSession(next.job.id,"initial",founder);
  assert.equal((await authorizePaidJob(request(founder),next.job.id,next.accessToken)).id,next.job.id);
  assert.equal((await authorizePaidSession(request(founder),session.id,session.accessToken)).founderUnlimited,true);
  await assert.rejects(()=>authorizePaidJob(request(other),next.job.id,next.accessToken),e=>e.status===404);
  await assert.rejects(()=>authorizePaidSession(request(other),session.id,session.accessToken),e=>e.status===404);
  await assert.rejects(()=>authorizePaidSession(request(founder),session.id,"wrong-token"),e=>e.status===404);
}));

test("founder conversational revision route exceeds 15 revisions without leaking quota",async()=>fixture(async({db,founder,queue,finish})=>{
  const next=await queue(founder);const session=await store.createEditingSession(next.job.id,"initial",founder);await finish(next.job.id);
  for(let i=0;i<17;i++) {
    const response=await revisionPOST(request(founder,{prompt:i%2 ? "Bring it back to normal." : "Also add black and white.",expectedVersion:i+1},{"x-cliponaut-session-token":session.accessToken}),{params:Promise.resolve({id:session.id})});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));await finish(body.id);
  }
  assert.equal((await db.query("SELECT latest_version FROM editing_sessions WHERE id=$1",[session.id])).rows[0].latest_version,18);
  assert.equal((await db.query("SELECT count(*)::int n FROM render_quota_reservations")).rows[0].n,0);
}));

test("ordinary customer reservations remain capped at 15 under concurrency and unpaid jobs cannot be claimed",async()=>fixture(async({db,other,paid,queue,finish})=>{
  await assert.rejects(()=>authorizePaidEdit(request(other)),e=>e.status===403);const forged=await queue(other);assert.equal(await store.claimNextJob("worker"),null);
  await paid(other);const reservations=await Promise.all(Array.from({length:20},()=>store.reserveRenderCapacity(other)));assert.equal(reservations.filter(Boolean).length,15);await assert.rejects(()=>authorizePaidEdit(request(other)),e=>e.status===429);
  const used=reservations.filter(Boolean);for (const reservation of used) { const valid=await queue(other,reservation);await finish(valid.job.id); }
  await assert.rejects(()=>authorizePaidEdit(request(other)),e=>e.status===429);
  assert.equal((await store.getCustomerRenderUsage(other)).successfulRenders,15);
  assert.equal((await store.getCustomerRenderUsage(other)).reservedRenders,0);
  assert.equal((await db.query("SELECT status FROM edit_jobs WHERE id=$1",[forged.job.id])).rows[0].status,"queued");
  assert.equal((await store.getCustomerRenderUsage(other)).remainingRenders,0);
}));

test("founder authorization retains upload limits and creates no quota slot on invalid input",async()=>fixture(async({db,founder})=>{
  const response=await uploadPOST(request(founder,{files:[{name:"too-large.mp4",type:"video/mp4",size:6*1024**3}]}));assert.equal(response.status,400);
  assert.equal((await db.query("SELECT count(*)::int n FROM edit_jobs")).rows[0].n,0);assert.equal((await db.query("SELECT count(*)::int n FROM render_quota_reservations")).rows[0].n,0);
}));

test("staging without paid enforcement keeps founder jobs and revisions Google-owned",async()=>fixture(async({founder,queue,finish})=>{
  assert.equal((await authorizePaidEdit(request(founder))).founderUnlimited,true);const next=await queue(founder);await finish(next.job.id);
  const session=await store.createEditingSession(next.job.id,"initial",founder);assert.equal((await authorizePaidSession(request(founder),session.id,session.accessToken)).founderUnlimited,true);
},{enforced:false}));

test("account/editor UI shows unlimited founder access while customers retain the paywall",async()=>fixture(async({founder,other})=>{
  const access=await (await accessGET(request(founder))).json(),usage=await (await usageGET(request(founder))).json();
  assert.equal(access.founderUnlimited,true);assert.equal(access.eligible,true);assert.equal(usage.founderUnlimited,true);assert.equal(editorAccessState({...access,phase:"ready"}).title,"Unlimited founder access");assert.equal(editingReadiness("not_subscribed",usage).title,"Unlimited founder access");
  const ordinary=await (await accessGET(request(other))).json();assert.equal(ordinary.founderUnlimited,false);assert.equal(ordinary.eligible,false);assert.equal(editorAccessState({...ordinary,phase:"ready"}).blocking,true);
  const anonymous=await (await accessGET(request(null))).json();assert.equal(anonymous.signedIn,false);assert.notEqual(anonymous.founderUnlimited,true);
}));

test("unenforced staging never exposes founder-owned media/history through leaked legacy tokens",async()=>fixture(async({founder,other,queue,finish})=>{
  const next=await queue(founder);await finish(next.job.id);const session=await store.createEditingSession(next.job.id,"initial",founder);
  process.env.FOUNDER_CONVERSATIONAL_EDITING_ENABLED="true";process.env.FOUNDER_TEST_ACCESS_SECRET="isolated-legacy-cookie-secret-at-least-thirty-two";
  const legacy=grantFounderTestAccess(process.env.FOUNDER_TEST_ACCESS_SECRET).split(";")[0];
  for(const token of [null,other]) {
    const cookie=[token ? `cliponaut_customer=${token}` : null,legacy].filter(Boolean).join("; ");
    assert.equal((await jobGET(request(null,null,{cookie,"x-cliponaut-job-token":next.accessToken}),{params:Promise.resolve({id:next.job.id})})).status,404);
    assert.equal((await sessionGET(request(null,null,{cookie,"x-cliponaut-session-token":session.accessToken}),{params:Promise.resolve({id:session.id})})).status,404);
  }
},{enforced:false}));

test("parallel worker claims remain single-flight and expired sessions cannot use the exemption",async()=>fixture(async({db,founder,queue})=>{
  const a=await queue(founder),b=await queue(founder);
  const claims=await Promise.all([store.claimNextJob("worker-a"),store.claimNextJob("worker-b")]);
  assert.deepEqual(new Set(claims.map(j=>j.id)),new Set([a.job.id,b.job.id]));assert.equal(await store.claimNextJob("worker-c"),null);
  await db.query("UPDATE customer_sessions SET expires_at=now()-interval '1 second' WHERE subscriber_id=$1",[founder]);
  await assert.rejects(()=>authorizePaidEdit(request(founder)),e=>e.status===401);
}));
