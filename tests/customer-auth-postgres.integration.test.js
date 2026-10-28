import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { closeJobStorePool, completeGoogleSignIn, createGoogleLoginNonce, getCustomerSession, migrateEditJobs, processDodoWebhookEvent, revokeCustomerSession } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
const gmail = (subject, email) => ({ subject, email, authority: "gmail", hostedDomain: null });
const workspace = (subject, email, hostedDomain) => ({ subject, email, authority: "workspace", hostedDomain });
const external = (subject, email) => ({ subject, email, authority: "external", hostedDomain: null });
async function signIn(profile, nonce) { await createGoogleLoginNonce(nonce); return completeGoogleSignIn(profile, nonce); }
async function subscriberFor(db, subscriptionId) { return (await db.query("SELECT subscriber_id FROM dodo_subscriptions WHERE dodo_subscription_id=$1", [subscriptionId])).rows[0]?.subscriber_id || null; }
async function processEvent(id, subscription) { return processDodoWebhookEvent(id, "subscription.active", JSON.stringify({ id, subscription }), subscription); }

integration("Google authority only links active exact Cliponaut subscriptions without granting entitlements", async () => {
  process.env.CUSTOMER_AUTH_TOKEN_SECRET = "customer-auth-integration-secret-with-at-least-thirty-two-characters";
  process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM google_login_nonces; DELETE FROM customer_sessions; DELETE FROM dodo_webhook_events; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    // Webhook-before-login: Gmail becomes linked only after its Google account is verified.
    await processEvent("evt-gmail-before", { subscriptionId: "sub_gmail_before", productId: "cliponaut-product", customerId: "c1", email: "member@gmail.com", status: "active", occurredAt: "2026-01-01T00:00:00.000Z" });
    const gmailSession = await signIn(gmail("google-gmail", "member@gmail.com"), "a".repeat(48));
    assert.ok(gmailSession); assert.ok(await subscriberFor(db, "sub_gmail_before"));
    assert.ok(await getCustomerSession(gmailSession)); await revokeCustomerSession(gmailSession); assert.equal(await getCustomerSession(gmailSession), null);

    // Login-before-webhook: a matching Workspace hosted-domain claim permits reconciliation.
    await signIn(workspace("google-workspace", "member@workspace.example", "workspace.example"), "b".repeat(48));
    await processEvent("evt-workspace-after", { subscriptionId: "sub_workspace_after", productId: "cliponaut-product", customerId: "c2", email: "member@workspace.example", status: "active", occurredAt: "2026-01-01T00:01:00.000Z" });
    assert.ok(await subscriberFor(db, "sub_workspace_after"));

    // A non-Gmail email_verified token without trustworthy hd still authenticates, but never owns payment evidence.
    await processEvent("evt-external-before", { subscriptionId: "sub_external_before", productId: "cliponaut-product", customerId: "c3", email: "member@external.example", status: "active", occurredAt: "2026-01-01T00:02:00.000Z" });
    assert.ok(await signIn(external("google-external", "member@external.example"), "c".repeat(48)));
    assert.equal(await subscriberFor(db, "sub_external_before"), null);
    await processEvent("evt-external-after", { subscriptionId: "sub_external_after", productId: "cliponaut-product", customerId: "c4", email: "member@external.example", status: "active", occurredAt: "2026-01-01T00:03:00.000Z" });
    assert.equal(await subscriberFor(db, "sub_external_after"), null);

    // Product and status boundaries remain intact, and no customer entitlement is written anywhere.
    await processEvent("evt-bynd", { subscriptionId: "sub_bynd", productId: "bynd-product", customerId: "c5", email: "member@gmail.com", status: "active", occurredAt: "2026-01-01T00:04:00.000Z" });
    await processEvent("evt-inactive", { subscriptionId: "sub-inactive", productId: "cliponaut-product", customerId: "c6", email: "member@gmail.com", status: "past_due", occurredAt: "2026-01-01T00:05:00.000Z" });
    assert.equal(await subscriberFor(db, "sub_bynd"), null); assert.equal(await subscriberFor(db, "sub-inactive"), null);

    // A stable Google subject may change email, but another Google subject cannot claim it.
    assert.ok(await signIn(gmail("google-gmail", "new-member@gmail.com"), "d".repeat(48)));
    assert.equal(await signIn(gmail("other-google-account", "new-member@gmail.com"), "e".repeat(48)), null);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM customer_sessions")).rows[0].count > 0, true);
  } finally { await db.end(); await closeJobStorePool(); }
});
