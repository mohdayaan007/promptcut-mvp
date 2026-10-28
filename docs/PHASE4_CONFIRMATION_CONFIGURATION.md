# Phase 4 confirmation configuration

Conversational partial-edit confirmations require a server-only
`EDITING_CONFIRMATION_SECRET` environment variable. Set it to a cryptographically
random value of at least 32 bytes before enabling the Phase 4 founder gate.

The value is used only by the web service to sign short-lived, session-bound
confirmation actions. It must never be exposed to the browser, committed to the
repository, logged, or shared with the worker. The web service fails closed with
a safe 503 response if it is absent or too short.

For a controlled rollout, configure the same value on every web-service replica
before routing founder traffic to the release. Retain the prior value during a
rollback so existing, unexpired confirmations remain verifiable; rotate it only
after the confirmation lifetime (ten minutes) has elapsed.

## Future Railway configuration

This integration does not require a deployment and does not add payment or Dodo
Payments credentials. Do not configure checkout, webhooks, or a payment return
URL until a separately approved payment integration exists.

When this release is later deployed to Railway, configure
`EDITING_CONFIRMATION_SECRET` on the **web service only**. It is intentionally
not a `NEXT_PUBLIC_` variable and must not be passed to the browser or worker.
Keep the existing production service configuration in its current scopes:

- The web service needs its existing database, private object-storage, and
  Gemini configuration to create and report editing jobs.
- The worker needs its existing database, private object-storage, and Gemini
  configuration to process queued jobs; it does not need the confirmation
  secret.
- If the founder-only conversational gate is enabled, retain its existing
  server-side `FOUNDER_CONVERSATIONAL_EDITING_ENABLED` and
  `FOUNDER_TEST_ACCESS_SECRET` configuration. Do not expose either value to
  clients.

Use a new, cryptographically random local-only value for tests. Never commit
test or production values, and do not change Railway variables as part of this
integration branch.
