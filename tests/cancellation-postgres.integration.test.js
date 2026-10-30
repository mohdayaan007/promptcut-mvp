import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { closeJobStorePool, getEditingEntitlement, migrateEditJobs, reserveRenderCapacity } from "@/lib/jobs/job-store";
import { createCancellationHandler } from "@/app/api/billing/dodo/cancel/route";

const integration = process.env.DATABASE_URL ? test : test.skip;
const product = "cliponaut-product";
integration("period-end cancellation route is owner-only, flag-gated, and retains current-period entitlement", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "cancellation-integration-secret-with-at-least-thirty-two", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "synthetic", DODO_TEST_RETURN_URL: "http://localhost:3000/return", DODO_TEST_BUSINESS_ID: "biz-cliponaut", DODO_TEST_BRAND_ID: "brand-cliponaut", DODO_TEST_CLIPONAUT_PRODUCT_ID: product, DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED: "true" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const owner = crypto.randomUUID(), other = crypto.randomUUID(), token = "owner-cancellation-token";
    for (const [id, email] of [[owner,"owner@test.local"],[other,"other@test.local"]]) await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [id,email,`google-${id}`]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(),owner,hashCustomerToken(token)]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-owner',$1,$2,'verified','active',now()-interval '1 day',now()+interval '29 days')", [product,owner]);
    const scheduleCalls=[]; const handler=createCancellationHandler({ schedule: async ({subscriptionId}) => { scheduleCalls.push(subscriptionId); const row=(await db.query("SELECT billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id=$1",[subscriptionId])).rows[0]; return { subscriptionId,billingStart:new Date(row.billing_period_start).toISOString(),billingEnd:new Date(row.billing_period_end).toISOString() }; } });
    const req=(value=token) => new Request("http://localhost/api/billing/dodo/cancel",{method:"POST",headers:{origin:"http://localhost",cookie:`${CUSTOMER_SESSION_COOKIE}=${value}`}});
    const response=await handler(req()); assert.equal(response.status,200); assert.equal((await response.json()).scheduled,true); assert.deepEqual(scheduleCalls,["sub-owner"]);
    assert.ok(await getEditingEntitlement(owner)); assert.ok(await reserveRenderCapacity(owner));
    const duplicate=await handler(req()); assert.equal(duplicate.status,200); assert.equal(scheduleCalls.length,1);
    const stranger=await handler(new Request("http://localhost/api/billing/dodo/cancel",{method:"POST",headers:{origin:"http://localhost"}})); assert.equal(stranger.status,401);
    await db.query("UPDATE dodo_subscriptions SET billing_period_end=now()-interval '1 second' WHERE dodo_subscription_id='sub-owner'"); assert.equal(await getEditingEntitlement(owner),null); assert.equal(await reserveRenderCapacity(owner),null);
  } finally { delete process.env.DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED; await db.end(); await closeJobStorePool(); }
});

integration("missing cancellation configuration never creates a pending gate and safely retries", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "cancellation-config-secret-with-at-least-thirty-two", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "synthetic", DODO_TEST_RETURN_URL: "http://localhost:3000/return", DODO_TEST_BUSINESS_ID: "biz-cliponaut", DODO_TEST_BRAND_ID: "brand-cliponaut", DODO_TEST_CLIPONAUT_PRODUCT_ID: product, DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED: "true" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const owner=crypto.randomUUID(), token="config-owner-token"; await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'config@test.local','google-config',now())",[owner]); await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",[crypto.randomUUID(),owner,hashCustomerToken(token)]); await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-config',$1,$2,'verified','active',now()-interval '1 day',now()+interval '29 days')",[product,owner]);
    let mutations=0; const handler=createCancellationHandler({schedule:async ({subscriptionId})=>{mutations+=1;const row=(await db.query("SELECT billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id=$1",[subscriptionId])).rows[0];return {subscriptionId,billingStart:new Date(row.billing_period_start).toISOString(),billingEnd:new Date(row.billing_period_end).toISOString()};}}); const request=()=>new Request("http://localhost/api/billing/dodo/cancel",{method:"POST",headers:{origin:"http://localhost",cookie:`${CUSTOMER_SESSION_COOKIE}=${token}`}});
    delete process.env.DODO_TEST_BRAND_ID; assert.equal((await handler(request())).status,503); assert.equal(mutations,0); assert.equal((await db.query("SELECT cancellation_request_started_at FROM dodo_subscriptions WHERE dodo_subscription_id='sub-config'")).rows[0].cancellation_request_started_at,null);
    process.env.DODO_TEST_BRAND_ID="brand-cliponaut"; assert.equal((await handler(request())).status,200); assert.equal(mutations,1); assert.equal((await db.query("SELECT cancellation_scheduled FROM dodo_subscriptions WHERE dodo_subscription_id='sub-config'")).rows[0].cancellation_scheduled,true);
  } finally { for(const key of ["DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED","DODO_TEST_MODE_ENABLED","DODO_TEST_API_KEY","DODO_TEST_RETURN_URL","DODO_TEST_BUSINESS_ID","DODO_TEST_BRAND_ID"]) delete process.env[key]; await db.end(); await closeJobStorePool(); }
});
