import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { DodoCancellationError } from "@/lib/dodo-test-mode";
import { createCancellationHandler } from "@/app/api/billing/dodo/cancel/route";
import { createCancellationReconciliationHandler } from "@/app/api/billing/dodo/cancel/reconcile/route";
import { beginCustomerPeriodEndCancellation, closeJobStorePool, confirmCancellationRecoveryCase, getEditingEntitlement, leaseDueCancellationRecoveryCases, listUnresolvedCancellationRecoveryCases, migrateEditJobs, recordCancellationRecoveryEvidence } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
integration("uncertain cancellation creates a durable, owner-pinned recovery case that only positive evidence closes", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "recovery-test-secret-at-least-thirty-two", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "synthetic", DODO_TEST_RETURN_URL: "http://localhost:3000/return", DODO_TEST_BUSINESS_ID: "biz-cliponaut", DODO_TEST_BRAND_ID: "brand-cliponaut", DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED: "true", DODO_TEST_CANCELLATION_RECOVERY_ENABLED: "true" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM cancellation_recovery_cases; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const owner = crypto.randomUUID(), token = "recovery-owner";
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'recovery@test.local','google-recovery',now())", [owner]);
    await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), owner, hashCustomerToken(token)]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-recovery','cliponaut-product','cus-recovery',$1,'verified','active',now()-interval '1 day',now()+interval '2 days')", [owner]);
    const request = () => new Request("http://localhost/api/billing/dodo/cancel", { method: "POST", headers: { origin: "http://localhost", cookie: `${CUSTOMER_SESSION_COOKIE}=${token}` } });
    let patches = 0; const cancel = createCancellationHandler({ schedule: async () => { patches++; throw new DodoCancellationError("timeout", { uncertain: true }); } });
    assert.equal((await cancel(request())).status, 503); assert.equal((await cancel(request())).status, 202); assert.equal(patches, 1); assert.ok(await getEditingEntitlement(owner));
    const [recovery] = await listUnresolvedCancellationRecoveryCases(); assert.equal(recovery.subscription_id, "sub-recovery"); assert.equal(recovery.notification_state, "unconfigured");
    assert.equal((await leaseDueCancellationRecoveryCases()).length, 1); assert.equal((await leaseDueCancellationRecoveryCases()).length, 0, "lease prevents concurrent workers");
    await db.query("UPDATE cancellation_recovery_cases SET lease_until=now()-interval '1 second',next_reconciliation_at=now()-interval '1 second' WHERE id=$1", [recovery.id]);
    const leased = (await leaseDueCancellationRecoveryCases())[0]; assert.ok(await recordCancellationRecoveryEvidence(leased.id, leased.leaseToken, { confirmed: false }), "negative evidence remains unresolved");
    await db.query("UPDATE cancellation_recovery_cases SET lease_until=now()-interval '1 second',next_reconciliation_at=now()-interval '1 second' WHERE id=$1", [recovery.id]);
    const positiveLease = (await leaseDueCancellationRecoveryCases())[0];
    const reconciliation = createCancellationReconciliationHandler({ retrieve: async () => { const row = (await db.query("SELECT billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub-recovery'")).rows[0]; return { subscriptionId: "sub-recovery", billingStart: row.billing_period_start, billingEnd: row.billing_period_end, scheduled: true, status: "active", evidenceSource: "subscription_get", businessProvenance: "absent" }; } });
    const reconcileRequest = new Request("http://localhost/api/billing/dodo/cancel/reconcile", { method: "POST", headers: { origin: "http://localhost", cookie: `${CUSTOMER_SESSION_COOKIE}=${token}` } });
    const response = await reconciliation(reconcileRequest); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { scheduled: false, pending: true, reviewRequired: true, recovery: true, providerStatus: "active", businessProvenance: "absent" });
    assert.equal((await listUnresolvedCancellationRecoveryCases()).length, 1, "GET without business provenance cannot close recovery");
    assert.ok(await recordCancellationRecoveryEvidence(positiveLease.id, positiveLease.leaseToken, { confirmed: false, source: "subscription_get" }));
  } finally { await db.query("DELETE FROM cancellation_recovery_cases;").catch(() => {}); for (const key of ["DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED", "DODO_TEST_CANCELLATION_RECOVERY_ENABLED"]) delete process.env[key]; await db.end(); await closeJobStorePool(); }
});

integration("original recovery case rejects foreign customer, changed business, and renewed period before accepting matching evidence", async () => {
  Object.assign(process.env, { DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "synthetic", DODO_TEST_RETURN_URL: "http://localhost/return", DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", DODO_TEST_BUSINESS_ID: "biz-original", DODO_TEST_BRAND_ID: "brand-original" }); await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM cancellation_recovery_cases; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;"); const owner = crypto.randomUUID();
    await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'p1@test.local','google-p1',now())", [owner]);
    async function createCase(name) { await db.query(`INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ($1,'cliponaut-product','cus-original',$2,'verified','active',now()-interval '1 day',now()+interval '1 day')`, [name,owner]); const sub = await beginCustomerPeriodEndCancellation(owner,name,{businessId:"biz-original",brandId:"brand-original"}); const [recovery] = await listUnresolvedCancellationRecoveryCases(); const lease = (await leaseDueCancellationRecoveryCases())[0]; return { sub,recovery,lease }; }
    async function evidence(name, patch = {}) { const row=(await db.query("SELECT billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id=$1",[name])).rows[0]; return { evidenceSource:"signed_webhook",scheduled:true,subscriptionId:name,customerId:"cus-original",productId:"cliponaut-product",brandId:"brand-original",businessId:"biz-original",billingStart:new Date(row.billing_period_start).toISOString(),billingEnd:new Date(row.billing_period_end).toISOString(),...patch }; }
    let x=await createCase("sub-a7"); assert.equal(await confirmCancellationRecoveryCase(x.recovery.id,x.lease.leaseToken,await evidence("sub-a7",{customerId:"cus-foreign"}),{productId:"cliponaut-product",businessId:"biz-original",brandId:"brand-original"}),null,"A7");
    await db.query("DELETE FROM cancellation_recovery_cases; DELETE FROM dodo_subscriptions;"); x=await createCase("sub-a8"); assert.equal(await confirmCancellationRecoveryCase(x.recovery.id,x.lease.leaseToken,await evidence("sub-a8"),{productId:"cliponaut-product",businessId:"biz-changed",brandId:"brand-original"}),null,"A8");
    await db.query("DELETE FROM cancellation_recovery_cases; DELETE FROM dodo_subscriptions;"); x=await createCase("sub-a9"); await db.query("UPDATE dodo_subscriptions SET billing_period_start=now(),billing_period_end=now()+interval '30 days' WHERE dodo_subscription_id='sub-a9'"); const renewed=await evidence("sub-a9"); assert.equal(await confirmCancellationRecoveryCase(x.recovery.id,x.lease.leaseToken,renewed,{productId:"cliponaut-product",businessId:"biz-original",brandId:"brand-original"}),null,"A9");
    await db.query("DELETE FROM cancellation_recovery_cases; DELETE FROM dodo_subscriptions;"); x=await createCase("sub-positive"); assert.ok(await confirmCancellationRecoveryCase(x.recovery.id,x.lease.leaseToken,await evidence("sub-positive"),{productId:"cliponaut-product",businessId:"biz-original",brandId:"brand-original"}),"matching positive evidence");
  } finally { await db.query("DELETE FROM cancellation_recovery_cases;").catch(()=>{}); await db.end(); await closeJobStorePool(); }
});

integration("expired unresolved cases stay owner-visible without entitlement and retain immutable review deadlines", async () => {
  Object.assign(process.env, { CUSTOMER_AUTH_TOKEN_SECRET: "recovery-expiry-secret-with-at-least-thirty-two", DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED: "true", DODO_TEST_CANCELLATION_RECOVERY_ENABLED: "true" });
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM cancellation_recovery_cases; DELETE FROM render_quota_reservations; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const owner = crypto.randomUUID(), other = crypto.randomUUID(), token = "expiry-owner-token", otherToken = "expiry-other-token";
    for (const [id, email] of [[owner, "expiry-owner@test.local"], [other, "expiry-other@test.local"]]) await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,$2,$3,now())", [id, email, `google-${id}`]);
    for (const [id, value] of [[owner, token], [other, otherToken]]) await db.query("INSERT INTO customer_sessions (id,subscriber_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [crypto.randomUUID(), id, hashCustomerToken(value)]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-expired','cliponaut-product','cus-expired',$1,'verified','active',now()-interval '31 days',now()-interval '1 day')", [owner]);
    const expiredCase = crypto.randomUUID();
    await db.query("INSERT INTO cancellation_recovery_cases (id,subscriber_id,subscription_id,dodo_customer_id,product_id,business_id,brand_id,billing_period_start,billing_period_end,review_deadline_at) SELECT $1,$2,dodo_subscription_id,dodo_customer_id,product_id,'biz','brand',billing_period_start,billing_period_end,now()-interval '1 minute' FROM dodo_subscriptions WHERE dodo_subscription_id='sub-expired'", [expiredCase, owner]);
    assert.equal(await getEditingEntitlement(owner), null, "visibility cannot renew paid editing");
    const { GET } = await import("@/app/api/auth/session/route"); const request = (value) => new Request("http://localhost/api/auth/session", { headers: { cookie: `${CUSTOMER_SESSION_COOKIE}=${value}` } });
    const first = await (await GET(request(token))).json(); const second = await (await GET(request(token))).json(); const foreign = await (await GET(request(otherToken))).json();
    assert.equal(first.cancellation.recovery.id, expiredCase); assert.equal(second.cancellation.recovery.id, expiredCase, "refresh preserves review visibility"); assert.equal(foreign.cancellation.recovery, null, "case remains owner-scoped"); assert.ok(new Date(first.cancellation.recovery.reviewDeadline) < new Date(), "overdue case receives no future deadline");
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-early','cliponaut-product','cus-early',$1,'verified','active',now()-interval '1 day',now()+interval '48 hours'), ('sub-near','cliponaut-product','cus-near',$1,'verified','active',now()-interval '1 day',now()+interval '5 minutes')", [owner]);
    await beginCustomerPeriodEndCancellation(owner, "sub-early", { businessId: "biz", brandId: "brand" }); await beginCustomerPeriodEndCancellation(owner, "sub-near", { businessId: "biz", brandId: "brand" });
    const { rows } = await db.query("SELECT subscription_id,billing_period_end,review_deadline_at FROM cancellation_recovery_cases WHERE subscription_id IN ('sub-early','sub-near') ORDER BY subscription_id");
    const [early, near] = rows; const earlyLead = new Date(early.billing_period_end).getTime() - new Date(early.review_deadline_at).getTime(); const nearLead = new Date(near.billing_period_end).getTime() - new Date(near.review_deadline_at).getTime(); assert.ok(Math.abs(earlyLead - 24 * 60 * 60 * 1000) < 5_000, "early cases receive the bounded one-day review window"); assert.ok(nearLead >= 0 && nearLead < 5_000, "near-renewal deadline cannot extend past original end");
    const originalDeadline = early.review_deadline_at; await db.query("UPDATE dodo_subscriptions SET billing_period_start=now(),billing_period_end=now()+interval '30 days' WHERE dodo_subscription_id='sub-early'");
    assert.equal((await db.query("SELECT review_deadline_at FROM cancellation_recovery_cases WHERE subscription_id='sub-early'")).rows[0].review_deadline_at.getTime(), originalDeadline.getTime(), "later period cannot replace original deadline");
  } finally { for (const key of ["DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED", "DODO_TEST_CANCELLATION_RECOVERY_ENABLED"]) delete process.env[key]; await db.end(); await closeJobStorePool(); }
});

integration("read-only recovery inspection CLI accepts only an immutable matching Cliponaut case", async () => {
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM cancellation_recovery_cases; DELETE FROM render_quota_reservations; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    const owner = crypto.randomUUID(); await db.query("INSERT INTO subscriber_identities (id,email,google_subject,verified_at) VALUES ($1,'operator@test.local','google-operator',now())", [owner]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,dodo_customer_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ('sub-operator','cliponaut-product','cus-operator',$1,'verified','active',now()-interval '1 day',now()+interval '1 day'), ('sub-bynd','bynd-product','cus-bynd',$1,'verified','active',now()-interval '1 day',now()+interval '1 day')", [owner]);
    const created = await beginCustomerPeriodEndCancellation(owner, "sub-operator", { businessId: "biz-operator", brandId: "brand-operator" }); assert.ok(created);
    const row = (await db.query("SELECT * FROM cancellation_recovery_cases WHERE subscription_id='sub-operator'")).rows[0];
    await db.query("INSERT INTO cancellation_recovery_cases (id,subscriber_id,subscription_id,dodo_customer_id,product_id,business_id,brand_id,billing_period_start,billing_period_end,review_deadline_at) SELECT $1,$2,dodo_subscription_id,dodo_customer_id,product_id,'bynd-biz','bynd-brand',billing_period_start,billing_period_end,now()+interval '1 hour' FROM dodo_subscriptions WHERE dodo_subscription_id='sub-bynd'", [crypto.randomUUID(), owner]);
    const base = { ...process.env, NODE_ENV: "test", FOUNDER_CANCELLATION_RECOVERY_OPERATOR: "synthetic-operator", DODO_TEST_MODE_ENABLED: "true", DODO_TEST_API_KEY: "synthetic", DODO_TEST_RETURN_URL: "http://localhost/return", DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED: "true", DODO_TEST_CANCELLATION_RECOVERY_ENABLED: "true", DODO_TEST_CLIPONAUT_PRODUCT_ID: "cliponaut-product", DODO_TEST_BUSINESS_ID: "biz-operator", DODO_TEST_BRAND_ID: "brand-operator" };
    const run = (caseId, extra = {}) => spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/inspect-cancellation-recovery.js", ...(caseId ? [caseId] : [])], { cwd: process.cwd(), env: { ...base, ...extra }, encoding: "utf8", timeout: 10_000 });
    const evidence = { subscriptionId: "sub-operator", customerId: "cus-operator", productId: "cliponaut-product", businessId: "biz-operator", businessProvenance: "signed", evidenceSource: "signed_webhook", brandId: "brand-operator", billingStart: new Date(row.billing_period_start).toISOString(), billingEnd: new Date(row.billing_period_end).toISOString(), scheduled: true };
    let result = run(row.id, { DODO_TEST_RECOVERY_INSPECTION_EVIDENCE_JSON: JSON.stringify(evidence) }); assert.equal(result.status, 0); assert.match(result.stdout, /\"providerError\": null/); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-operator|DODO_TEST_API_KEY/);
    result = run(); assert.equal(result.status, 1, "missing case id");
    result = run(crypto.randomUUID()); assert.equal(result.status, 1, "arbitrary ID");
    const bynd = (await db.query("SELECT id FROM cancellation_recovery_cases WHERE subscription_id='sub-bynd'")).rows[0]; result = run(bynd.id, { DODO_TEST_RECOVERY_INSPECTION_EVIDENCE_JSON: JSON.stringify(evidence) }); assert.equal(result.status, 1, "foreign product rejected before evidence");
    result = run(row.id, { DODO_TEST_BRAND_ID: "", DODO_TEST_RECOVERY_INSPECTION_EVIDENCE_JSON: JSON.stringify(evidence) }); assert.equal(result.status, 1, "missing provenance pin");
    result = run(row.id, { DODO_TEST_RECOVERY_INSPECTION_EVIDENCE_JSON: JSON.stringify({ ...evidence, customerId: "cus-foreign" }) }); assert.equal(result.status, 1); assert.match(result.stdout, /Provider evidence does not match the immutable recovery case/);
  } finally { await db.end(); await closeJobStorePool(); }
});
