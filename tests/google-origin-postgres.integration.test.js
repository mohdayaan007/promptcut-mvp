import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { OAuth2Client } from "google-auth-library";
import { Client } from "pg";
import { POST } from "@/app/api/auth/google/route";
import { CUSTOMER_SESSION_COOKIE, GOOGLE_NONCE_COOKIE } from "@/lib/customer-auth";
import { closeJobStorePool, createGoogleLoginNonce, getCustomerSession, migrateEditJobs } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL && process.env.CLIPONAUT_ISOLATED_BILLING_TESTS === "true" ? test : test.skip;
const origin = "https://cliponaut-dodo-test-web-staging.up.railway.app";
const audience = "isolated-client.apps.googleusercontent.com";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
function credential(nonce, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const parts = [{ alg: "RS256", kid: "isolated-key" }, { iss: "https://accounts.google.com", aud: audience, sub: "google-owner", email: "owner@gmail.com", email_verified: true, iat: now, exp: now + 600, nonce, ...claims }];
  const signed = parts.map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  return `${signed}.${crypto.sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}
async function fixture(run) {
  const saved = { ...process.env }, originalCertificates = OAuth2Client.prototype.getFederatedSignonCertsAsync;
  let certificateCalls = 0;
  Object.assign(process.env, { CUSTOMER_CHECKOUT_ORIGIN: origin, GOOGLE_OAUTH_CLIENT_ID: audience, CUSTOMER_AUTH_TOKEN_SECRET: "isolated-google-origin-secret-at-least-thirty-two-characters" });
  // Replace only Google's certificate download; its signature, issuer, audience
  // and expiry verification execute normally against a locally signed fixture.
  OAuth2Client.prototype.getFederatedSignonCertsAsync = async () => {
    certificateCalls++;
    return { certs: { "isolated-key": publicKey.export({ type: "spki", format: "pem" }) }, format: "PEM" };
  };
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("TRUNCATE subscriber_identities CASCADE; DELETE FROM google_login_nonces; DELETE FROM dodo_webhook_events;");
    const challenge = async () => { const nonce = crypto.randomBytes(32).toString("base64url"); await createGoogleLoginNonce(nonce); return nonce; };
    const request = (nonce, { headers = {}, claims = {}, token = credential(nonce, claims) } = {}) => new Request("https://localhost:8080/api/auth/google", { method: "POST", headers: { origin, cookie: `${GOOGLE_NONCE_COOKIE}=${nonce}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ nonce, credential: token }) });
    await run({ db, challenge, request, certificateCalls: () => certificateCalls });
  } finally {
    OAuth2Client.prototype.getFederatedSignonCertsAsync = originalCertificates;
    await db.end(); await closeJobStorePool();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
  }
}

integration("Google sign-in accepts the public Railway origin, ignores spoofed proxy headers and issues a secure hashed session", async () => fixture(async ({ db, challenge, request }) => {
  const nonce = await challenge();
  const response = await POST(request(nonce, { headers: { host: "foreign.invalid", "x-forwarded-host": "foreign.invalid", "x-forwarded-proto": "http" } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const cookies = response.headers.getSetCookie(); const sessionCookie = cookies.find(cookie => cookie.startsWith(`${CUSTOMER_SESSION_COOKIE}=`));
  assert.match(sessionCookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(cookies.some(cookie => cookie.startsWith(`${GOOGLE_NONCE_COOKIE}=`) && cookie.includes("Max-Age=0")));
  const token = sessionCookie.split(";")[0].split("=")[1]; const session = await getCustomerSession(token);
  assert.equal(session.email, "owner@gmail.com");
  assert.notEqual((await db.query("SELECT token_hash FROM customer_sessions")).rows[0].token_hash, token);
  assert.equal((await POST(request(nonce))).status, 401, "consumed nonce cannot create another session");
  assert.equal((await db.query("SELECT count(*)::int count FROM customer_sessions")).rows[0].count, 1);
}));

integration("Google sign-in rejects missing, malformed and foreign origins before token verification or database writes", async () => fixture(async ({ db, request, certificateCalls }) => {
  for (const value of [undefined, "", "null", "invalid", "https://foreign.invalid", "https://localhost:8080", origin + "/", origin + ".evil.test"]) {
    const req = request("unused", { headers: { origin: value || "", host: new URL(origin).host, "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "https" } });
    if (value === undefined) req.headers.delete("origin");
    assert.equal((await POST(req)).status, 403, String(value));
  }
  assert.equal(certificateCalls(), 0);
  for (const table of ["subscriber_identities", "customer_sessions", "google_login_nonces"]) assert.equal((await db.query(`SELECT count(*)::int count FROM ${table}`)).rows[0].count, 0);
}));

integration("Google sign-in fails closed when the shared server origin is missing or invalid", async () => fixture(async ({ request, certificateCalls }) => {
  for (const value of [undefined, "http://localhost:8080", origin + "/account"]) {
    if (value === undefined) delete process.env.CUSTOMER_CHECKOUT_ORIGIN; else process.env.CUSTOMER_CHECKOUT_ORIGIN = value;
    assert.equal((await POST(request("unused"))).status, 503);
  }
  assert.equal(certificateCalls(), 0);
}));

integration("Google ID-token audience, issuer, expiry, signature and verified email remain enforced", async () => fixture(async ({ db, challenge, request }) => {
  for (const claims of [{ aud: "another-client" }, { iss: "https://foreign.invalid" }, { iat: 1, exp: 2 }, { email_verified: false }, { sub: "" }]) {
    const nonce = await challenge(); assert.equal((await POST(request(nonce, { claims }))).status, 401);
  }
  const nonce = await challenge(); const token = credential(nonce); const parts = token.split(".");
  const signature = Buffer.from(parts[2], "base64url"); signature[0] ^= 1; parts[2] = signature.toString("base64url");
  assert.equal((await POST(request(nonce, { token: parts.join(".") }))).status, 401);
  assert.equal((await db.query("SELECT count(*)::int count FROM customer_sessions")).rows[0].count, 0);
}));

integration("Google cookie, token and stored nonce checks reject CSRF, wrong challenges and expired challenges", async () => fixture(async ({ db, challenge, request }) => {
  const nonce = await challenge();
  assert.equal((await POST(request(nonce, { headers: { cookie: "" } }))).status, 403);
  assert.equal((await POST(request(nonce, { headers: { cookie: `${GOOGLE_NONCE_COOKIE}=different` } }))).status, 403);
  assert.equal((await POST(request(nonce, { claims: { nonce: "different" } }))).status, 401);
  await db.query("UPDATE google_login_nonces SET expires_at=now()-interval '1 minute'");
  assert.equal((await POST(request(nonce))).status, 401);
  assert.equal((await db.query("SELECT count(*)::int count FROM customer_sessions")).rows[0].count, 0);
}));

integration("a different Google subject cannot claim an existing account through the same email", async () => fixture(async ({ db, challenge, request }) => {
  assert.equal((await POST(request(await challenge()))).status, 200);
  const owner = (await db.query("SELECT id,google_subject FROM subscriber_identities")).rows[0];
  assert.equal((await POST(request(await challenge(), { claims: { sub: "other-google-account" } }))).status, 401);
  assert.deepEqual((await db.query("SELECT id,google_subject FROM subscriber_identities")).rows, [owner]);
  assert.equal((await db.query("SELECT count(*)::int count FROM customer_sessions")).rows[0].count, 1);
}));
