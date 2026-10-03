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
