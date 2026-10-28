import assert from "node:assert/strict";
import test from "node:test";
import { FOUNDER_TEST_COOKIE, grantFounderTestAccess, hasFounderTestAccess, isFounderTestEnabled } from "../src/lib/founder-test-access.js";

const secret = "founder-test-secret-that-is-long-enough-for-safe-local-tests";

function setGate({ enabled, accessSecret = secret }) {
  if (enabled) process.env.FOUNDER_CONVERSATIONAL_EDITING_ENABLED = "true";
  else delete process.env.FOUNDER_CONVERSATIONAL_EDITING_ENABLED;
  if (accessSecret === null) delete process.env.FOUNDER_TEST_ACCESS_SECRET;
  else process.env.FOUNDER_TEST_ACCESS_SECRET = accessSecret;
}

test("founder conversational access is default-off and uses an opaque secure HTTP-only cookie", async () => {
  setGate({ enabled: false, accessSecret: null });
  assert.equal(isFounderTestEnabled(), false);
  assert.equal(grantFounderTestAccess(secret), null);

  setGate({ enabled: true });
  const now = Date.now();
  const setCookie = grantFounderTestAccess(secret, now);
  assert.ok(setCookie?.includes("HttpOnly"));
  assert.ok(setCookie?.includes("Secure"));
  assert.ok(setCookie?.includes("SameSite=Strict"));
  assert.ok(!setCookie.includes(secret), "the configured access secret is never placed in the cookie");
  const cookie = setCookie.split(";", 1)[0];
  const request = new Request("https://cliponaut.example/api/editing-sessions/test", { headers: { cookie } });
  assert.equal(hasFounderTestAccess(request, now + 1), true);
  assert.equal(hasFounderTestAccess(new Request("https://cliponaut.example", { headers: { cookie: `${FOUNDER_TEST_COOKIE}=tampered` } }), now + 1), false);

  setGate({ enabled: false });
  assert.equal(hasFounderTestAccess(request, now + 1), false, "disabling the environment gate immediately revokes access");
});

test("editing-session routes reject an ordinary request before reading session data", async () => {
  setGate({ enabled: false, accessSecret: null });
  const route = await import("@/app/api/editing-sessions/[id]/route");
  const response = await route.GET(new Request("http://localhost/api/editing-sessions/not-a-session", { headers: { "x-cliponaut-session-token": "not-a-token" } }), { params: Promise.resolve({ id: "not-a-session" }) });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Editing session was not found");
});
