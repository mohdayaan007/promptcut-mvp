# Cliponaut Production Tests

This file is the production acceptance-testing source of truth for Cliponaut.

It is intended primarily for:

- ChatGPT Work / production-testing agents
- engineering agents validating production behavior
- the product owner during phase sign-off

Before running production tests, read:

1. `CLIPONAUT_ENGINEERING.md`
2. `PHASES.md`
3. `PRODUCTION_TESTS.md`

Do not mark a phase complete simply because automated tests pass.

Production behavior must satisfy the relevant acceptance tests in this file.

---

# 1. Testing Principles

Production testing should verify actual user-facing behavior.

For every test, record:

- date/time
- deployed revision/commit if known
- source files used
- source upload order
- exact user prompt
- expected behavior
- actual behavior
- approximate processing time
- final job status
- pass/fail
- relevant job ID if available

If a test fails, do not immediately change code.

First collect evidence.

---

# 2. Failure Investigation Protocol

When a production test fails:

1. Record the exact prompt.
2. Record source upload order.
3. Record expected result.
4. Record actual UI result/error.
5. Identify the latest durable job ID.
6. Inspect job status.
7. Inspect relevant worker logs.
8. Determine the failing layer where possible:
   - upload
   - queue
   - Gemini file upload
   - Gemini activation
   - Gemini planning
   - plan validation
   - FFmpeg rendering
   - output upload
   - cancellation
   - worker lifecycle
9. Capture the smallest relevant log/error block.
10. Return an engineering-ready bug report.

Do not treat a generic UI message such as:

> Unable to process this video. Please try again.

as the root cause.

---

# 3. Production Safety Rules

Testing agents may:

- open Cliponaut
- upload approved test media
- submit test prompts
- wait for results
- refresh/reopen Cliponaut
- inspect job status
- inspect Railway logs where authorized
- collect evidence
- report failures

Testing agents must not independently:

- edit source code
- change Railway configuration
- change environment variables
- change worker concurrency
- alter database schema
- delete production storage
- rotate credentials
- kill arbitrary processes
- run destructive commands
- push code
- deploy unapproved revisions

If a production process appears stuck, collect evidence first and escalate.

---

# 4. Core Test Media

Use clearly distinguishable media whenever possible.

Known useful categories include:

## A. Kerala Greenery

Visual characteristics:

- outdoor
- greenery / nature
- visually distinct from a person talking indoors

Useful for semantic prompts such as:

> greenery footage

> outdoor nature footage

## B. Talking Video

Visual characteristics:

- a person visibly talking
- strongly distinguishable from outdoor greenery

Useful for semantic prompts such as:

> talking video

> talking clip

> video where I'm talking

A longer talking `.mov` file around 42 seconds / ~42 MB has previously been useful for long-render/cancellation testing.

A smaller talking video may be used for faster semantic tests.

## C. Kerala Homestay

Use only when the visual content is sufficiently distinguishable for the intended test.

Do not assume the word "homestay" can be visually identified if the footage does not clearly show one.

## D. Road / Driving Footage

Prefer a clip where road/driving content is visually obvious.

Useful for:

> road footage

> driving clip

## E. Two Similar Greenery Clips

Use two different clips that both visibly contain substantial greenery.

These are useful specifically for ambiguity testing.

---

# 5. Baseline Single-Video Regression

Purpose:

Verify that newer multi-source work has not broken established V1 editing.

Upload:

1 clearly valid small video.

Prompt:

> Make this video black and white.

Expected:

- job processes successfully
- final video is black and white
- video remains playable
- expected audio behavior is preserved
- no source-aware recovery error appears

Pass:

Output is successfully generated and visually black and white.

Fail:

Any planner, validation, FFmpeg, queue, or output regression.

---

# 6. Explicit Two-Source Reordering

Purpose:

Verify Phase 3A.5B-A explicit source addressing.

Upload order:

1. Video A
2. Video B

Prompt:

> Put the second video first, then the first.

Expected final order:

Video B → Video A

Pass:

- both sources appear
- order is B then A
- no duplicate clips
- output is playable

---

# 7. Source-Local Trim

Purpose:

Verify timestamps are interpreted relative to individual source videos.

Use source clips that are definitely long enough.

Upload:

1. Video A
2. Video B

Prompt:

> Use the first 3 seconds of video 1, followed by the first 3 seconds of video 2.

Expected:

- source-1: approximately 0–3 seconds
- source-2: approximately 0–3 seconds
- output duration approximately 6 seconds

Pass:

Correct source-local sections appear in the correct order.

Important:

Do not request a range beyond the duration of a source.

A previous request:

> Use the first 5 seconds of video 1, followed by seconds 10 to 15 of video 2.

correctly failed when source-2 was shorter than the requested range.

That validator behavior is expected.

---

# 8. Source-Specific Black and White

Purpose:

Verify source-scoped color grading.

Upload:

1. Video A
2. Video B

Prompt:

> Make only video 2 black and white.

Expected:

- video 1 remains in color
- video 2 becomes black and white

Pass:

Only source-2 receives the black-and-white treatment.

---

# 9. Three-Source Explicit Ordering

Purpose:

Verify explicit addressing beyond two sources.

Upload:

1. Video A
2. Video B
3. Video C

Prompt:

> Use video 3, then video 1, then video 2.

Expected:

Video C → Video A → Video B

Pass:

All three sources appear exactly once in that order.

---

# 10. Semantic Two-Source Ordering

Purpose:

Verify Phase 3A.5B-B visual source understanding.

Recommended sources:

1. Kerala Greenery
2. Talking Video

Prompt:

> Start with the video where I'm talking, then show the greenery footage.

Expected:

Talking Video → Greenery

Pass:

Gemini correctly identifies both sources by visible content and outputs them in the requested order.

This test has previously passed in production.

---

# 11. Alternate Semantic Two-Source Ordering

Use the same sources:

1. Kerala Greenery
2. Talking Video

Prompt:

> Use the talking clip first, then the outdoor nature footage.

Expected:

Talking Video → Greenery

Pass:

Semantic descriptions map to the correct source IDs.

This test has previously passed in production.

---

# 12. Mixed Explicit + Semantic Source Selection

Purpose:

Verify deterministic explicit references and semantic visual references can coexist.

Recommended upload:

1. Kerala Greenery
2. Talking Video

Prompt:

> Use video 2 first, then the greenery clip.

Expected:

source-2 → visually identified greenery source

For the recommended upload order:

Talking Video → Greenery

Pass:

- explicit `video 2` is obeyed
- semantic `greenery clip` resolves correctly
- no source is silently guessed incorrectly

Final production result: PASS — Talking → Greenery, job `86399578-d8ef-4d79-a59c-ae0db5d0cd5f`.

---

# 13. Three-Source Semantic Ordering

Purpose:

Verify semantic visual identification across three distinct sources.

Recommended source types:

1. Greenery
2. Indoor / Talking
3. Road / Driving

Prompt:

> Start with the road footage, then the indoor clip, then the greenery.

Expected:

Road → Indoor/Talking → Greenery

Pass:

All three semantic descriptions map to the intended source IDs and sequence correctly.

Final production result: PASS — Road → Talking/Indoor → Greenery, job `b9a4bbaa-42f5-435d-98b9-7e85e6fcc82e`.

---

# 14. Semantic Ambiguity Safety

Purpose:

Verify Cliponaut does not silently guess between visually similar sources.

Upload:

1. Greenery Clip A
2. Greenery Clip B

Both should clearly contain substantial greenery.

Prompt:

> Use the greenery video.

Expected:

If Gemini cannot confidently identify a unique intended source, Cliponaut should safely reject or report that it cannot identify the source confidently.

Pass:

No arbitrary source is silently chosen when the instruction is genuinely ambiguous.

Fail:

Cliponaut selects one source without sufficient basis.

Final production result: PASS — with Kerala Greenery and Forest Path, `Use the greenery video.` safely rejected without selecting a source or producing output. The final UI did not expose a job ID.

---

# 15. Explicit Prompt During Gemini Failure

Purpose:

Verify deterministic fallback remains safe.

Prompt:

> Use video 2 then video 1.

Expected:

If Gemini is temporarily unavailable, deterministic fallback may still produce:

source-2 → source-1

Pass:

Explicit source order can still be executed safely without semantic guessing.

---

# 16. Semantic Prompt During Gemini Failure

Purpose:

Verify semantic fallback safety.

Prompt:

> Use the beach clip first.

Expected if Gemini visual planning is unavailable:

- do not guess
- do not silently merge sources
- do not choose a source based only on upload order
- return a safe failure/unsupported response

Pass:

No fabricated semantic mapping occurs.

---

# 17. Mixed Semantic Prompt During Gemini Failure

Prompt:

> Use video 2 first, then the greenery clip.

Expected if Gemini visual planning is unavailable:

- do not execute only `video 2`
- do not silently omit the semantic portion
- do not guess the greenery source
- fail safely

Pass:

The instruction remains atomic rather than partially executed.

---

# 18. Global Multi-Video Black and White

Status:

Resolved production regression.

Upload:

2 valid videos.

Prompt:

> Make both videos black and white.

Also test:

> Make all videos black and white.

Expected planning behavior:

One global unscoped operation:

`color_grade: bw`

Expected user result:

- both videos appear in the assembled output
- entire assembled output is black and white
- no duplicate `color_grade` operations are generated

Historical production failure:

`Invalid edit plan: only one color_grade operation is allowed`

Final production results:

- `Make both videos black and white.` — PASS, job `c50942dc-149a-46ac-b289-9cae1d56877e`
- `Make all videos black and white.` — PASS, job `76563941-6c6e-4f4d-a369-7141b0ae141e`

---

# 19. Source-Specific vs Global Color Regression

After fixing global multi-video color behavior, verify both cases back-to-back.

## Source-Specific

Prompt:

> Make only video 2 black and white.

Expected:

Only video 2 becomes black and white.

## Global

Prompt:

> Make both videos black and white.

Expected:

Both videos become black and white through one global operation.

Pass:

Both behaviors work without loosening validation unsafely.

Final production result: PASS — `Make only video 2 black and white.` used one source-specific color grade, job `295085c2-d4e6-42f4-8b38-917f76a1ba60`.

---

# 20. Refresh During Active Job — Continue

Purpose:

Verify durable-job recovery.

Start an edit.

Wait until:

- Analyzing
or
- Rendering

Refresh Cliponaut.

Expected modal:

> You have an edit in progress.  
> What would you like to do?

Choose:

Continue

Expected:

- same job reconnects
- source cards restore
- source order is preserved
- no duplicate job is created
- processing continues
- final result appears normally

Test with:

- one video
- two videos

Both have previously passed in production.

---

# 21. Refresh During Active Job — Start Fresh

Start an edit.

Wait until Rendering.

Refresh.

Choose:

Start fresh

Expected:

- active job becomes cancelled
- workspace becomes clean
- source cards disappear
- prompt/messages/result state reset
- user may immediately start a new edit

Pass:

Cancellation is durable and workspace reset is complete.

---

# 22. Completed Job Recovery — View Edit

Start an edit.

Leave/close Cliponaut before completion.

Return after the job finishes.

Expected modal:

> Your edit is ready.

Choose:

View edit

Expected:

- completed source cards restore
- completed output restores
- result is playable
- no duplicate job is created

This behavior has previously passed in production.

---

# 23. Completed Job Recovery — Start Fresh

Return to a completed recovered edit.

Choose:

Start fresh

Expected:

- previous completed job is not retroactively cancelled
- browser workspace resets
- clean upload screen appears

This behavior has previously passed in production.

---

# 24. FFmpeg Cancellation / Worker Slot Test

Purpose:

Verify a cancelled render cannot block the single worker indefinitely.

Recommended source:

Use a sufficiently long source or multi-source render that reaches active FFmpeg rendering.

Example prompt:

> Use the talking video first, then the greenery footage.

Procedure:

1. Start the edit.
2. Wait until Rendering.
3. Refresh.
4. Choose Start fresh.
5. Immediately submit another small valid edit.

Recommended second prompt:

> Make this video black and white.

Use a single small video for the second job to avoid ambiguity.

Expected:

- first job becomes cancelled
- first job's active FFmpeg child is terminated
- worker slot is freed
- second job progresses normally
- second job does not remain queued for an excessive period because of the cancelled job

This behavior has been production-verified after the subprocess-cancellation fix.

---

# 25. Worker Queue Investigation

If later jobs remain stuck in `queued`:

Do not immediately increase concurrency.

Check:

- whether an active job is genuinely processing
- whether a cancelled job left an FFmpeg process alive
- whether Gemini/API work is hanging
- whether worker loop is alive
- whether durable status matches actual process state

Escalate with:

- queued job ID
- blocking job ID if known
- relevant worker logs
- process evidence if available

---

# 26. Five-Source Sanity Test

Purpose:

Verify the maximum currently supported source count.

Upload:

5 small, valid, distinguishable videos.

Use an explicit prompt first.

Example:

> Use video 5, then video 3, then video 1.

Expected:

Correct explicit source sequence.

Then perform a controlled semantic test only if Gemini production limits allow the total source sizes.

Record:

- total file sizes
- upload time
- Gemini analysis time
- total processing time
- any API limit errors

Do not interpret size/quota failures as FFmpeg failures.

Final controlled production result: PASS — five sources were accepted and the explicit order `5 → 2 → 1 → 4 → 3` was preserved. Output was playable, approximately 19.13 seconds, with approximately 60 seconds turnaround; job `29805a23-7d8c-47a8-b307-cedfe9f9a1ca`. An earlier long-media five-source run was cancelled as a performance/operational observation, not a semantic ordering failure.

---

# 27. Gemini File-Size / Account-Limit Test

Purpose:

Understand actual production Gemini Files API limits for Cliponaut's configured credentials.

Do not intentionally upload unnecessarily huge files merely to stress production.

Use progressively larger controlled test media where appropriate.

Record:

- file format
- file size
- duration
- number of sources
- Gemini upload outcome
- user-facing error
- internal error/status if rejected

If Gemini rejects a source due to size:

Expected user-facing behavior should clearly indicate that Gemini analysis cannot accept that uploaded media size.

Do not mislabel it as generic FFmpeg failure.

---

# 28. Gemini 503 Retry Test

Purpose:

Verify transient Gemini planning failures use bounded retries.

This may occur naturally and should not be artificially triggered destructively in production.

If a 503 occurs:

Verify logs indicate:

- generateContent retry
- existing Gemini file references reused
- source files are not repeatedly uploaded for each retry
- retries remain bounded
- cleanup still occurs afterward

If retries exhaust on a semantic request:

Expected:

safe failure, not guessing.

---

# 29. MOV Compatibility Test

Purpose:

Verify real-world `.mov` input remains supported.

Use the talking `.mov` source where appropriate.

Record:

- file size
- duration
- processing time
- whether audio is preserved
- whether normalization succeeds

A `.mov` source should not be treated as unsupported merely because processing is slower.

---

# 30. Mixed Resolution / Orientation Test

Upload sources with visibly different:

- resolutions
- orientations
or
- aspect ratios

Use a simple explicit sequence prompt.

Expected:

- executor normalizes sources successfully
- one consistent playable final canvas is produced
- no corrupted output
- audio behavior remains valid

Do not assume output should preserve each source's original dimensions independently.

---

# 31. Silent + Audio Source Test

Upload:

- one source with audio
- one source without audio

Use a simple sequence prompt.

Expected:

- output remains playable
- concat does not fail due to missing audio
- current silent-audio normalization behavior is preserved

---

# 32. Production Performance Recording

Performance is not currently a strict pass/fail threshold unless a phase defines one.

However, record approximate timings for:

- upload
- queued wait
- analyzing
- rendering
- total completion

Flag significant regressions.

Do not automatically classify a long render as "stuck."

Confirm whether progress is continuing first.

---

# 33. Current Known Performance Characteristics

Worker concurrency is currently limited.

Therefore:

- only a limited number of jobs may actively process simultaneously
- queued jobs are expected when the worker is busy
- queueing itself is not automatically a bug

A bug exists if:

- a completed/cancelled job continues blocking the worker
- the worker stops claiming jobs unexpectedly
- an external process hangs indefinitely
- queue state becomes inconsistent with worker state

---

# 34. Test Result Format

For each production test, report using this structure:

## Test Name

Date:

Revision/commit:

Sources:

Upload order:

Prompt:

Expected:

Actual:

Approximate timing:

Job ID:

Job status:

Relevant logs:

Result:

`PASS` or `FAIL`

Notes:

---

# 35. Engineering Bug Report Format

If a test fails, return:

## Production Bug

### Summary

One sentence describing the failure.

### Reproduction

1.
2.
3.

### Sources

List exact source types/files and upload order.

### Prompt

Exact prompt.

### Expected

Expected user-visible result.

### Actual

Actual user-visible result.

### Job

Job ID:

Status:

### Logs

Smallest relevant log/error block.

### Suspected Layer

One of:

- upload
- Gemini upload
- Gemini planning
- validation
- executor
- FFmpeg
- storage
- cancellation
- worker lifecycle
- unknown

### Reproducibility

- always
- intermittent
- happened once
- not yet retested

### Production Impact

Describe whether this:

- blocks a core feature
- affects an edge case
- blocks the queue
- causes wrong output
- causes safe rejection only
- has no user-visible impact

Do not propose a broad rewrite unless the evidence requires it.

---

# 36. Final Phase Sign-Off — Phase 3A.5B-B

Final status: `✅ COMPLETE`

Implementation, automated verification, deployment, and production acceptance testing are complete.

## Accepted Production Evidence

- Natural-content ordering passed for Homestay → Greenery and Talking → Greenery prompts.
- Mixed explicit plus semantic selection passed: `Use video 2 first, then the greenery clip.` produced Talking → Greenery; job `86399578-d8ef-4d79-a59c-ae0db5d0cd5f`.
- Three-source semantic ordering passed: Road → Talking/Indoor → Greenery; job `b9a4bbaa-42f5-435d-98b9-7e85e6fcc82e`.
- Ambiguous greenery sources safely rejected without selecting an arbitrary source or producing output.
- Unique semantic selection passed after Gemini quota was available: `Use the talking clip first, then the greenery footage.` produced Talking → Greenery; job `e4dc93e9-4b89-45f5-bd72-b23b4ebf7242`, approximately 22 seconds playable output.
- Global black and white passed for both/all-source prompts; jobs `c50942dc-149a-46ac-b289-9cae1d56877e` and `76563941-6c6e-4f4d-a369-7141b0ae141e`.
- Source-specific black and white passed for `only video 2`; job `295085c2-d4e6-42f4-8b38-917f76a1ba60`.
- V1 single-video black-and-white regression passed; job `f4355fa7-2b27-4982-880e-0f212d7930a6`.
- Controlled five-source explicit ordering passed with all five sources retained; job `29805a23-7d8c-47a8-b307-cedfe9f9a1ca`.

## Recorded Incidents

The earlier global multi-video black-and-white failure was an application planner bug and is resolved. The validator was not loosened; both/all-source color requests now use one global unscoped operation, while explicit single-source color uses one source-specific operation.

The temporary unique-semantic-selection failure was an external Gemini free-tier `429 RESOURCE_EXHAUSTED` generate-content quota exhaustion for `gemini-3.6-flash`, not a planner or classification regression. The same acceptance test passed once quota was available.

The earlier long-running five-source render was cancelled as a performance/operational observation. It was not a semantic/source-ordering failure.

---

# 37. Phase 3A.5C-A Acceptance — Visual Moment Selection

Status: `✅ COMPLETE`

All final production acceptance scenarios A–M passed. For controlled short, unambiguous clips, approximately ±2 seconds remains the initial human acceptance tolerance for annotated visual boundaries; it is not a permanent universal product guarantee.

## A. Unique Single-Video Event

Prompt: `Use the part where the person walks through the temple.`

PASS — The output began roughly 1–2 seconds before temple entry, included the full walking-through-temple event, ended when the person exited, and was a playable bounded segment.

## B. Start Boundary

Prompt: `Start when the person enters the temple.`
Source: `Walking to the temple.mp4`
Job: `ca41a030-484c-4db9-98df-73038850940d`

PASS — Approximately 7.25-second output from the detected entrance through the natural source end.

## C. End Boundary

Prompt: `End when the person exits the temple.`
Job: `c14f8337-46a8-41c6-ab01-d39c09a0eb8f`

PASS — Approximately 8.21-second output from source start through the detected exit.

## D. Start and End Boundaries

Prompt: `Start when the person enters the temple and end when the person exits the temple.`
Job: `cba9f785-ac25-4553-93be-342d1a8350ea`

PASS — Approximately 5.17-second bounded segment between entrance and exit.

## E. Explicit Source plus Moment

Prompt: `From video 2, use the part where the person walks through the temple.`
Sources: `Forest_Path_Video_Generation.mp4`, `Walking to the temple.mp4`
Job: `7bbc1829-172b-44eb-8ca3-bae86fd0d8c0`

PASS — Temple-only segment; no Forest Path substitution.

## F. Semantic Source plus Moment

Prompt: `From the temple clip, use the part where the person walks through the temple.`
Sources: Forest Path + Temple
Job: `011c2e8a-f4f2-4b26-854c-973186cef9fd`

PASS — Semantic source resolved correctly before localization.

## G. Unscoped Multi-Source Unique Match

Prompt: `Use the part where the person walks through the temple.`

Initial job: `5dbf8296-b877-4ace-bbc9-1e054101bcc2`

The initial production run failed safely with `MOMENT_AMBIGUOUS`: the Forest Path source incorrectly returned a candidate alongside the Temple source. This exposed an overly permissive Gemini partial-semantic match; the server aggregation safety behavior was correct.

Targeted fix: `9626561` — Tighten visual moment matching
Retest job: `e6e3e097-80a7-4c1d-91d4-45e11d3d3afb`

PASS — Diagnostics reported Forest Path `candidateCount: 0`, Temple `candidateCount: 1`, and aggregated `sourceIds: ['source-2']`, `candidateCount: 1`. The correct temple-only output rendered. Ambiguity behavior remained strict.

## H. Unscoped No Match

Prompt: `Use the part where a car drives through the frame.`
Sources: Forest Path + Temple
Job: `c93e8f6a-82b2-434b-ab3a-92adb175c083`

PASS — `MOMENT_NO_CANDIDATE`; no fabricated output rendered.

## I. Cross-Source Ambiguity

Prompt: `Use the part where the person walks through the temple.`
Sources: Temple video uploaded as both source-1 and source-2
Job: `60deaf09-1a6f-46db-8a33-b9b536f53fc5`

PASS — `MOMENT_AMBIGUOUS`, `candidateCount: 2`; no arbitrary source was selected and no output rendered.

## J. Same-Source Ambiguity

Fixture: `cliponaut-same-source-ambiguity.mp4` — Walking to the temple (8s), Forest Path separator (2s), then the same Walking to the temple excerpt (8s); approximately 18 seconds total.
Prompt: `Use the part where the person walks through the temple.`
Job: `74549755-4581-4b4d-9662-ad59f9c230cd`

PASS — source-1 returned `candidateCount: 2`, resulting in `MOMENT_AMBIGUOUS`. No output rendered and neither occurrence was arbitrarily selected.

## K. V1 Regression

Prompt: `Make this video black and white.`
Job: `edccd9f7-9a25-4354-89b2-1ccee24a88b1`

PASS — Existing V1 behavior remains functional.

## L. V2 Explicit-Source Regression

Prompt: `Use video 2, then video 1.`
Sources: `Raodmm.mp4`, `Fish Tawa Fry.mp4`
Job: `bfb673ad-caaf-4f66-b4bf-0face2334bc2`

PASS — Output order: Fish Tawa Fry → Road.

## M. Semantic-Source Regression

Prompt: `Use the talking clip first, then the greenery footage.`
Sources: `Intro Cliponaut Testing.mp4`, `Kerala Greenery.mp4`
Job: `eb512f61-fcf3-45c8-98c5-92f6ad7b433a`

PASS — Output: Talking → Greenery. Existing Phase 3A.5B-B behavior remains functional.

### Engineering Verification

- `npm run test:jobs` — 49/49 PASS
- `npm run lint` — PASS with the existing unrelated `<img>` warning
- `npm run build` — PASS locally
- `git diff --check` — PASS

---

# 38. Phase 3A.5C-B Planned Acceptance — Spoken Moment Selection

Status: `🚧 IN PROGRESS`

Spoken-moment acceptance must verify correct source selection, authoritative range selection, safe ambiguity behavior, and preservation of existing V1/V2 behavior. For controlled short speech, approximately ±1 second is the initial human acceptance tolerance for a spoken boundary. This is provisional, not frame-accurate or universal, and must be assessed manually on the rendered output.

## A. Exact Phrase Event Segment

Prompt:

> Use the part where I say "Welcome to Kerala."

Expected: a bounded section covering the spoken phrase; no unrelated broader visual event is substituted.

## B. Exact Phrase Start Boundary

Prompt:

> Start when I say "Welcome to Kerala."

Expected: detected phrase start through the authoritative source end.

## C. Exact Phrase End Boundary

Prompt:

> End when I say "Thanks for watching."

Expected: source start through the detected phrase end.

## D. Exact Phrase Start and End Boundaries

Prompt:

> Start when I say "Welcome to Kerala" and end when I say "Thanks for watching."

Expected: first resolved spoken boundary through second resolved spoken boundary, with a positive range.

## E. Near-Exact Normalized Phrase

Prompt:

> Start when I say "The Pro plan costs $12."

Transcript variation:

> The pro plan cost twelve dollars.

Expected: match only when conservative deterministic normalization resolves a unique equivalent phrase. Ambiguous or broad semantic equivalence must reject safely.

## F. Semantic Spoken Section

Prompt:

> Use the part where I explain pricing.

Expected: a coherent pricing discussion across the relevant transcript segments—not merely the sentence containing `price`.

## G. Explicit Source plus Spoken Request

Prompt:

> From video 2, use the part where I explain pricing.

Expected: only source-2 is transcribed/searched for the requested moment.

## H. Semantic Source plus Spoken Request

Prompt:

> From the talking clip, use the part where I explain pricing.

Expected: Phase 3A.5B-B resolves the source first; spoken localization then searches only that source.

## I. Unscoped Multi-Source Unique Match

Prompt:

> Use the part where I explain pricing.

Expected: every in-scope source is evaluated; exactly one candidate produces the correct source and range.

## J. Spoken No Match

Prompt:

> Use the part where I explain our refund policy.

Expected: zero candidates, a safe rejection, and no fabricated output.

## K. Same-Source Phrase Ambiguity

Use a source where the requested phrase occurs twice.

Expected: two candidates, a safe ambiguity rejection, and no first-occurrence selection.

## L. Cross-Source Spoken Ambiguity

Use two sources that both contain the requested phrase or topic.

Expected: two or more candidates, a safe ambiguity rejection, and no ranking or arbitrary selection.

## M. Silent Source

Use a source without usable speech/audio.

Expected: no hallucinated transcript or spoken range; zero candidates or another safe no-match outcome.

## N. Spoken Range plus Normal Edit Operation

Prompt:

> Use the part where I explain pricing and make it black and white.

Expected: the speech-derived range remains server-authoritative while the supported global color operation is also applied.

## O. Regression Coverage

Verify at minimum:

- V1 single-video editing
- V2 explicit source ordering
- Phase 3A.5B-B semantic source selection
- Phase 3A.5C-A visual moment selection

## Later Realistic-Media Performance Validation

Short fixtures prove semantic behavior, not paying-user long-media performance. After semantic acceptance, separately test realistic workloads such as a five-minute source and multiple five-minute sources. Record:

- upload time
- temporary audio-extraction time
- transcription time
- transcript semantic-match time
- planning time
- FFmpeg rendering time
- total latency
- retries
- CPU/RAM behavior
- Gemini request count and usage

---

# 39. Product Quality Standard

A production test is not merely checking whether a file was generated.

The output should also be:

- the requested edit
- from the correct source(s)
- in the correct order
- using the correct time ranges
- visibly valid
- playable
- free from obvious duplicate clips
- consistent with the prompt

A technically successful render with the wrong semantic result is a failed product test.

---

# 40. Final Testing Principle

Cliponaut's goal is not:

> produce any video successfully

Cliponaut's goal is:

> correctly understand what the user asked for and produce that edit reliably.

When testing, prioritize correctness and predictable behavior over merely obtaining a completed job status.
