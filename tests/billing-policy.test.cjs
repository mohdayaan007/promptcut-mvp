const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { buildSync } = require("esbuild");

// Match Next's automatic JSX transform for this repository's .js components.
const bundled = buildSync({
  stdin: { contents: 'export { CheckoutButton } from "./src/components/cliponaut/CheckoutButton.js"; export { default as Pricing } from "./src/app/pricing/page.js"; export { default as Terms } from "./src/app/terms/page.js"; export { default as Refunds } from "./src/app/refunds/page.js";', resolveDir: process.cwd(), loader: "js" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external",
  loader: { ".js": "jsx" }, jsx: "automatic", alias: { "@": path.resolve("src") },
}).outputFiles[0].text;
const fixture = { exports: {} };
vm.runInNewContext(bundled, { module: fixture, exports: fixture.exports, require, process, console });
const { CheckoutButton, Pricing, Terms, Refunds } = fixture.exports;
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("refund limits are visible before both purchase-entry CTAs, linked and associated accessibly", () => {
  for (const signedIn of [false, true]) {
    const html = render(CheckoutButton, { signedIn });
    assert.match(text(html), /within 7 days, with no more than 3 successful renders consumed/);
    assert.match(text(html), /fourth successful render ends standard refund eligibility/);
    assert.match(text(html), /Failed renders do not count/);
    assert.match(html, /href="\/refunds"/);
    const id = html.match(/aria-describedby="([^"]+)"/)[1];
    assert.ok(html.includes(`id="${id}"`));
    const label = signedIn ? "Continue to checkout" : "Sign in to continue";
    assert.ok(html.indexOf("First-purchase refunds") < html.indexOf(label));
    assert.doesNotMatch(html, /type="checkbox"/);
  }
});

test("Pricing, Terms and Refunds render the same purchase, usage and fourth-render boundaries", () => {
  for (const Page of [Pricing, Terms, Refunds]) {
    const html = render(Page), copy = text(html);
    assert.match(copy, /\$5/);
    assert.match(copy, /15 successful renders/);
    assert.match(copy, /verified paid billing period/);
    assert.match(copy, /within 7 days, with no more than 3 successful renders consumed/);
    assert.match(copy, /Completing a fourth successful render ends standard refund eligibility/);
    assert.match(copy, /Failed renders do not count/);
    assert.doesNotMatch(copy, /not currently accepting|subscriptions are not currently open|still being finalized|final binding terms will/i);
  }
});

test("full policy preserves manual handling, existing support, exceptions and paid-period cancellation", () => {
  const html = render(Refunds), copy = text(html);
  assert.match(html, /mailto:cliponauthq@gmail\.com/);
  assert.match(copy, /first purchase, not later monthly renewal payments/);
  assert.match(copy, /handled manually through Dodo Payments/);
  assert.match(copy, /original payment method/);
  assert.match(copy, /no automatic refund system/);
  assert.match(copy, /applicable consumer law/);
  assert.match(copy, /duplicate charges and genuine technical failures/);
  assert.match(copy, /even if 7 days have passed or more than 3 successful renders/);
  assert.match(copy, /cancel anytime/);
  assert.match(copy, /Once cancellation is confirmed, no further renewal is scheduled/);
  assert.match(copy, /until the end of your already-paid period/);
  assert.match(copy, /requesting a refund does not confirm cancellation/);
});
