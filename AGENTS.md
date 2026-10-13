# Cliponaut Agent Guide

## Read First

Before substantial engineering work, read:

1. `CLIPONAUT_ENGINEERING.md`
2. `PHASES.md`
3. `PRODUCTION_TESTS.md`

These documents are the current architecture, roadmap, and production-evidence sources of truth.

## Product and Architecture

Cliponaut is a natural-language video editor: users edit video by describing intent rather than operating a timeline.

The production path is:

Browser / Next.js UI
→ direct private multipart upload
→ object storage
→ durable PostgreSQL edit job
→ Railway worker
→ ffprobe/media validation
→ Gemini understanding/planning where required
→ strict server validation
→ deterministic FFmpeg execution
→ private output storage
→ signed result URL
→ browser

The browser does not keep an edit alive. Once queued, durable job processing continues independently of the browser session.

## Current Constraints

- Support up to five ordered video sources.
- Stable `source-1` through `source-5` IDs are authoritative; filenames are descriptive only.
- Preserve V1 behavior while extending V2 source-aware plans.
- AI interprets. Server validates. FFmpeg executes.
- Semantic uncertainty must reject safely; never silently choose a source or moment.
- Preserve durable job, recovery, cancellation, and cleanup behavior.
- Worker concurrency is intentionally `1`. Never hide queue or process-lifecycle bugs by blindly increasing it.
- Keep storage private. Do not expose signed URLs, access tokens, Gemini file URIs, object keys, credentials, or secrets in logs or browser-visible output.

## Repository Map

- `src/app/page.js` — main Cliponaut client workspace, recovery, and browser-local Single-Step Undo presentation.
- `src/app/api/uploads/` — upload-session, multipart part-signing, completion, and abort APIs.
- `src/app/api/jobs/` — job status and cancellation APIs.
- `src/lib/client/direct-upload.js` — browser direct-upload and local Undo state helpers.
- `src/lib/jobs/` — job configuration, PostgreSQL store, storage client, and HTTP validation.
- `src/lib/media/` — server-authoritative media configuration and probing.
- `src/lib/editor-core/` — edit plans, AI planner, validation, transcription, captions, titles, visual/audio controls, and deterministic FFmpeg execution.
- `scripts/cliponaut-worker.js` — durable queue worker.
- `scripts/migrate-jobs.js` — edit-job schema initialization.
- `tests/jobs.test.js` — focused automated regression suite.
- `Dockerfile` — production image with Node, FFmpeg/ffprobe, and rendering dependencies.

## Workflow

`main` is the production source-of-truth branch. Current practice uses reviewed, tested commits pushed directly to `main`; do not invent a `develop`-branch requirement.

For implementation work:

1. Inspect the current code and preserve production-proven behavior.
2. Keep the change narrowly scoped; do not introduce new infrastructure without an approved need.
3. Run relevant focused checks plus `npm run test:jobs`, `npm run lint`, and `npm run build` where applicable.
4. Do not declare a phase complete on lint alone: production acceptance is required.

Useful commands:

```bash
npm run dev
npm run test:jobs
npm run lint
npm run build
npm run worker
npm run migrate:jobs
```

Full local media processing needs system `ffmpeg`, `ffprobe`, and the required server-side environment configuration. Never commit environment values or production credentials.

## Single-Step Undo

Single-Step Undo is browser-local Current/Previous successful state, not database-backed history. It has no redo, branching, or version tree. Historical job restoration requires that job's opaque access token; Original is an output-less source sentinel. Failed/cancelled jobs do not advance successful state.

The undo presentation must cover outgoing media until the restored media is displayable. Do not reintroduce stale-video flashes or generic job-status messaging during Undo restoration.

## Current Next Product Work

Phase 3C remains in progress. The next planned sub-phase is **Phase 3C-B — Filters & Reference Styling**. It is not implemented or started by this document.

## Safety

Do not push, deploy, modify Railway, alter migrations, change worker concurrency, delete storage, or rotate secrets without explicit user authorization. Avoid destructive commands and preserve unrelated working-tree changes.
