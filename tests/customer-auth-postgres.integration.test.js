import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { createCustomerVerification, completeCustomerVerification, getCustomerSession, migrateEditJobs, requestVerificationAllowed, revokeCustomerSession } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
integration("customer verification is single-use, rate-limited, session-backed, and links confirmed subscriptions", async () => {
  process.env.CUSTOMER_AUTH_TOKEN_SECRET = "customer-auth-integration-secret-with-at-least-thirty-two-characters"; process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product";
  await migrateEditJobs();
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); const email = "identity-integration@example.test";
  try {
    await db.query("DELETE FROM customer_sessions; DELETE FROM customer_verification_tokens; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,customer_email,status,last_event_at) VALUES ('sub_identity','cliponaut-product',$1,'active',now())", [email]);
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,customer_email,status,last_event_at) VALUES ('sub_bynd','bynd-product',$1,'active',now())", [email]);
    const token = "a".repeat(48); await createCustomerVerification(email, token); const session = await completeCustomerVerification(email, token); assert.ok(session);
    assert.equal(await completeCustomerVerification(email, token), null, "a consumed link cannot replay"); assert.ok(await getCustomerSession(session));
    const linked = await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_identity'"); assert.ok(linked.rows[0].subscriber_id);
    assert.equal((await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id='sub_bynd'")).rows[0].subscriber_id, null);
    await revokeCustomerSession(session); assert.equal(await getCustomerSession(session), null);
    for (let index = 0; index < 5; index++) await createCustomerVerification(email, `${index}`.repeat(48)); assert.equal(await requestVerificationAllowed(email), false);
  } finally { await db.end(); }
});
