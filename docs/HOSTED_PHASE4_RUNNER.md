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

The report contains only check names, pass/fail/not-verified states, durations,
and codecs. It never records access codes, cookies, session IDs, signed URLs,
or local media paths. Downloaded MP4s are held in a temporary directory for
FFprobe/FFmpeg validation and deleted at completion.

## Coverage

The runner uses the real Ahmed video to exercise upload, spoken-selection
prompt, output-relative trim, black-and-white, cinematic replacement, normal
reset, history refresh, Undo, safe unsupported-instruction recovery, signed
download, and desktop/mobile layout. It validates downloaded MP4 containers,
audio/video streams, durations, and that the trim begins on a different frame.

Automated media inspection cannot judge whether the selected words and creative
look are subjectively correct. The report deliberately marks that semantic and
creative assessment `NOT VERIFIED` for the founder's final review.
