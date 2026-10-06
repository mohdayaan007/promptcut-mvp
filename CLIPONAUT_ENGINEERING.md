# Cliponaut Engineering Guide

## 1. What Cliponaut Is

Cliponaut is a natural-language video editor.

The core product promise is:

> Upload your footage, describe the edit in plain English, and Cliponaut produces the edited video.

The long-term vision is closer to "ChatGPT for video editing" than a traditional timeline editor.

Users should increasingly be able to say things like:

- "Make this video black and white."
- "Trim the first 5 seconds."
- "Add the title 'A Day in Kerala' at 0:05."
- "Put video 2 before video 1."
- "Use the talking clip first, then the greenery footage."
- Eventually: "Take these clips and make me a great 30-second reel."

Cliponaut should hide unnecessary editing complexity while maintaining predictable, professional output.

---

# 2. Engineering Priorities

When making engineering decisions, prioritize in this order:

1. Correctness
2. Reliability
3. User control
4. Safe failure behavior
5. Output quality
6. Performance
7. Implementation simplicity
8. New capability

Do not sacrifice existing reliable behavior merely to add a new feature.

A feature is not considered complete simply because the happy path works.

---

# 3. Current High-Level Architecture

Cliponaut consists of:

Browser / Next.js UI
→ direct media upload
→ private object storage
→ durable job record in PostgreSQL
→ Railway background worker
→ Gemini editing planner
→ validated edit plan
→ FFmpeg execution
→ output storage
→ signed result URL
→ user

The browser is not responsible for keeping an edit alive.

Once a durable edit job has been created, server-side processing is independent of the browser session.

---

# 4. Main Production Components

## Web Service

Railway service:

`promptcut-mvp`

Production URL:

`https://cliponaut.com`

Responsibilities include:

- frontend
- upload initiation
- job-status APIs
- recovery state
- cancellation API
- result presentation

---

## Background Worker

Railway service:

`cliponaut-worker`

Responsibilities include:

- claiming queued edit jobs
- downloading uploaded media
- probing source media
- asking Gemini to create an edit plan
- validating plans
- executing FFmpeg operations
- uploading final outputs
- updating durable job state
- responding to cancellation

Current worker concurrency is deliberately limited.

Do not increase concurrency simply to hide worker/process bugs.

---

## PostgreSQL

Used for durable edit-job state.

The database is the source of truth for job status.

Relevant statuses include:

- uploading
- queued
- analyzing
- rendering
- completed
- failed
- cancelled

`cancelled` is a terminal state.

A cancelled job must never later transition to completed or failed because an old worker operation finished.

---

## Object Storage

Cliponaut uses private object storage for source media and rendered outputs.

Source and output objects are not publicly exposed directly.

The application uses controlled/signed access where required.

Do not leak:

- bucket credentials
- storage object keys
- signed URLs unnecessarily
- Gemini file URIs
- job access tokens

into logs, browser-visible responses, or committed files.

---

# 5. Durable Job Model

Cliponaut uses durable background jobs.

This is intentional and must be preserved.

Once an upload is accepted and a job is queued:

- refreshing the page must not restart the edit
- closing the tab must not cancel the edit
- closing the browser must not cancel the edit
- switching off the user's device must not cancel the edit
- the worker continues independently

When the user returns, Cliponaut checks for the existing job.

---

# 6. Recovery UX

When Cliponaut discovers an existing active job from a previous browser session, it shows:

> You have an edit in progress.  
> What would you like to do?

Actions:

- Continue
- Start fresh

## Continue

Continue must:

- reconnect to the existing job
- preserve the same job ID
- restore uploaded source cards
- preserve source order
- show current progress
- never create a duplicate job
- never restart processing

## Start Fresh

For an active job:

- request cancellation
- wait for safe cancellation handling
- clear the browser workspace
- remove restored source cards
- remove stale prompt/messages/result state
- return to the clean upload experience

For a completed job:

- do not cancel the historical completed job
- clear the local workspace only

---

# 7. Job Cancellation

Cancellation is durable and server-side.

Active jobs may transition to:

`cancelled`

Cancellation must be:

- authenticated using the existing opaque job access mechanism
- atomic
- idempotent
- safe during worker races

The worker checks cancellation at major execution boundaries.

---

# 8. FFmpeg Cancellation

FFmpeg processes must be tied to the execution that spawned them.

A cancelled render must not be allowed to occupy the worker indefinitely.

Current behavior:

- each edit execution owns its FFmpeg/FFprobe subprocess controller
- worker polls durable cancellation state while rendering
- cancellation sends `SIGTERM` to the specific child process
- after a bounded grace period, `SIGKILL` may be sent to that same child
- broad `pkill` or `killall` must never be used
- cancellation should be treated as expected cancellation, not render failure

A cancelled FFmpeg operation must not later cause the job to become completed.

Do not remove the existing post-render cancellation checkpoints merely because active interruption exists.

---

# 9. Source Media Model

Cliponaut supports multiple uploaded video sources.

Sources are stored as an ordered array.

Each durable source includes information such as:

- original index
- filename
- MIME type
- byte size
- private storage key

Source ordering must be preserved throughout:

upload
→ database
→ worker
→ Gemini planning
→ validation
→ execution
→ restored UI

---

# 10. Source IDs

For source-aware editing, Cliponaut exposes stable human-facing IDs:

- source-1
- source-2
- source-3
- source-4
- source-5

These map deterministically to stored zero-based source indices.

Example:

`source-1` → stored index `0`

`source-2` → stored index `1`

Filenames are descriptive metadata.

Filenames must not be treated as authoritative source identifiers.

## Spoken Moment Selection

Spoken-moment selection is a production-established routing path separate from visual moment selection. It supports quoted exact speech and semantic spoken topics/sections. Source scope is resolved first (single, explicit, semantic, or independently across unscoped sources), then selection occurs before final edit-plan execution.

The flow is:

source scope
→ temporary FFmpeg audio extraction
→ Gemini timestamped transcription
→ canonical server-owned transcript with stable segment IDs
→ deterministic exact quoted-speech matching or Gemini semantic transcript matching
→ server candidate validation and aggregation
→ authoritative sourceId/start/end
→ final planner for remaining supported operations
→ existing V2 validator/executor/FFmpeg pipeline

Exact speech uses conservative deterministic normalization and matching. Semantic speech gives Gemini canonical transcript segment text only; Gemini returns segment IDs, not authoritative timestamps. The server validates candidates and derives timestamps from the canonical transcript.

Candidate cardinality is strict: 0 means safe no-match, 1 proceeds, and 2 or more means safe ambiguity rejection. Repeated phrases remain genuinely ambiguous. Cliponaut must never rank sources/candidates or silently guess.

The final planner cannot override the authoritative spoken `sourceId`, `start`, or `end`; normal supported operations may still be layered onto that range. AI interprets. Server validates. FFmpeg executes.

Temporary audio and Gemini files are cleaned up best-effort. Transcription and semantic requests use bounded retries for transient failures, and job-scoped cancellation remains expected cancellation rather than ordinary failure. Long-media transcription and performance characteristics still require separate realistic-media measurement.

---

# 11. Edit Plan Versions

Cliponaut currently supports two important plan behaviors.

## Version 1

V1 preserves legacy behavior.

Typical characteristics:

- single-video editing
- traditional global operations
- multi-video automatic merge in upload order
- operations generally apply to the resulting timeline

Existing V1 behavior is production-tested.

Do not casually change V1 semantics while implementing newer source-aware features.

---

## Version 2

V2 enables source-aware editing.

The key operation is a source-aware sequence.

Conceptually:

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

For V2:

- sequence order defines output order
- timestamps are source-local
- repeated source references may be valid
- omitted sources do not appear in the sequence
- source IDs must exist
- ranges must fit inside the referenced source

V2 plans must be validated before FFmpeg execution.

---

# 12. Source-Scoped Operations

Source-specific effects must only be added deliberately.

Currently, source-specific color grading is supported.

Example:

```json
{
  "type": "color_grade",
  "sourceId": "source-2",
  "style": "bw"
}
```

This means:

apply the color grade to `source-2` before final sequence assembly.

Other operations may still be global unless explicitly supported as source-scoped.

Do not assume every operation can safely accept `sourceId`.

---

# 13. Global Operations

Global operations apply to the assembled output timeline.

Depending on current implementation, these may include operations such as:

- title
- zoom
- speed
- crop
- fade
- global color grade

Do not make an operation source-scoped merely because the JSON schema can be extended.

The executor semantics must be intentional and tested.

---

# 14. Gemini Planner

Gemini acts as Cliponaut's editing planner.

Gemini should not directly control FFmpeg.

The expected architecture is:

User prompt
→ Gemini plan
→ strict server validation
→ deterministic execution

Never trust model output without validation.

---

# 15. Multi-Source Visual Understanding

For semantic multi-source requests, Gemini may receive multiple uploaded source videos using the Gemini Files API.

Examples of semantic requests:

- "Use the talking clip first."
- "Put the greenery footage at the end."
- "Start with the road footage."
- "Use video 2 first, then the outdoor nature clip."

Each Gemini video input must be explicitly associated with its stable source ID.

Conceptually:

SOURCE source-1
filename: greenery.mp4
duration: ...
dimensions: ...

[video part]

SOURCE source-2
filename: talking.mov
duration: ...
dimensions: ...

[video part]

Stable `sourceId` is authoritative.

Do not rely solely on attachment order.

---

# 16. Explicit vs Semantic Source References

Explicit references include:

- video 1
- video 2
- first video
- second video
- source-1
- source-2

These should map deterministically.

Semantic references include:

- talking clip
- greenery footage
- road footage
- video showing the house
- indoor clip

These require visual understanding.

Explicit source instructions take precedence over semantic interpretation where applicable.

---

# 17. Semantic Ambiguity

Cliponaut should not silently guess when a semantic source description is ambiguous.

Example:

Two uploaded videos both prominently contain greenery.

Prompt:

> Use the greenery video.

If Gemini cannot confidently identify one unique source, Cliponaut should fail safely rather than arbitrarily choosing one.

A later product phase may introduce a clarification UI.

Until then:

uncertainty → safe rejection

not:

uncertainty → silent guess

---

# 18. Gemini Failure and Fallback

Deterministic fallback is allowed for prompts that can be resolved without visual understanding.

Example:

> Use video 2, then video 1.

If Gemini is temporarily unavailable, deterministic source parsing may still handle this safely.

However:

> Use the beach clip first.

requires visual understanding.

If Gemini is unavailable:

- do not guess
- do not silently merge everything
- do not execute only part of the instruction
- return a safe unsupported/failure result

Mixed prompts such as:

> Use video 2 first, then the greenery clip.

must also fail safely if the semantic portion cannot be visually resolved.

---

# 19. Gemini Retry Behavior

Transient Gemini planning errors may be retried.

Examples include:

- HTTP 429
- HTTP 503
- relevant 5xx failures

Retries should:

- be bounded
- use backoff
- avoid re-uploading the same files unnecessarily
- reuse active Gemini file references within the same planning attempt

Do not create persistent Gemini-file caching without a clear need.

---

# 20. Gemini Temporary File Cleanup

Temporary Gemini Files API uploads must be cleaned up best-effort after planning.

Cleanup should occur after:

- successful planning
- planning failure
- retry exhaustion
- ambiguity rejection

Cleanup errors must not hide the original planning error.

Gemini file URIs must not be persisted to the browser or production database unless a future architecture explicitly requires it.

---

# 21. Validation Rules

Validation is a hard safety boundary.

Examples of invalid plans include:

- nonexistent `sourceId`
- negative timestamps
- non-finite timestamps
- `end <= start`
- clip range beyond source duration
- unsupported source-scoped operations
- malformed sequence
- empty required sequence
- conflicting merge/sequence semantics
- invalid operation combinations

Do not "repair" hallucinated source references by guessing what Gemini meant.

Reject invalid plans before FFmpeg.

---

# 22. FFmpeg Execution Principles

The executor should remain deterministic.

It is responsible for turning a validated edit plan into media output.

Where possible, reuse existing infrastructure for:

- input normalization
- mixed resolutions
- mixed frame rates
- different aspect ratios
- sources with audio
- silent sources
- Standard output
- 4K-aware output

Do not create a second media-processing architecture for new AI features.

AI decides the plan.

FFmpeg executes the validated plan.

---

# 23. Error Handling

User-facing errors should be simple and safe.

Internal logs should retain enough diagnostic detail to determine whether a failure came from:

- upload
- database
- Gemini upload
- Gemini activation
- Gemini planning
- plan validation
- FFmpeg
- object storage
- cancellation
- worker lifecycle

Never expose secrets merely to improve debugging.

Diagnostic logging should redact:

- credentials
- tokens
- private URLs
- signed URLs
- storage keys where unnecessary
- Gemini file identifiers where unnecessary

---

# 24. Production Debugging

When a production edit fails, do not immediately change code.

First identify the layer that failed.

Preferred investigation order:

1. Identify job ID.
2. Read durable job status.
3. Inspect worker logs.
4. Determine whether failure occurred during:
   - upload
   - queue claim
   - analysis
   - Gemini planning
   - validation
   - rendering
   - upload/output publication
5. Inspect active child processes if worker appears blocked.
6. Reproduce locally where practical.
7. Make the smallest safe fix.
8. Add a regression test.
9. Run the full relevant verification suite.

Never treat a generic UI error message as the root cause.

---

# 25. Worker Queue Safety

A job must not permanently block the worker.

Potential causes include:

- hanging FFmpeg process
- unbounded external API request
- failed cancellation handling
- worker crash
- stale job state

Do not increase worker concurrency simply because jobs are backing up.

Find the actual blocking cause first.

Concurrency changes are capacity decisions, not bug fixes.

---

# 26. Testing Philosophy

Every meaningful production bug should ideally result in a regression test.

Prefer deterministic tests wherever possible.

Tests should verify behavior, not merely implementation details.

Important categories include:

- single-video regression
- multi-video order
- source-local trim
- source-specific effect
- semantic source identification
- explicit + semantic references
- invalid source
- invalid range
- cancellation
- recovery
- worker continuation after cancellation
- Gemini transient failure
- fallback safety
- temporary file cleanup

Detailed production scenarios belong in `PRODUCTION_TESTS.md`.

---

# 27. Verification Before Commit

For meaningful code changes, run the relevant checks.

Baseline:

```bash
git diff --check
npm run lint
npm run test:jobs
npm run build
```

Run additional focused tests when modifying:

- planner
- validator
- executor
- cancellation
- FFmpeg subprocess control
- upload system

If a cloud/Codex sandbox cannot complete the production build because of an environment limitation, do not report the build as passed.

A developer or approved CI environment should complete the production build before deployment.

---

# 28. Git Discipline

Agents should:

- inspect before implementing
- keep changes narrowly scoped
- avoid unrelated refactors
- preserve backwards compatibility
- run tests before proposing a commit
- explain files changed
- explain root cause for bug fixes
- explain known limitations

Do not commit generated secrets, `.env` contents, credentials, or production tokens.

---

# 29. Production Deployment Safety

Production deployment is an approval boundary.

Unless the task explicitly grants deployment authority, an engineering agent should:

- implement
- test
- prepare the change
- report results
- stop before production deployment

Do not independently:

- push production migrations
- alter Railway configuration
- rotate secrets
- change database schema
- delete production storage
- change worker concurrency
- change domains
- perform destructive operations

without explicit authorization.

---

# 30. Database Migration Safety

Schema changes require deliberate rollout planning.

Before deployment:

1. Determine whether the migration is backward-compatible with current production code.
2. Decide migration/deployment order.
3. Verify rollback behavior.
4. Avoid temporary states where deployed code and schema are incompatible.

Do not assume "push first, migrate later" is safe.

---

# 31. Agent Responsibilities

## Codex / Engineering Agent

Owns:

- repository inspection
- implementation
- automated testing
- debugging
- regression tests
- code-quality verification
- preparing commits/branches
- engineering reports

Codex should continue investigating reasonable test failures rather than immediately stopping after the first error.

However, it must respect production approval boundaries.

---

## ChatGPT Work / Production Testing Agent

Owns:

- browser-based production verification
- running documented acceptance tests
- checking expected vs actual behavior
- collecting job IDs
- inspecting Railway logs where authorized
- gathering reproducible failure evidence
- producing engineering-ready bug reports

Work should not independently edit the source code.

---

## Product Owner

The product owner decides:

- feature scope
- phase priorities
- UX behavior
- acceptance criteria
- whether a tradeoff is acceptable
- whether a phase is ready for production

Agents should not silently redefine product behavior merely to make tests pass.

---

# 32. Phase Ownership

Current and completed development phases are documented separately in:

`PHASES.md`

Do not duplicate detailed roadmap status in this file.

Before beginning substantial work, read:

1. `CLIPONAUT_ENGINEERING.md`
2. `PHASES.md`
3. `PRODUCTION_TESTS.md`

---

# 33. Production Acceptance Tests

Detailed production test cases, source files, prompts, expected outputs, pass/fail criteria, and known edge cases belong in:

`PRODUCTION_TESTS.md`

A phase is not complete merely because automated tests pass.

Production behavior must also satisfy the relevant acceptance tests.

---

# 34. Core Engineering Principle

The goal is not to make Cliponaut appear intelligent.

The goal is to make Cliponaut:

- understand the user's intent
- produce the correct edit
- behave predictably
- fail safely
- recover reliably
- preserve user control

When choosing between a clever solution and a reliable solution, prefer the reliable solution unless the product requirement clearly demands otherwise.
