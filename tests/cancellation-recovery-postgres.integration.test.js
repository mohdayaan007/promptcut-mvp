import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { CUSTOMER_SESSION_COOKIE, hashCustomerToken } from "@/lib/customer-auth";
import { DodoCancellationError } from "@/lib/dodo-test-mode";
import { createCancellationHandler } from "@/app/api/billing/dodo/cancel/route";
import { createCancellationReconciliationHandler } from "@/app/api/billing/dodo/cancel/reconcile/route";
import { closeJobStorePool, getEditingEntitlement, leaseDueCancellationRecoveryCases, listUnresolvedCancellationRecoveryCases, migrateEditJobs, recordCancellationRecoveryEvidence } from "@/lib/jobs/job-store";

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
    const reconciliation = createCancellationReconciliationHandler({ retrieve: async () => { const row = (await db.query("SELECT billing_period_start,billing_period_end FROM dodo_subscriptions WHERE dodo_subscription_id='sub-recovery'")).rows[0]; return { subscriptionId: "sub-recovery", billingStart: row.billing_period_start, billingEnd: row.billing_period_end, scheduled: true }; } });
    const reconcileRequest = new Request("http://localhost/api/billing/dodo/cancel/reconcile", { method: "POST", headers: { origin: "http://localhost", cookie: `${CUSTOMER_SESSION_COOKIE}=${token}` } });
    assert.equal((await reconciliation(reconcileRequest)).status, 200); assert.ok(await recordCancellationRecoveryEvidence(positiveLease.id, positiveLease.leaseToken, { confirmed: true, subscriptionId: "sub-recovery" }));
    assert.equal((await listUnresolvedCancellationRecoveryCases()).length, 0);
  } finally { await db.query("DELETE FROM cancellation_recovery_cases;").catch(() => {}); for (const key of ["DODO_TEST_SUBSCRIPTION_CANCELLATION_ENABLED", "DODO_TEST_CANCELLATION_RECOVERY_ENABLED"]) delete process.env[key]; await db.end(); await closeJobStorePool(); }
});
