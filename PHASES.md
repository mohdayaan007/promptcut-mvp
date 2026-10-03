# Cliponaut Development Phases

This file is the current roadmap and implementation-status source of truth for Cliponaut.

Before substantial engineering work, read:

1. `CLIPONAUT_ENGINEERING.md`
2. `PHASES.md`
3. `PRODUCTION_TESTS.md`

Do not mark a phase complete merely because code exists.

A phase should normally be considered complete only when:

- implementation is finished
- relevant automated tests pass
- production build passes in an approved environment
- required production deployment succeeds
- relevant production acceptance tests pass
- known blocking regressions are resolved

---

# Status Legend

`✅ COMPLETE`  
Implementation and relevant production verification are complete.

`🧪 PRODUCTION VERIFICATION`  
Implementation exists, but production acceptance testing is still ongoing.

`🚧 IN PROGRESS`  
The phase is actively being implemented or debugged.

`⏳ PLANNED`  
The phase is planned but not yet active.

---

# Phase 3A — Core Natural-Language Video Editing

Status: `✅ COMPLETE`

Cliponaut supports the core natural-language editing pipeline:

User prompt
→ editing plan
→ validation
→ FFmpeg execution
→ rendered output

Production-proven capabilities include core operations such as:

- trim
- text/title
- color grading
- black and white
- zoom
- speed
- fades
- crop
- basic merging

The existing V1 edit-plan behavior remains the backwards-compatible foundation for normal single-video editing.

Important rule:

Do not break established V1 behavior while adding newer source-aware functionality.

---

# Phase 3A.5A — Large-Media / Production Processing Foundation

Status: `✅ COMPLETE`

Purpose:

Move Cliponaut beyond fragile browser-bound processing and prepare the product for larger real-world media.

Key production architecture established:

- private object storage
- direct media uploads
- Railway processing infrastructure
- media probing
- FFmpeg server-side execution
- Standard / 4K-aware processing foundation
- durable source metadata

This architecture remains active and should be reused rather than replaced.

---

# Phase 3A.5A+ — Durable Background Jobs

Status: `✅ COMPLETE`

Purpose:

Make edits independent of the user's browser session.

Production behavior:

- edits survive browser refresh
- edits survive closing the tab
- edits survive closing the browser
- edits survive the user's computer being switched off
- Railway worker continues processing independently
- completed jobs can be restored later

Durable edit states include:

- uploading
- queued
- analyzing
- rendering
- completed
- failed
- cancelled

PostgreSQL is the durable source of truth for job state.

Production tests confirmed durable processing with both one-video and multi-video jobs.

---

# Phase 3A.5A+ Recovery — Continue / Start Fresh

Status: `✅ COMPLETE`

Purpose:

Give the user control when Cliponaut discovers an edit from a previous page/session.

Active recovered job:

> You have an edit in progress.  
> What would you like to do?

Actions:

- Continue
- Start fresh

Completed recovered job:

> Your edit is ready.

Actions:

- View edit
- Start fresh

Production-verified behavior:

- Continue reconnects to the same durable job
- source cards restore in original order
- no duplicate job is created
- View edit restores completed output
- Start fresh clears the local workspace
- active Start fresh creates a durable cancellation
- completed Start fresh does not retroactively cancel the historical job
- one-video recovery works
- two-video recovery works

---

# Durable Job Cancellation

Status: `✅ COMPLETE`

A proper `cancelled` terminal job state exists.

Cancellation behavior includes:

- token-protected cancellation endpoint
- atomic status transition
- idempotent repeated cancellation
- terminal-state protection
- worker cancellation checkpoints
- normal source-retention cleanup
- cancelled jobs cannot later become completed

Production database status has been verified after Start fresh.

---

# FFmpeg Active Cancellation / Worker Queue Protection

Status: `✅ COMPLETE`

Production issue discovered:

A cancelled job could already be inside a long-running FFmpeg process.

The database correctly changed to `cancelled`, but FFmpeg could continue running.

Because worker concurrency is currently `1`, the lingering FFmpeg process could occupy the only worker slot and leave later jobs stuck in `queued`.

Production evidence included a cancelled job whose FFmpeg process continued for an extended period.

Fix implemented and deployed:

- each execution owns its own subprocess controller
- FFmpeg/FFprobe child process is tracked per execution
- worker polls durable cancellation state while rendering
- cancellation sends `SIGTERM` to only that job's child process
- bounded grace period is used
- `SIGKILL` is available for the same child if graceful shutdown fails
- broad `pkill` / `killall` is never used
- cancellation is treated as expected cancellation, not job failure
- existing post-render cancellation checks remain in place

Automated verification:

- 24/24 job tests passed at implementation time
- real FFmpeg regression render passed
- local production build passed

Production verification:

A render was cancelled during Rendering using Start fresh.

A subsequent job was then picked up instead of remaining blocked indefinitely.

The previous worker-slot blockage issue is considered resolved.

---

# Phase 3A.5B-A — Source-Aware Multi-Video Editing

Status: `✅ COMPLETE`

Purpose:

Allow Cliponaut to explicitly address individual uploaded videos rather than treating all inputs as one anonymous merged timeline.

Stable source IDs introduced:

- source-1
- source-2
- source-3
- source-4
- source-5

These map deterministically to stored source indices.

A V2 source-aware plan was introduced.

Core V2 concept:

```json
{
  "version": "2",
  "operations": [
    {
      "type": "sequence",
      "clips": [
        {
          "sourceId": "source-2",
          "start": 0,
          "end": 5
        },
        {
          "sourceId": "source-1",
          "start": 0,
          "end": 5
        }
      ]
    }
  ]
}
