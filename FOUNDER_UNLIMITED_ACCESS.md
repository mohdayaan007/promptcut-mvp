# Founder unlimited access — isolated implementation

Base: production web `ff1d7193a4d28a9584b61517ba42ea6881ef5760`.
Production worker remains `ac0a877c4775aadefbc076294f7d171525e82afc`; nothing has been published or deployed.

## Authorization and configuration

The only new configuration is `FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST`: comma-separated lowercase SHA-256 digests of verified Google `sub` identities. Missing, empty, malformed or unmatched configuration grants no founder exemption. This is a server-only configuration on both web and worker, in each intended staging/production environment. Obtain the digest from independently verified server-side identity evidence; never derive authorization from an email, client request, special URL or the old founder-test cookie. No identity or secret is hard-coded.

The authenticated Google session must still be valid, unexpired and unrevoked. The database identity must still have a verified Google subject. A matching founder can upload and create unlimited successful jobs and revisions without a paid subscription or quota reservation. The worker independently matches the verified database subject to its configured allowlist before claiming an unreserved founder job. Existing queued customer jobs still require their own valid paid reservation. The normal worker loop, concurrency, heartbeat, validation, cleanup, storage and execution engine are unchanged.

Job and conversational-session access still requires the exact subscriber and opaque job/session token. Legacy token-only reads are restricted to records without a Google owner, including when paid enforcement is off. A legacy founder-test cookie grants neither the new exemption nor access to Google-owned founder media. Standard authenticated session cookies remain credentials and must be protected; they are not made non-transferable by this change.

The account usage API labels the founder as unlimited without rewriting paid usage. Existing subscriptions, paid periods and historical quota entries remain intact; customer billing operations and cancellation continue to use genuine paid-period evidence. Founder checkout authorization and public checkout flags are unchanged. Existing source-count, size, duration, format, 4K and media validation limits still apply. Unlimited access is not unlimited simultaneous execution or unlimited upload size.

## Validation

`tests/founder-unlimited.integration.test.js` uses only the disposable `cliponaut_founder_unlimited_tests` PostgreSQL database, synthetic verified identities and mocked financial evidence. All provider/network fetches are prohibited. It exercises real authorization, uploads validation, conversational POSTs, quota accounting and the worker claim/status/completion store path. No actual FFmpeg/storage/provider integration is claimed by these tests; those existing integrations were not changed or re-run.

Coverage includes more than 15 founder jobs in both modes, more than 15 revisions, no founder quota writes, preservation of a simulated existing paid subscription and consumed slot, concurrent customer reservations and rejection after 15 consumed successes, absent/mismatched/malformed allowlists, email reassignment, client impersonation, shared legacy cookies/tokens, cross-account privacy, expired/revoked sessions, revoked verification, and parallel worker claims. Account/editor presentation tests and a production build are also run.

## Focused security findings

The existing `PROJECT_HEALTH.md` security review predates authenticated direct private uploads and the durable bounded worker. Its obsolete claims of wholly unauthenticated, unbounded synchronous production rendering are not treated as current findings: production enforcement closes the legacy processing route, uploads/media are validated, owned reads are checked and the worker retains concurrency limits and cleanup.

The combined security release updates Next.js 16.1.1 to the supported stable 16.4.5 release, matching eslint-config-next 16.4.5. React and React DOM remain 19.2.3. It updates source-map-js to 1.2.2 within the existing dependency range and Playwright to the minimum TLS-fixed 1.55.1. The existing production image installs dev tools and Next declares Playwright as an optional peer, so its advisory also appeared in the production dependency graph.

The final focused production dependency audit reports zero vulnerabilities (including zero critical/high). No production exploit was attempted. The earlier Next.js denial-of-service advisory is resolved by the patched dependency. The new compiler required removing deprecated TypeScript baseUrl and selecting bundler resolution; path aliases remain unchanged. The matching lint package required the recognized null-ref initialization pattern and a cancellable microtask for initial account loading. No authentication or cancellation semantics changed. Existing editor mount/recovery synchronization is left unchanged: the new set-state-in-effect performance rule is advisory only for src/app/page.js. One existing JSX apostrophe is escaped without changing its displayed copy.

Final validation: 35/35 focused Node/PostgreSQL checks, 4/4 founder/customer desktop/mobile UI checks and 4/4 existing cancellation-presentation checks passed; targeted lint, full lint (zero errors; three existing/advisory warnings) and production build passed. UI checks use local intercepted account state and prohibit provider and mutation requests. The existing media-rendering acceptance was not repeated. The Next build retains one pre-existing dynamic filesystem tracing warning in title-renderer.js; this does not fail the build and rendering code was not changed.

Local audit evidence: /private/tmp/cliponaut-founder-security-audit-final.json. Vendor support policy: https://nextjs.org/support-policy. Dependency versions were checked against the official npm registry.

## Essential remaining actions

1. Review and separately approve publication and deployment. Configure the verified allowlist on both web and worker for each intended environment. Deploy the worker before enabling founder job admission on web, so unreserved founder jobs can be claimed. An unconfigured worker fails closed and leaves those jobs queued. No new resource or database migration is required.
2. Check existing confirmation signing configuration (`EDITING_CONFIRMATION_SECRET`) for partial/ambiguous conversational edits before accepting that flow; the existing signer remains fail-closed and no credentials were configured by this task.
3. Perform one authorized founder upload/revision/render and a non-founder denial check after deployment; verify the existing customer usage remains 15-based and is not consumed by founder work. No new purchase is needed.
4. The dependency-security blocker is resolved in this isolated release. Genuine successful renewal and terminal expiry acceptance remain outstanding; previously accepted payment, export and provider-confirmed period-end cancellation are preserved and need no repetition.
