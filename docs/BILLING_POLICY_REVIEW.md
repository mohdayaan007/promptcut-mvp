# Billing and refund policy review — 2 November 2026

Base: `ac0a877c4775aadefbc076294f7d171525e82afc`.

## Approved policy implemented

- $5 USD/month, recurring until cancelled; 15 successful renders per verified paid period.
- First-purchase requests within 7 days, with at most 3 successful renders consumed.
- Completing a fourth successful render ends standard eligibility; failed renders do not count.
- Manual review and manual Dodo processing; existing support: `cliponauthq@gmail.com`.
- Consumer-law, duplicate-charge and genuine-technical-failure exceptions are preserved.
- Confirmed cancellation stops future scheduled renewal and retains access through the paid period.
- The shared disclosure appears before the pricing CTA and authenticated account checkout button,
  with a full-policy link and accessible description; no new confirmation step is introduced.
- This is public wording only: no automatic eligibility calculation, refund or cancellation behavior changes.
- No future-price-increase terms, provider changes, production deployment or checkout activation.

## Official provider review and remaining launch decision

Reviewed the current Dodo buyer terms at https://dodopayments.com/legal/buyer-terms
and buyer support guidance at https://dodopayments.com/es/support/why-has-dodo-payments-charged-me.

Dodo retains discretion over refunds, describes remedies for delivery problems, and processes
refunds to the original payment method. The copy preserves applicable legal rights and Dodo
buyer-term remedies rather than treating the render threshold as an absolute bar to them.
No blanket provider prohibition of the proposed standard 7-day/3-render policy was established;
this review does not constitute Dodo approval of it.

Potential conflict: Dodo's published subscription terms describe contacting it at least 48 hours
before period end, whereas the founder-approved Cliponaut policy offers anytime self-service
cancellation. The implementation preserves the approved promise and requires confirmation before
stating renewals have stopped. Founder must resolve the provider wording/operating-policy alignment
before launch; no Dodo contact or mutation was performed in this task.

The policy promises no fixed bank-posting deadline or automatic refund. General renewal refunds
are outside the first-purchase standard policy, while the stated exceptions remain available.
Genuine provider cancellation/expiry acceptance remains separate from this copy change.

## Validation

- 3 focused rendered-component/policy regressions passed.
- 2 existing focused pricing and disclosure-contrast checks passed.
- 8 production-build browser checks passed: Pricing, Terms, Refunds and mocked signed-in
  Account at 390px mobile and 1280px desktop widths, with no horizontal overflow.
- Pricing and Account disclosures precede their CTAs; no checkbox or extra purchase step.
- Mobile Pricing and Account screenshots were inspected.
- Targeted ESLint and production Next.js build passed, using synthetic Google IDs.
- All external browser requests were blocked; no checkout click, provider API, database,
  render or AI request occurred. The founder's dirty worktree was unchanged.
