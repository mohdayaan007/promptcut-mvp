import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { closeJobStorePool, completeGoogleSignIn, createCustomerCheckoutCorrelation, createGoogleLoginNonce, getCustomerSession, getCustomerSubscriptionStatus, migrateEditJobs, processDodoWebhookEvent, recordCustomerCheckoutSession, revokeCustomerSession } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
const gmail = (subject, email) => ({ subject, email, authority: "gmail", hostedDomain: null });
const workspace = (subject, email, hostedDomain) => ({ subject, email, authority: "workspace", hostedDomain });
const external = (subject, email) => ({ subject, email, authority: "external", hostedDomain: null });
async function signIn(profile, nonce) { await createGoogleLoginNonce(nonce); return completeGoogleSignIn(profile, nonce); }
async function subscriberFor(db, subscriptionId) { return (await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id=$1", [subscriptionId])).rows[0]?.subscriber_id || null; }
async function processEvent(id, subscription) { return processDodoWebhookEvent(id, "subscription.active", JSON.stringify({ id, subscription }), subscription); }
async function processPayment(id, payment) { return processDodoWebhookEvent(id, "payment.succeeded", JSON.stringify({ id, payment }), null, payment); }

integration("customer-bound checkout correlations remain pending until Dodo proves subscription correlation", async () => {
  process.env.CUSTOMER_AUTH_TOKEN_SECRET = "customer-auth-integration-secret-with-at-least-thirty-two-characters";
  process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM google_login_nonces; DELETE FROM customer_sessions; DELETE FROM customer_checkout_correlations; DELETE FROM dodo_webhook_events; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    // Webhook-before-login never links from matching Google/Dodo email alone.
    await processEvent("evt-gmail-before", { subscriptionId: "sub_gmail_before", productId: "cliponaut-product", customerId: "c1", email: "member@gmail.com", status: "active", occurredAt: "2026-01-01T00:00:00.000Z" });
    const gmailSession = await signIn(gmail("google-gmail", "member@gmail.com"), "a".repeat(48));
    assert.ok(gmailSession); assert.equal(await subscriberFor(db, "sub_gmail_before"), null);
    assert.ok(await getCustomerSession(gmailSession)); await revokeCustomerSession(gmailSession); assert.equal(await getCustomerSession(gmailSession), null);

    // Login-before-webhook also remains unlinked without provider-proven checkout correlation.
    const workspaceSession = await signIn(workspace("google-workspace", "member@workspace.example", "workspace.example"), "b".repeat(48));
    await processEvent("evt-workspace-after", { subscriptionId: "sub_workspace_after", productId: "cliponaut-product", customerId: "c2", email: "member@workspace.example", status: "active", occurredAt: "2026-01-01T00:01:00.000Z" });
    assert.equal(await subscriberFor(db, "sub_workspace_after"), null);

    const workspaceIdentity = (await getCustomerSession(workspaceSession)).subscriber_id;
    const reference = await createCustomerCheckoutCorrelation(workspaceIdentity);
    await recordCustomerCheckoutSession(workspaceIdentity, reference, "cs_synthetic_1");
    assert.equal(await getCustomerSubscriptionStatus(workspaceIdentity), "pending_verification");
    // Subscription before payment: only the provider-owned IDs can complete it.
    await processEvent("evt-after-checkout", { subscriptionId: "sub_after_checkout", productId: "cliponaut-product", customerId: "c2b", email: "member@workspace.example", status: "active", occurredAt: "2026-01-01T00:01:30.000Z", metadata: { cliponaut_checkout_ref: reference } });
    assert.equal(await subscriberFor(db, "sub_after_checkout"), null);
    assert.equal(await processPayment("pay-after-sub", { paymentId: "pay_1", checkoutSessionId: "cs_synthetic_1", subscriptionId: "sub_after_checkout" }), true);
    assert.equal(await processPayment("pay-after-sub", { paymentId: "pay_1", checkoutSessionId: "cs_synthetic_1", subscriptionId: "sub_after_checkout" }), false);
    assert.equal(await subscriberFor(db, "sub_after_checkout"), workspaceIdentity);
    // Status presentation is server-owned and does not grant editing access.
    assert.equal(await getCustomerSubscriptionStatus(workspaceIdentity), "active");
    for (const status of ["past_due", "cancelled", "expired"]) {
      await db.query("UPDATE dodo_subscriptions SET status=$1,updated_at=now() WHERE dodo_subscription_id='sub_after_checkout'", [status]);
      assert.equal(await getCustomerSubscriptionStatus(workspaceIdentity), status);
    }

    // Payment before activation is also safe: it binds only after active signed subscription evidence arrives.
    const reference2 = await createCustomerCheckoutCorrelation(workspaceIdentity); await recordCustomerCheckoutSession(workspaceIdentity, reference2, "cs_synthetic_2");
    await processPayment("pay-before-sub", { paymentId: "pay_2", checkoutSessionId: "cs_synthetic_2", subscriptionId: "sub_payment_first" });
    await processEvent("sub-after-payment", { subscriptionId: "sub_payment_first", productId: "cliponaut-product", customerId: "c2c", email: "member@workspace.example", status: "active", occurredAt: "2026-01-01T00:01:40.000Z" });
    assert.equal(await subscriberFor(db, "sub_payment_first"), workspaceIdentity);

    // A non-Gmail email_verified token without trustworthy hd still authenticates, but never owns payment evidence.
    await processEvent("evt-external-before", { subscriptionId: "sub_external_before", productId: "cliponaut-product", customerId: "c3", email: "member@external.example", status: "active", occurredAt: "2026-01-01T00:02:00.000Z" });
    assert.ok(await signIn(external("google-external", "member@external.example"), "c".repeat(48)));
    assert.equal(await subscriberFor(db, "sub_external_before"), null);
    await processEvent("evt-external-after", { subscriptionId: "sub_external_after", productId: "cliponaut-product", customerId: "c4", email: "member@external.example", status: "active", occurredAt: "2026-01-01T00:03:00.000Z" });
    assert.equal(await subscriberFor(db, "sub_external_after"), null);

    // Product, inactive status, and a forged checkout metadata field cannot link anyone.
    await processEvent("evt-bynd", { subscriptionId: "sub_bynd", productId: "bynd-product", customerId: "c5", email: "member@gmail.com", status: "active", occurredAt: "2026-01-01T00:04:00.000Z" });
    await processEvent("evt-inactive", { subscriptionId: "sub-inactive", productId: "cliponaut-product", customerId: "c6", email: "member@gmail.com", status: "past_due", occurredAt: "2026-01-01T00:05:00.000Z", metadata: { cliponaut_checkout_ref: reference } });
    assert.equal(await subscriberFor(db, "sub_bynd"), null); assert.equal(await subscriberFor(db, "sub-inactive"), null);

    // A stable Google subject may change email, but another Google subject cannot claim it.
    assert.ok(await signIn(gmail("google-gmail", "new-member@gmail.com"), "d".repeat(48)));
    assert.equal(await signIn(gmail("other-google-account", "new-member@gmail.com"), "e".repeat(48)), null);
    const otherSession = await signIn(gmail("different-google-account", "different@gmail.com"), "f".repeat(48));
    const otherIdentity = (await getCustomerSession(otherSession)).subscriber_id;
    await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,status,last_event_at) VALUES ('sub_conflict','cliponaut-product',$1,'active',now())", [otherIdentity]);
    const reference3 = await createCustomerCheckoutCorrelation(workspaceIdentity); await recordCustomerCheckoutSession(workspaceIdentity, reference3, "cs_synthetic_3");
    await processPayment("pay-conflict", { paymentId: "pay_3", checkoutSessionId: "cs_synthetic_3", subscriptionId: "sub_conflict" });
    assert.equal(await subscriberFor(db, "sub_conflict"), otherIdentity, "never transfer a subscription to a different Google account");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM customer_sessions")).rows[0].count > 0, true);
  } finally { await db.end(); await closeJobStorePool(); }
});
