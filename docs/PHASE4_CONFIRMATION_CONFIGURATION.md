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
