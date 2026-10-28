import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";
import { clearCustomerSession, customerSessionToken, CustomerAuthError, hashCustomerToken, newCustomerToken, normalizeCustomerEmail, sendVerificationEmail, sessionCookie } from "@/lib/customer-auth";

const secret = "customer-auth-test-secret-with-at-least-thirty-two-characters";

test("customer tokens are opaque, server-hashed, and cookies are secure", () => {
  const prior = process.env.CUSTOMER_AUTH_TOKEN_SECRET; process.env.CUSTOMER_AUTH_TOKEN_SECRET = secret;
  try {
    const token = newCustomerToken(); assert.ok(token.length >= 40); assert.notEqual(hashCustomerToken(token), token);
    const cookie = sessionCookie(token); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    assert.equal(customerSessionToken(new Request("https://cliponaut.example", { headers: { cookie } })), token);
    assert.match(clearCustomerSession(), /Max-Age=0/);
  } finally { prior === undefined ? delete process.env.CUSTOMER_AUTH_TOKEN_SECRET : process.env.CUSTOMER_AUTH_TOKEN_SECRET = prior; }
});

test("email normalization rejects invalid values without account lookup", () => {
  assert.equal(normalizeCustomerEmail(" Member@Example.test "), "member@example.test");
  for (const value of ["", "not-an-email", null]) assert.throws(() => normalizeCustomerEmail(value), CustomerAuthError);
});

test("email adapter fails closed until configured and never needs a real request in tests", async () => {
  const old = { key: process.env.RESEND_API_KEY, from: process.env.CUSTOMER_AUTH_EMAIL_FROM, url: process.env.CUSTOMER_AUTH_APP_URL };
  delete process.env.RESEND_API_KEY; delete process.env.CUSTOMER_AUTH_EMAIL_FROM; delete process.env.CUSTOMER_AUTH_APP_URL;
  await assert.rejects(sendVerificationEmail({ email: "member@example.test", token: crypto.randomBytes(32).toString("base64url") }), CustomerAuthError);
  Object.assign(process.env, { RESEND_API_KEY: "synthetic", CUSTOMER_AUTH_EMAIL_FROM: "Cliponaut <auth@example.test>", CUSTOMER_AUTH_APP_URL: "https://cliponaut.example" });
  try { let body; await sendVerificationEmail({ email: "member@example.test", token: "synthetic-token", fetchImpl: async (_url, request) => { body = JSON.parse(request.body); return new Response("{}", { status: 200 }); } }); assert.match(body.text, /token=synthetic-token/); }
  finally { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[{ key: "RESEND_API_KEY", from: "CUSTOMER_AUTH_EMAIL_FROM", url: "CUSTOMER_AUTH_APP_URL" }[key]] : process.env[{ key: "RESEND_API_KEY", from: "CUSTOMER_AUTH_EMAIL_FROM", url: "CUSTOMER_AUTH_APP_URL" }[key]] = value; }
});
