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

Status: `✅ COMPLETE`

Purpose:

Allow Gemini to understand the visible contents of every uploaded video and map natural semantic descriptions to the existing stable source IDs.

This enables prompts such as:

> Start with the video where I'm talking, then show the greenery footage.

instead of requiring:

> Use video 2, then video 1.

---

## Implementation

Gemini receives source videos through the Gemini Files API for 1–5 source jobs.

Each source is paired with an explicit label containing information such as:

- sourceId
- ordinal
- filename
- duration
- dimensions

Stable `sourceId` remains authoritative.

Semantic source references are classified independently per source. The server aggregates the resulting plausible matches and proceeds only when each semantic reference resolves to exactly one source. Ambiguous or unmatched descriptions reject safely rather than selecting an arbitrary source.

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

## Completed Production Verification

Production acceptance testing verified:

- natural-content semantic identification, including Homestay → Greenery and Talking → Greenery
- mixed explicit plus semantic sequencing: `Use video 2 first, then the greenery clip.`
- three-source semantic ordering: Road → Talking/Indoor → Greenery
- ambiguity-safe rejection when two sources plausibly match `Use the greenery video.`
- unique semantic selection: Talking → Greenery
- global multi-video black and white using one unscoped color grade
- source-specific black and white for `only video 2`
- V1 single-video black-and-white regression coverage
- controlled five-source explicit ordering, with all sources retained in the requested order

Historical production prompts that demonstrated natural-content ordering include:

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

## Resolved Production History

The former global multi-video black-and-white planner regression is resolved. Both/all-source requests now use one global unscoped `color_grade`; an `only video 2` request uses one source-specific `color_grade`. Validator constraints remain unchanged.

An apparent unique-semantic-selection regression was diagnosed as Gemini free-tier `429 RESOURCE_EXHAUSTED` quota exhaustion, not a classification regression. Once quota was available, the same Talking → Greenery production acceptance test passed.

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

# Phase 3A.5C — Semantic Moment Selection

Status: `🚧 IN PROGRESS`

Purpose:

Move Cliponaut from understanding WHICH uploaded source the user means to also understanding WHERE INSIDE uploaded footage a visually or semantically described moment occurs.

## Phase 3A.5C-A — Visual Moment Selection

Status: `✅ COMPLETE`

Given uploaded source video(s) and a visually observable event or state, Cliponaut identifies the correct source-local range and executes it through the existing V2 sequence pipeline. Production acceptance scenarios A–M passed.

Representative prompts include:

- `Use the part where the car enters the frame.`
- `Start when the house appears.`
- `End when the person sits on the chair.`
- `Start when the person walks inside the home and end when he sits on the chair.`
- `From video 2, use the part where the camera pans toward the building.`
- `From the greenery clip, use the part where the person walks into frame.`

These examples describe structural intent, not a fixed keyword list.

### Moment Modes

- `EVENT_SEGMENT`: use/show/keep/trim to the bounded segment where an event occurs.
- `START_BOUNDARY`: localized event start through the natural end of the selected source.
- `END_BOUNDARY`: source start through the localized event end.
- `START_END_BOUNDARY`: localized start event through localized end event; the server requires `end > start`.

For paired boundaries, localization returns plausible paired ranges rather than combining unrelated timestamps.

### Source Scope and Candidate Safety

- One source: search `source-1`.
- Explicit source: search only that authoritative source.
- Semantic source: first resolve it through Phase 3A.5B-B, then search only the resolved source.
- Multiple sources with no source scope: search every source independently for the same objective visual event.

For every requested moment, the server aggregates candidates across all in-scope sources:

- 0 candidates: safe no-match rejection.
- Exactly 1 candidate: proceed with its authoritative source and range.
- 2 or more candidates: safe ambiguity rejection.

Cliponaut must not choose the first source, earliest timestamp, upload order, or a creatively "best" match. Cross-source search for the same objective event is in scope; cross-source ranking is not.

The server remains authoritative over the final `sourceId`, `start`, and `end`. It reuses existing V2 sequence execution; no new FFmpeg engine, database schema, Railway service, storage architecture, or durable-job system was introduced.

### Intended Architecture

`prompt structural extraction → source-scope strategy → source resolution when scoped → independent visual moment localization → server candidate validation and aggregation → server-authoritative V2 sequence range → existing planning for remaining operations → validator → executor → FFmpeg`

Moment localization uses dedicated structured Gemini calls before final planning. It is an intermediate response, not a new edit-plan or FFmpeg operation. The final planner must not change the resolved source, range, or order; the server preserves/restores the authoritative localized sequence before final validation and execution.

The existing V2 sequence representation, validator, and executor can support a one-source V2 sequence. Localized one-source requests should canonicalize into V2 rather than being forced into V1 trim semantics.

### Gemini Files and Request Discipline

Within one job, each source is uploaded and activated once, then reused for semantic source classification when needed, visual moment localization, and final planning. Existing finally-path cleanup remains responsible for deleting temporary Gemini files.

For an unscoped multi-source request, each already-active source file receives an independent localization call; Gemini is not asked to compare sources or select a winner.

Engineering request-count observations, excluding upload/activation polling and retries:

- one source plus visual moment: about 2 generate calls
- two sources plus explicit source: about 2 generate calls
- two sources plus semantic source: about 4 generate calls
- two unscoped sources: about 3 generate calls
- three unscoped sources: about 4 generate calls
- five unscoped sources: about 6 generate calls

Retries can increase these counts within existing bounded retry behavior. Production testing should use short, obvious clips and focused scenarios; broad coverage belongs in mocked automated tests.

### Validation and Out of Scope

Moment localization rejects safely for malformed or incomplete structured responses; wrong, unknown, duplicate, or missing source/moment identifiers; invalid candidate cardinality; non-numeric/non-finite/negative timestamps; `end <= start`; and ranges beyond the authoritative source duration. Unscoped searches must return one valid response for every source the server expected to search.

Phase 3A.5C-A does not include speech/transcript selection, best-moment or highlight ranking, automatic reels, autonomous pacing, music sync, B-roll, embeddings/vector databases, full autonomous timeline reasoning, or multi-moment composition.

For controlled short and unambiguous clips, approximately ±2 seconds is an initial human production-testing tolerance for annotated visual boundaries. It is not a permanent universal guarantee and should be adjusted only after observing real localization behavior.

### Implementation and Production Fixes

- `68fa931` — Add visual moment selection
- `9626561` — Tighten visual moment matching

The targeted production fix strengthened the Gemini localization contract: the full requested visual meaning must match. For example, `person walks through the temple` must not match a person walking through a generic forest or path merely because the action is similar. All essential visible subject, object, action, setting, direction, relationship, and state constraints must jointly match. The server-side candidate aggregation safety rule was not weakened.

## Phase 3A.5C-B — Spoken Moment Selection

Status: `⏳ PLANNED`

Purpose:

Speech/transcript-aware moment selection, such as `Start when I say “Welcome to Kerala”.` or `Use the part where I explain pricing.`

## Phase 3A.5C-C — Multi-Moment Composition

Status: `⏳ PLANNED`

Purpose:

Combine multiple independently described semantic moments into one ordered edit, such as showing food being prepared, then served, then tasted.

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
