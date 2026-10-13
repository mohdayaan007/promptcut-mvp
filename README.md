# Cliponaut

Cliponaut is a natural-language video editor: edit video by meaning, not by timeline.

Upload footage, describe the edit in plain English, and Cliponaut plans, validates, renders, and returns an edited MP4.

## Current capabilities

- 1–5 video sources with source-aware sequencing and semantic selection safety
- structural, visual, spoken, and multi-moment selection
- color looks, titles, captions/subtitle correction, and basic audio controls
- bounded visual adjustments and single-step browser-local Undo
- Standard and eligible genuine 4K exports
- durable background jobs, recovery, cancellation, and signed private result retrieval

## Architecture

Browser direct multipart upload → private object storage → PostgreSQL edit job → Railway worker → media validation, Gemini planning where required, strict plan validation, deterministic FFmpeg → private output storage → signed result URL.

## Local commands

```bash
npm run dev
npm run test:jobs
npm run lint
npm run build
npm run worker
```

Full local media processing needs system `ffmpeg`, `ffprobe`, and the required server-side environment configuration. This README is not a complete deployment runbook and must not contain credentials or production secrets.

## Contributor references

Read these before substantial work:

- `CLIPONAUT_ENGINEERING.md`
- `PHASES.md`
- `PRODUCTION_TESTS.md`
- `AGENTS.md`
