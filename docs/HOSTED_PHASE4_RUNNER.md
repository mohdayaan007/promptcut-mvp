# Hosted Phase 4 acceptance runner

`npm run test:hosted-phase4` is a production-only, headed Playwright suite for
the controlled founder test of Phase 4. It is intentionally separate from the
local disposable-infrastructure test and never starts Next.js, PostgreSQL,
S3-compatible storage, or a worker.

## Run from a normal Mac Terminal

From the Phase 4 checkout:

```bash
git switch feature/phase4-conversational-editing
git pull --ff-only origin feature/phase4-conversational-editing
npm ci
npx playwright install chromium
PHASE4_HOSTED_VIDEO="$HOME/Downloads/Ahmed Perfumes Testing.mp4" npm run test:hosted-phase4
```

The suite only connects to `https://cliponaut.com`. A visible browser opens at
`/founder-test`; enter the founder access code there once. Do not put that code
in the command line, an environment variable, a file, a report, or chat. Once
the browser reaches Cliponaut, the suite completes the remaining prompts
without further human input.

To choose where the sanitized result is written:

```bash
PHASE4_HOSTED_VIDEO="$HOME/Downloads/Ahmed Perfumes Testing.mp4" \
PHASE4_HOSTED_REPORT_PATH="$HOME/Desktop/cliponaut-hosted-phase4-report.json" \
npm run test:hosted-phase4
```

Before another hosted render, compare the already retained review MP4s locally:

```bash
PHASE4_HOSTED_REVIEW_DIR="$HOME/Desktop/cliponaut-phase4-review" \
PHASE4_HOSTED_MEDIA_REPORT_PATH="$HOME/Desktop/cliponaut-hosted-phase4-media-report.json" \
npm run test:hosted-phase4-media
```

This command makes no network request and creates no render. It checks the
same local MP4s in Playwright's bundled Chromium and installed stable Google
Chrome through a temporary loopback MP4 server with `video/mp4` MIME and byte
range support, avoiding macOS `file://` restrictions. Stable Chrome runs headed
by default; set `PHASE4_HOSTED_MEDIA_HEADED=0` only for unattended local runs.
Its report separates browser launch, navigation, local HTTP/range, metadata,
initial playback, and seek/resumed-playback failures without recording private
paths. The hosted suite defaults to `channel: "chrome"`; use
`PHASE4_HOSTED_BROWSER=chromium` only to reproduce a bundled-browser issue.

For the no-network final remaining-gates regression set (conversation state,
history presentation, Undo UI, failure recovery, founder access gate, and the
normal-runner FFmpeg preflight), run:

```bash
npm run test:phase4-final-offline
```

When a normal Mac with stable Google Chrome is available, this separate
read-only check verifies the deployed ordinary desktop/mobile shell and that
the founder gate is not present on the ordinary page. It does not authenticate,
upload, submit a prompt, create a job, download media, or render video:

```bash
PHASE4_HOSTED_READONLY=1 \
PHASE4_HOSTED_READONLY_REPORT_PATH="$HOME/Desktop/cliponaut-phase4-readonly-report.json" \
npm run test:hosted-phase4-readonly
```

It cannot inspect a prior private editing session or its preview: those require
that session's private, non-persisted browser credential. It is therefore a
gate/layout check, not a substitute for authenticated hosted preview testing.

## Minimal cinematic → normal verification

After the Ahmed journey has already reached the cinematic turn, use this
separate bounded check for the remaining normal-restoration gate. It uses the
tracked small `public/demo.mp4` fixture (not the Ahmed source), opens stable
Google Chrome, and performs four small renders: black-and-white seed,
output-relative five-second trim, cinematic replacement, and normal
restoration. It validates the downloaded MP4 containers and compares decoded
opening/ending video and audio against the original at the expected five-second
offset. The report contains no URLs, credentials, cookies, identifiers, or
local paths; downloaded outputs are retained only in the explicitly supplied
local review directory.

```bash
PHASE4_HOSTED_NORMAL_VERIFY=1 \
PHASE4_HOSTED_NORMAL_REVIEW_DIR="$HOME/Library/Application Support/Cliponaut/phase4-normal-review" \
PHASE4_HOSTED_NORMAL_REPORT_PATH="$HOME/Desktop/cliponaut-phase4-normal-report.json" \
npm run test:hosted-phase4-normal
```

The command is skipped unless `PHASE4_HOSTED_NORMAL_VERIFY=1` is set, avoiding
an accidental hosted render in ordinary test runs. The review directory is
required for enabled hosted checks and must be outside the repository. Every
downloaded MP4 is written there as it completes, so it remains available for
offline analysis if a later assertion fails. It contains media only—never
credentials, cookies, session identifiers, or signed URLs—and must not be
committed. Before the browser or any hosted request opens, the runner extracts
and compares local fixture audio with FFmpeg; a failed preflight prevents all
renders. Set `PHASE4_HOSTED_NORMAL_VIDEO` only to use another small local
fixture.

To retain the five final-state review MP4s locally (selection, trim,
black-and-white, cinematic, and normal), add a folder you control:

```bash
PHASE4_HOSTED_VIDEO="$HOME/Downloads/Ahmed Perfumes Testing.mp4" \
PHASE4_HOSTED_REVIEW_DIR="$HOME/Desktop/cliponaut-phase4-review" \
PHASE4_HOSTED_REPORT_PATH="$HOME/Desktop/cliponaut-hosted-phase4-report.json" \
npm run test:hosted-phase4
```

The report contains only check names, pass/fail/not-verified states, durations,
and codecs. It never records access codes, cookies, session IDs, signed URLs,
or local media paths. Downloaded MP4s are held in a temporary directory for
FFprobe/FFmpeg validation and deleted at completion unless
`PHASE4_HOSTED_REVIEW_DIR` is set. In that case, only the five named review
outputs remain in the supplied local folder; the Undo-only verification output
is still deleted.

The report also contains sanitized preview diagnostics: HTML media ready/network
state, media error code, observed metadata/error/stalled events, and only the
signed-media hostname, HTTP status, and MIME type. A valid downloadable MP4
does not mark a failed browser preview as passing; preview failures are recorded
separately and the suite continues with the remaining safe checks.

## Coverage

The runner uses the real Ahmed video to exercise upload, spoken-selection
prompt, output-relative trim, black-and-white, cinematic replacement, normal
reset, history refresh, Undo, safe unsupported-instruction recovery, signed
download, and desktop/mobile layout. It validates downloaded MP4 containers,
audio/video streams and durations. Trim validation compares decoded video and
audio from the trimmed opening with the previous output at the calculated
five-second offset, and separately compares their retained endings. This
detects an end trim, a trim applied to the wrong source point, and audio/video
timing drift rather than merely checking that one frame changed.

Automated media inspection cannot judge whether the selected words and creative
look are subjectively correct. The report deliberately marks that semantic and
creative assessment `NOT VERIFIED` for the founder's final review.
