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
```

Production-verified capabilities:

- reorder two videos
- reorder three videos
- source-local trim ranges
- source-specific black-and-white / color grade
- repeated source addressing architecture
- invalid ranges rejected safely
- invalid source references rejected safely
- V1 single-video behavior remains functional

Example production prompts that worked:

> Put the second video first, then the first.

> Use the first 3 seconds of video 1, followed by the first 3 seconds of video 2.

> Make only video 2 black and white.

> Use video 3, then video 1, then video 2.

Important limitation:

Only explicitly supported operations should be source-scoped.

Do not assume title, zoom, speed, crop, fade, or other operations are source-scoped unless intentionally implemented and tested.

---

# Phase 3A.5B-B — Multi-Source Visual Understanding

Status: `🧪 PRODUCTION VERIFICATION`

Purpose:

Allow Gemini to understand the visible contents of every uploaded video and map natural semantic descriptions to the existing stable source IDs.

This enables prompts such as:

> Start with the video where I'm talking, then show the greenery footage.

instead of requiring:

> Use video 2, then video 1.

---

## Implementation

Gemini now receives all available source videos visually for 1–5 source jobs through the Gemini Files API.

Each source is paired with an explicit label containing information such as:

- sourceId
- ordinal
- filename
- duration
- dimensions

Stable `sourceId` remains authoritative.

The existing V2 plan schema, validator, and executor remain the execution foundation.

No new database, Railway, object-storage, recovery, or cancellation architecture was introduced for visual source understanding.

---

## Semantic Source Behavior

Gemini may resolve descriptions such as:

- talking clip
- greenery footage
- road footage
- indoor clip
- video showing a house

to stable source IDs.

Explicit references such as:

- video 1
- video 2
- source-1
- source-2

remain authoritative.

Mixed prompts are intended to support combinations such as:

> Use video 2 first, then the greenery clip.

---

## Gemini Retry Behavior

Transient Gemini planning errors now support bounded retries for conditions such as:

- 429
- 503
- relevant 5xx errors

Uploaded Gemini file references are reused during planning retries rather than re-uploading every source.

Temporary Gemini-side uploads are deleted best-effort afterward.

---

## Safe Semantic Fallback

Explicit source commands may use deterministic fallback when Gemini is unavailable.

Example:

> Use video 2, then video 1.

Semantic requests must not be guessed without visual understanding.

Example:

> Use the beach clip first.

If Gemini cannot perform the semantic mapping:

- do not guess
- do not silently use upload order
- do not execute only part of a mixed prompt
- return a safe unsupported/failure result

---

## Production Bug Found and Fixed

Initial semantic production test failed with:

`This edit needs Gemini video understanding`

Root cause:

`sourceLabel()` referenced an undefined `source` variable while constructing multi-source Gemini labels.

Fix:

Use the already-destructured source fields directly.

The semantic planner fix was deployed.

Automated verification after the fix:

- 20/20 job tests passed
- local production build passed

---

## Production Semantic Tests Passed

The following natural-content tests successfully produced the correct ordering:

> Put the homestay video first, then the greenery video.

Result:

Homestay → Greenery

Stronger visual-content tests:

> Start with the video where I'm talking, then show the greenery footage.

Result:

Talking video → Greenery

> Use the talking clip first, then the outdoor nature footage.

Result:

Talking video → Greenery

These tests provide production evidence that Gemini can visually distinguish different uploaded sources and map semantic descriptions to the correct V2 source IDs.

---

# Current Active Issue — Global Multi-Video Color Grade Planning

Status: `🚧 IN PROGRESS`

Production prompt:

> Make both videos black and white.

failed with:

`Invalid edit plan: only one color_grade operation is allowed`

Observed planner behavior likely generated multiple source-scoped color-grade operations.

Current validator deliberately allows only one color-grade operation.

Desired behavior:

Source-specific request:

> Make only video 2 black and white.

should produce one source-scoped color grade:

```json
{
  "type": "color_grade",
  "sourceId": "source-2",
  "style": "bw"
}
```

All-source request:

> Make both videos black and white.

or:

> Make all videos black and white.

should produce one global unscoped color grade:

```json
{
  "type": "color_grade",
  "style": "bw"
}
```

The intended fix should be planner-focused.

Do not loosen the validator to allow arbitrary duplicate `color_grade` operations unless a future product requirement genuinely requires that.

This issue should be fixed and regression-tested before declaring Phase 3A.5B-B complete.

---

# Remaining Phase 3A.5B-B Production Verification

Before Phase 3A.5B-B is marked complete, verify at minimum:

Mixed explicit + semantic source selection:

> Use video 2 first, then the greenery clip.

Expected:

Explicit source-2 followed by the visually identified greenery source.

Three-source semantic ordering:

Example source set:

- greenery
- indoor/talking
- road/driving

Prompt:

> Start with the road footage, then the indoor clip, then the greenery.

Expected:

Road → Indoor → Greenery

Ambiguity behavior:

Use two visually similar source videos.

Prompt:

> Use the greenery video.

Cliponaut should not silently choose one arbitrarily if the semantic description is genuinely ambiguous.

Global multi-video color:

> Make both videos black and white.

Expected:

Both videos appear in the intended assembled output with one global black-and-white operation.

One-source regression:

Existing single-video edits must continue to work.

Five-source sanity:

Confirm the visual planner can accept the supported maximum source count in a controlled production test, subject to Gemini production account/file-size limits.

---

# Known Phase 3A.5B-B Constraints

Current implementation intentionally does NOT yet include:

- automatic best-moment selection
- autonomous highlight selection
- shot detection
- embeddings
- vector databases
- semantic clip ranking
- automatic reel creation
- autonomous creative pacing
- full timeline reasoning across arbitrary scenes

These belong to later product phases.

Full-source Gemini visual analysis may also have practical:

- file-size
- latency
- token
- quota
- cost

constraints.

These should be measured in production rather than guessed.

---

# Render Timeout

Status: `⏳ PLANNED / OPERATIONAL FOLLOW-UP`

There is currently no generic hard render timeout.

The recent worker blockage was solved through active cancellation of the job-specific FFmpeg subprocess.

A hardcoded render timeout was intentionally not added because valid long 4K jobs may legitimately require substantial processing time.

If a render deadline is added later, it should be:

- configurable
- based on measured production behavior
- designed not to terminate legitimate long jobs arbitrarily

This is not currently a blocker for Phase 3A.5B-B.

---

# Worker Concurrency

Current worker concurrency remains intentionally limited.

Do not increase concurrency merely to make queues appear faster.

Before changing concurrency, consider:

- Railway CPU
- Railway memory
- FFmpeg CPU load
- simultaneous Gemini usage
- object-storage bandwidth
- cost
- worker isolation
- queue fairness

Concurrency is a capacity/scaling decision, not a substitute for fixing hanging jobs.

---

# Next Immediate Engineering Task

Fix the global multi-video color-grade planner behavior.

Target prompts:

> Make both videos black and white.

> Make all videos black and white.

Expected behavior:

one global unscoped `color_grade` operation.

Preserve:

- `Make only video 2 black and white.` source-specific behavior
- V1 compatibility
- V2 sequencing
- current validator constraints
- current executor architecture

After implementation:

- add regression tests
- run `git diff --check`
- run lint
- run job tests
- run production build
- deploy only after approval
- production-test both global and source-specific color behavior

---

# After Phase 3A.5B-B

Once all Phase 3A.5B-B acceptance tests pass, mark:

`Phase 3A.5B-B — ✅ COMPLETE`

Only then move to the next major product phase.

The next major phase is expected to move beyond basic multi-source identification toward broader Cliponaut editing capabilities.

Do not invent the detailed scope of later phases inside an engineering task.

Later-phase scope should be defined by the product owner before implementation begins.

---

# Phase Completion Rule

Agents must not mark a phase complete simply because:

- code compiles
- unit tests pass
- one happy-path production prompt succeeds

Phase completion requires the documented acceptance criteria for that phase to pass.

If production testing exposes another bug:

1. capture evidence
2. identify the failing layer
3. fix the smallest root cause
4. add regression coverage
5. retest
6. continue until acceptance criteria are satisfied

Do not redefine expected product behavior merely to make a failing test pass.
