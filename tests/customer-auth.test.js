import assert from "node:assert/strict";
import test from "node:test";
import { clearCustomerSession, CustomerAuthError, customerSessionToken, googleEmailAuthority, hashCustomerToken, newCustomerToken, sessionCookie, verifyGoogleCredential } from "@/lib/customer-auth";

const secret = "customer-session-test-secret-with-at-least-thirty-two-characters";
test("Google auth uses opaque server-hashed sessions with secure revocable cookies", () => {
  const old = process.env.CUSTOMER_AUTH_TOKEN_SECRET; process.env.CUSTOMER_AUTH_TOKEN_SECRET = secret;
  try { const token = newCustomerToken(); assert.notEqual(hashCustomerToken(token), token); const cookie = sessionCookie(token); assert.match(cookie, /HttpOnly.*Secure.*SameSite=Lax/); assert.equal(customerSessionToken(new Request("https://cliponaut.example", { headers: { cookie } })), token); assert.match(clearCustomerSession(), /Max-Age=0/); }
  finally { old === undefined ? delete process.env.CUSTOMER_AUTH_TOKEN_SECRET : process.env.CUSTOMER_AUTH_TOKEN_SECRET = old; }
});
test("Google ID credentials require a server-verified subject, verified email, and bound nonce", async () => {
  const client = { verifyIdToken: async () => ({ getPayload: () => ({ sub: "google-stable-subject", email: "member@example.test", email_verified: true, nonce: "nonce" }) }) };
  assert.deepEqual(await verifyGoogleCredential("synthetic-credential", "nonce", { clientId: "client-id", client }), { subject: "google-stable-subject", email: "member@example.test", authority: "external", hostedDomain: null });
  for (const payload of [{ sub: "s", email: "a@b.test", email_verified: false, nonce: "nonce" }, { sub: "s", email: "a@b.test", email_verified: true, nonce: "wrong" }]) await assert.rejects(verifyGoogleCredential("synthetic", "nonce", { clientId: "client-id", client: { verifyIdToken: async () => ({ getPayload: () => payload }) } }), CustomerAuthError);
});
test("only Gmail and matching Google Workspace hd claims are email-ownership authoritative", () => {
  assert.deepEqual(googleEmailAuthority({ email: "member@gmail.com" }), { authority: "gmail", hostedDomain: null });
  assert.deepEqual(googleEmailAuthority({ email: "member@company.example", hd: "company.example" }), { authority: "workspace", hostedDomain: "company.example" });
  assert.deepEqual(googleEmailAuthority({ email: "member@external.example", hd: "other.example" }), { authority: "external", hostedDomain: null });
  assert.deepEqual(googleEmailAuthority({ email: "member@external.example" }), { authority: "external", hostedDomain: null });
});
