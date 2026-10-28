# Phase 4 founder-only hosted test

This runbook is for an explicitly approved, controlled test on the existing Railway production services. It is not deployment authorization and must not be used to enable Phase 4 for ordinary customers.

## Guard behaviour

- `FOUNDER_CONVERSATIONAL_EDITING_ENABLED` is disabled unless its value is exactly `true`.
- `FOUNDER_TEST_ACCESS_SECRET` must be a high-entropy secret of at least 32 characters. It belongs only in the existing **web** service's Railway variables, never in a `NEXT_PUBLIC_*` variable, repository file, URL, browser storage, or log.
- With the flag absent/false or the secret absent, initial uploads follow the established one-shot edit path with no session field. Editing-session history and follow-up APIs return 404.
- With the flag enabled, the founder visits `/founder-test`, submits the secret over HTTPS, and receives an opaque one-hour `Secure; HttpOnly; SameSite=Strict` cookie. The cookie contains no secret. The normal editor receives conversational sessions only while that cookie is valid.
- Turning the flag off immediately disables session creation and follow-up access, including cookies that have not expired.

## Founder-approved rollout

1. Record the current successful web and `cliponaut-worker` deployment identifiers and review their rollback controls. Confirm the PR remains draft and that RV/Dodo are untouched.
2. Take the normal operational database backup/snapshot permitted by the existing Railway project policy. Do not create a new service, environment, bucket, or database.
3. Run the additive Phase 4 job/session migration once against the existing PostgreSQL database using the release's approved migration process (`npm run migrate:jobs`). Do not run it from this repository without founder approval.
4. Deploy the compatible web and worker revisions together, with `FOUNDER_CONVERSATIONAL_EDITING_ENABLED` unset or `false`. The worker remains at concurrency one.
5. Verify the ordinary customer path first: upload a fixture, submit one edit, receive a normal queued job without a session, and download its completed MP4. Do not visit `/founder-test` for this check.
6. Set the web-service-only variables: `FOUNDER_CONVERSATIONAL_EDITING_ENABLED=true` and a new high-entropy `FOUNDER_TEST_ACCESS_SECRET`. Confirm Railway masks the value. Restart/redeploy the web service only if Railway does not apply variables to the running process automatically. Never put this value in the worker, client bundle, screenshots, or support messages.
7. In an isolated founder browser, open `/founder-test`, authenticate, then run the real authorized talking-head fixture through: Ahmed Perfumes selection, output-relative trim, black and white, cinematic replacement, reset to normal, refresh/history recovery, a deliberately unsupported instruction, and a failed/cancelled follow-up followed by recovery. Confirm signed MP4 download works before and after browser refresh; repeat after the normal 15-minute signed-URL lifetime so the app obtains a fresh URL from history/job APIs.
8. Record results without copying cookies, access codes, signed URLs, storage keys, or customer media into the PR. Disable the flag when the bounded founder session is complete.

## Rollback

1. Set `FOUNDER_CONVERSATIONAL_EDITING_ENABLED=false` (or remove it). This is the fastest access revocation and leaves ordinary one-shot editing available.
2. If the hosted test identifies a web or worker regression, roll web and worker back together to the recorded successful deployments. Do not delete session/version rows or bucket objects as part of rollback.
3. Keep the additive migration in place; it is backward-compatible with the prior one-shot job path. Review worker and web logs for unfinished founder jobs, then use the existing retention cleanup rather than destructive manual cleanup.

## Acceptance boundary

The hosted founder test is required to validate real speech-based Ahmed Perfumes selection, browser history/preview behavior, signed-download expiry, and creative quality. Local mocks and FFmpeg tests do not mark those checks as production-verified.
