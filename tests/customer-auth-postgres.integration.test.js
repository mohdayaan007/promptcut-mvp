import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { completeGoogleSignIn, createGoogleLoginNonce, getCustomerSession, migrateEditJobs, revokeCustomerSession } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
integration("Google stable subjects are single-use nonce-bound and only exact Cliponaut subscriptions link", async () => {
  process.env.CUSTOMER_AUTH_TOKEN_SECRET = "customer-auth-integration-secret-with-at-least-thirty-two-characters"; process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); const email = "google-member@example.test";
  try {
    await db.query("DELETE FROM google_login_nonces; DELETE FROM customer_sessions; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,customer_email,status,last_event_at) VALUES ('sub_clip','cliponaut-product',$1,'active',now()),('sub_bynd','bynd-product',$1,'active',now())", [email]);
    const nonce = "n".repeat(48); await createGoogleLoginNonce(nonce); const session = await completeGoogleSignIn({ subject: "google-sub-1", email }, nonce); assert.ok(session); assert.equal(await completeGoogleSignIn({ subject: "google-sub-1", email }, nonce), null);
    assert.ok(await getCustomerSession(session)); assert.ok((await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_clip'")).rows[0].subscriber_id); assert.equal((await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_bynd'")).rows[0].subscriber_id, null);
    await revokeCustomerSession(session); assert.equal(await getCustomerSession(session), null);
  } finally { await db.end(); }
});
