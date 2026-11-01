import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleSignInCoordinator } from "@/lib/google-sign-in-client";

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function response(nonce) { return { ok: true, json: async () => ({ nonce }) }; }

test("account browser lifecycle waits for one nonce challenge and cannot be reordered by a second initial request", async () => {
  const nonce = deferred(); let requests = 0; let initialized = 0; let rendered = 0; const states = [];
  const google = { accounts: { id: { initialize: () => { initialized += 1; }, renderButton: () => { rendered += 1; } } } };
  const coordinator = createGoogleSignInCoordinator({
    fetchImpl: async () => { requests += 1; return nonce.promise; }, loadScript: async () => google,
    render: (value) => value.accounts.id.renderButton(), onState: (state) => states.push(state), onCredential: async () => {}
  });
  const first = coordinator.start(); const duplicate = coordinator.start();
  assert.equal(requests, 1, "initial session lifecycle has one active nonce request");
  nonce.resolve(response("fresh-nonce")); await Promise.all([first, duplicate]);
  assert.equal(initialized, 1); assert.equal(rendered, 1); assert.deepEqual(states.at(-1), { phase: "ready", error: "" });
});

test("GIS or nonce failures present a retryable error and retry creates one fresh challenge", async () => {
  let nonceRequests = 0; let scriptAttempts = 0; const states = [];
  const google = { accounts: { id: { initialize: () => {}, renderButton: () => {} } } };
  const coordinator = createGoogleSignInCoordinator({
    fetchImpl: async () => { nonceRequests += 1; return response(`nonce-${nonceRequests}`); },
    loadScript: async () => { scriptAttempts += 1; if (scriptAttempts === 1) throw new Error("network"); return google; },
    render: () => {}, onState: (state) => states.push(state), onCredential: async () => {}
  });
  await coordinator.start();
  assert.deepEqual(states.at(-1), { phase: "error", error: "Google sign-in is temporarily unavailable." });
  await coordinator.retry();
  assert.equal(nonceRequests, 2); assert.equal(scriptAttempts, 2); assert.deepEqual(states.at(-1), { phase: "ready", error: "" });
});
