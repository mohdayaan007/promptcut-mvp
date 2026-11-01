import assert from "node:assert/strict";
import test from "node:test";
import { requireCustomerCheckoutOrigin } from "@/lib/checkout-origin";

const origin = "https://cliponaut-dodo-test-web-staging.up.railway.app";
function configured(value, run) {
  const saved = process.env.CUSTOMER_CHECKOUT_ORIGIN;
  try {
    if (value === undefined) delete process.env.CUSTOMER_CHECKOUT_ORIGIN;
    else process.env.CUSTOMER_CHECKOUT_ORIGIN = value;
    run();
  } finally {
    if (saved === undefined) delete process.env.CUSTOMER_CHECKOUT_ORIGIN;
    else process.env.CUSTOMER_CHECKOUT_ORIGIN = saved;
  }
}
const request = headers => new Request("https://localhost:8080/api/billing/dodo/customer-checkout", { headers });

test("configured public HTTPS origin accepts Railway's internal localhost URL and ignores spoofed routing headers", () => configured(origin, () => {
  for (const headers of [{}, { host: "foreign.invalid", "x-forwarded-host": "foreign.invalid", "x-forwarded-proto": "http" }]) {
    assert.doesNotThrow(() => requireCustomerCheckoutOrigin(request({ origin, ...headers })));
  }
}));

test("missing, malformed, opaque, foreign and internal origins cannot be authorized by proxy headers", () => configured(origin, () => {
  for (const value of [undefined, "", "null", "invalid", "https://foreign.invalid", "https://localhost:8080", origin + "/", origin + "/account", origin + ".evil.test", origin + ":8443", origin + ", https://foreign.invalid", origin.replace("https:", "http:")]) {
    const headers = { host: new URL(origin).host, "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "https" };
    if (value !== undefined) headers.origin = value;
    assert.throws(() => requireCustomerCheckoutOrigin(request(headers)), error => error.status === 403, String(value));
  }
}));

test("missing or non-canonical server origin configuration fails closed without a request-header fallback", () => {
  for (const value of [undefined, "", "null", "invalid", "http://localhost:8080", origin + "/", origin + "/account", origin + "?x=1", origin + "#x", origin.replace("https://", "https://user:pass@"), origin + ",https://foreign.invalid"]) {
    configured(value, () => assert.throws(() => requireCustomerCheckoutOrigin(request({ origin })), error => error.status === 503, String(value)));
  }
});
