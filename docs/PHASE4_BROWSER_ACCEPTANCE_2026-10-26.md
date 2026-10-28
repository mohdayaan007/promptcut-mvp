# Phase 4 browser acceptance — 2026-10-26

## Scope and environment

This is a local, disposable acceptance run. It did not contact Railway or
production services and did not use production credentials. The browser test
uses Playwright 1.51.1 with the environment's Chromium 151. PostgreSQL ran in
a disposable local container and S3 operations ran against a disposable Moto
S3 server. The worker rendered with local FFmpeg.

The founder gate was enabled only for this local process, with a temporary
in-memory configuration value. No access value is committed, printed here, or
made available to browser JavaScript.

## Automated result

`npm run test:browser-phase4` passed: **1/1** in **98.5 seconds**.

The browser test performs this customer flow:

| Check | Result | Evidence |
| --- | --- | --- |
| Temporary founder authentication | PASS | The test submits the local-only gate code; an intentionally mismatched value was rejected with HTTP 401 before the passing run. |
| Initial video upload | PASS | UI file chooser, AWS SDK v3 multipart upload, private object storage and upload completion all ran. |
| First turn: black and white | PASS | A real worker render completed and the UI displayed its completion and playable preview. |
| Follow-up: trim first five seconds | PASS | UI showed the retained/previous-edit label while processing and the rendered preview changed from 12.0s to 7.0s. |
| Cinematic replacement | PASS | The session API created the next version; the UI displayed its replacement confirmation and a 7.0s preview. |
| Restore normal | PASS | The UI displayed its restoration confirmation; prior trim remained at 7.0s. |
| Refresh/history recovery | PASS | Reload restored the completion conversation and a playable 7.0s preview. |
| Undo | PASS | UI restored the prior successful version without another source upload. |
| Unsupported instruction recovery | PASS | The API returned a bounded HTTP 422 client error; the browser retained the prior video source URL and download controls. |
| Downloadable output | PASS | Browser fetched the displayed download URL; FFprobe asserted MP4 container, a video stream, and duration within 0.35s of 7.0s. |
| Desktop layout | PASS | Executed at 1440×960. |
| Mobile layout | PASS | Executed at 390×844; no horizontal overflow on the empty editor. |

The run generated independent initial, trim, cinematic, and normal MP4s from
the uploaded original through the actual background worker. It did not mock
the storage, worker, or FFmpeg path.

## Additional validation

- `npm run lint`: PASS — 0 errors; one pre-existing `next/image` advisory in
  `src/app/editor/page.js`.
- `npm run build`: PASS with the local-network sandbox permission required by
  Turbopack's CSS worker. A first restricted-sandbox attempt failed with
  `creating new process / binding to a port: Operation not permitted`; the
  network-enabled retry compiled, type-checked, collected data, and generated
  all 9 routes successfully. This is an environment limitation, not a source
  failure.

## Test-harness fixes made

- Added the `test:browser-phase4` Playwright/Node test and pinned
  `@playwright/test` as a development dependency.
- Uses the visible upload control and file chooser rather than injecting a
  hidden input, which exercises the user path reliably.
- Uses `localhost:3000`, which is already the configured local S3 CORS origin;
  no production CORS rules were widened.

## Hosted status and recommendation

This is evidence for controlled local acceptance only. Hosted Railway testing
remains **not verified**: no deployment, production migration, Railway
configuration, hosted browser session, or production media was accessed.

Recommendation: the branch is suitable for a controlled founder-only Railway
test after the documented migration/web/worker/access-gate rollout checks in
the Phase 4 acceptance report. It is not a production-readiness declaration;
hosted acceptance and the real Ahmed Perfumes speech-selection journey remain
separate required gates.
