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

# 38. Phase 3A.5C-B Acceptance — Spoken Moment Selection

Status: `✅ COMPLETE`

Production acceptance was completed on revision `3f1490d1786facfdcd3ce113ee9b6070646ec7b9`.

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

## Accepted Production Evidence

### A — Exact Phrase Event Segment

PASS. Job `efccc054-e2d3-4be6-a879-94a0d4ef7e37` produced one candidate and a bounded quoted-speech segment. The initial duplicate-candidate failure was corrected by `465f9f6`.

### B — Exact Spoken Start Boundary

PASS. Job `8eb00ead-5952-4c27-ac43-6027db50715e` produced one candidate and the authoritative phrase-start-to-source-end range. The initial contraction/cardinality failure was corrected by `3f1490d`.

### C — Exact Spoken End Boundary

PASS. Job `bca6a307-23f2-407d-a46a-ab45a39b39b7` produced one candidate and the source-start-to-detected-phrase-end range.

### D — Exact Start + End Boundary

PASS. Job `f394747e-025b-4f8f-a7e4-984b32903962` produced one bounded positive spoken interval.

### E — Controlled Normalization

PASS. With `Cliponaut Pricing Test.mp4`, `Use the part where I say "twelve dollars".` produced one candidate and an approximately 0.7s output. The `$12` variant (job `d074a3a6-04e9-4639-9689-183d6540e6ed`) produced the same bounded result, proving deterministic `$12` ↔ `twelve dollars` normalization. The earlier full-sentence wording did not pass because unrelated transcript wording varied and is not acceptance evidence.

### F — Semantic Spoken Section

PASS. Job `87b9b6a0-9705-4e6a-9b59-8375020f2c9a` selected one coherent pricing discussion from a 22.015s source, producing approximately 10.2s while excluding the unrelated introduction and later customer-support topic.

### G — Explicit Source + Spoken

PASS. Job `7b919d55-1d84-410c-aa23-22992ff20100` correctly scoped `From video 2, use the part where I explain pricing.` to `source-2`.

### H — Semantic Source + Spoken

PASS. Job `be527ef2-f3c5-47ab-9bc7-30cd3a8a7b66` uniquely resolved `indoor talking clip` to `source-1` against outdoor greenery, then selected the pricing section.

### I — Unscoped Multi-Source Unique Match

PASS. Job `df25d131-fae7-482e-9f8c-fa289bb8750c` found zero pricing candidates in source-1 and one in source-2; global cardinality was one and source-2 rendered.

### J — Spoken No Match

PASS. Job `cab75fd9-6fc9-4340-b065-6c46bb4a3c3f` returned `SPEECH_NO_CANDIDATE` for `Use the part where I explain our refund policy.` when both sources had zero candidates. No output was fabricated.

### K — Same-Source Phrase Ambiguity

PASS. `Cliponaut Same Source Ambiguity Test.mp4` job `66a6f9e6-34db-4e23-abed-8640eab0e50b` produced two source-1 candidates and `SPEECH_AMBIGUOUS`; no occurrence was selected or rendered.

### L — Cross-Source Spoken Ambiguity

PASS. Job `de62584a-cc61-435c-b082-955bcf0b766a`, using two uploads of `Cliponaut Pricing Test.mp4`, produced one pricing candidate per source and safely rejected with `SPEECH_AMBIGUOUS`.

### M — Silent Source

PASS. `Duel between Samurai and Po.mp4` (approximately 5.1s, no audio track), job `e0b1bd04-e22e-426b-b2ae-c739e474b284`, produced zero candidates and `SPEECH_NO_CANDIDATE`, with no hallucinated transcript, range, or output.

### N — Spoken Range + Normal Edit

PASS. Job `35e3f674-b84e-43ee-8d4d-9b2fa056cfd2` selected the same coherent pricing range from the 22.015s source (approximately 10.218s output) and rendered it black and white. The server-authoritative spoken range survived normal planner operations.

### O — Regression Coverage

PASS. V1 single-video black-and-white (`a453a8a4-be06-4090-a894-9861af35433f`), V2 explicit `source-2 → source-1` ordering (`c41b20f9-ebcf-4e9b-bb37-3909b7394cd4`), Phase 3A.5B-B Talking → Greenery semantic source selection (`37422435-d2cf-496a-98b1-c79ae856bebb`), and Phase 3A.5C-A visual temple-event selection (`189ee8e5-3283-4431-adf5-f7e6c757a7b9`) all passed. The visual route retained its server-authoritative approximately 3.0s–7.3s range and was not affected by spoken routing.

## Final C-B Sign-Off

`Phase 3A.5C-B — Spoken Moment Selection: ✅ COMPLETE`

Production acceptance: `A–O PASS`.

No known blocking regression remains. These controlled short fixtures do not prove long-media performance; retain the realistic-media validation below.

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

---

# 39. Phase 3A.5C-C Acceptance — Multi-Moment Composition

Status: `✅ COMPLETE`

Final production acceptance completed on revision:

`6edd50841ff5ca1e7e4c81dadcb0255d653fcb89`

All six final acceptance and regression jobs passed.

## A — Visual + Visual Composition

Job: `7da5b603-8213-4ee0-ba99-431def74c89a`

Prompt:

> From video 1, use the part where the person walks through the temple, then from video 2, use the part where the person is talking to the camera.

PASS.

`moment-1` resolved uniquely to source-1 at approximately 3.5–7.8s.

`moment-2` resolved uniquely to source-2 at approximately 0.7–10.62s.

Authoritative order:

Temple → Talking

The final output was playable and approximately 14.233s.

## B — Exact Spoken Reverse Order

Job: `5c531888-34e8-4240-9319-efc13ced697c`

Prompt:

> Use the part where I say "customer support", then the part where I say "twelve dollars".

PASS.

Both spoken moments produced exactly one candidate from source-1.

Requested order was preserved:

Customer support → Twelve dollars

The final composed output was approximately 1.706s.

## C — Mixed Visual + Semantic Spoken + Global Black and White

Job: `014c68c5-12e0-4478-aa39-e08169143ea6`

Prompt:

> From video 1, use the part where the person walks through the temple, then from video 2, use the part where I explain pricing, and make it black and white.

PASS.

The visual moment resolved uniquely to source-1 at approximately 3.0–7.5s.

The semantic spoken moment resolved uniquely to source-2 across a coherent pricing section.

Authoritative order:

Temple → Pricing

The final output was approximately 14.75s.

Inspected portions of both assembled segments were black and white, confirming the color operation applied globally.

## D — Atomic Spoken Ambiguity

Job: `29672e3f-d5b0-433a-8e94-49dbac250a33`

Prompt:

> From video 1, use the part where the person walks through the temple, then from video 2, use the part where I say "The price is twelve dollars".

PASS.

The first visual moment was valid.

The second source produced two exact spoken candidates.

Diagnostics reported:

- `SPEECH_AMBIGUOUS`
- `candidateCount: 2`
- both candidates belonged to source-2

The job failed safely with no output artifact.

No temple-only partial render and no arbitrary spoken occurrence were produced.

## R1 — Phase 3A.5C-A Visual Regression

Job: `e99111e8-7d51-492d-8311-eb991f5d2372`

Prompt:

> Use the part where the person walks through the temple.

PASS.

The single visual request resolved uniquely to approximately 3.0–7.5s and produced a bounded approximately 4.5s playable output.

Existing C-A routing remained intact.

## R2 — Phase 3A.5C-B Spoken Regression

Job: `ae676f1d-6d42-4958-91dc-4b673d528b4a`

Prompt:

> Use the part where I say "twelve dollars".

PASS.

The single exact spoken request resolved uniquely and produced a bounded approximately 0.7s playable output.

Existing C-B routing remained intact.

## Mixed-FPS Executor Incident and Regression

The original Test A failure was traced to production FFmpeg `5.1.9-0+deb12u1`.

A 24 fps + 30 fps concat without explicit FPS synchronization reproduced extreme frame duplication:

- timeout after 8 seconds in the bounded synthetic reproduction
- approximately 5.95 MB partial output
- approximately 0.811s reported duration
- 166,667 video frames
- approximately 1,000,000 fps
- repeated FFmpeg duplicated-frame warnings

Adding:

`-fps_mode vfr`

to shared concat output produced:

- successful completion in approximately one second
- approximately 14.016s duration
- 396 video frames
- bounded output size
- valid audio

The exact real production Test A then passed after deployment.

No mixed-FPS concat runaway recurred during the remaining C-C acceptance batch.

## Final C-C Sign-Off

`Phase 3A.5C-C — Multi-Moment Composition: ✅ COMPLETE`

Production acceptance: `6/6 PASS`.

No known blocking regression remains.

The parent:

`Phase 3A.5C — Semantic Moment Selection`

is also safe to mark `✅ COMPLETE`.

---

# Phase 3B-A — Text & Typography Engine Production Acceptance

Production acceptance date: 2026-10-08

Accepted deployed revision:

`28b9fdb672fda9155911d276d12aff5d5a392b1b`

Typography implementation commit:

`c9f0e5b17d16771f8c9ced88354f212dcd18ea6c`

Production blocker fix:

`28b9fdb672fda9155911d276d12aff5d5a392b1b`

## Environment Compatibility

Production worker:

- FFmpeg `5.1.9-0+deb12u1`
- Debian 12
- `--enable-libass`
- `ass` filter available
- `fontsdir` supported
- bundled fonts readable from `/app/public/fonts`

Bundled production fonts verified:

- Inter
- Instrument Serif
- JetBrains Mono

No ASS/libass/font-loading blocker was identified before render testing.

## Gate 1 — ASS / Instrument Serif Proof

Job:

`164e7cea-edce-4d9a-b933-849e688997b3`

Prompt:

> Add the title "A Day In Kerala" at 0:03 using Instrument Serif.

PASS.

Instrument Serif rendered around final-output 3 seconds.

Output was playable and approximately 10.63s.

No ASS/libass/font-loading error occurred.

## A — Legacy Title Compatibility

Job:

`3336ce56-fc71-41da-80dc-752e1aef26ae`

Prompt:

> Add the title "Kerala" at 0:03.

PASS.

Legacy simple-title behavior remained intact with sensible default styling.

## B — HEX Color + Exact Font + Position

Job:

`3c2bc7df-b488-491f-880c-0b091541c898`

Prompt:

> Add the title "KERALA" at 0:03 in JetBrains Mono, use #677DEC, and place it at the bottom-right.

PASS.

Verified:

- registered monospaced font styling
- requested blue-purple HEX treatment
- bottom-right placement

## C — Semantic Font Intent

Job:

`555a5352-044b-40d7-a6a5-f695a12a83fb`

Prompt:

> Add the title "GAME NIGHT" at 0:03 using a gaming-style font.

PASS.

The request resolved to a registered font treatment.

No nonexistent/proprietary font asset was referenced.

## D — Rich Inline Typography

Job:

`de926e11-1224-44f5-9895-e21eba5f6742`

Prompt:

> Add the title "Trip to Kerala" at 0:03. Keep "Trip to" clean and white, and make "Kerala" elegant, #677DEC, and larger.

PASS.

One coherent title rendered with independently styled runs:

- `Trip to` — clean / white
- `Kerala` — larger / blue / elegant treatment

No ASS markup leaked into visible output.

## E — Multiple Independent Text Layers

Job:

`bd548845-7d5a-44ae-906f-02577da245a2`

Prompt:

> Add "Chapter One" at 0:01 at the top-center, then add "Kerala" at 0:05 at the bottom-center.

PASS.

Both title operations were preserved with independent timing and placement.

Neither layer overwrote or dropped the other.

## F — Final-Output Timing After Trim + Speed

Job:

`50e7bd8c-1654-4233-abf9-dfa04e01d89d`

Prompt:

> Trim the video from 0:05 to 0:15, make it 2x speed, and add the title "FAST" at 0:03.

PASS.

Final output was approximately 5.07s.

`FAST` appeared approximately 3 seconds into the final exported video.

This confirmed that title timing is evaluated after temporal editing rather than against the original source timeline.

## G — Multi-Source Final-Output Timeline

Initial production attempts exposed two unrelated blockers before the target behavior could be exercised.

### Attempt 1 — External Gemini 503

Job:

`40737307-65b4-4ffa-8347-bf29d53ec157`

Result:

External Gemini `503 UNAVAILABLE`.

No output was rendered.

This was not treated as a Cliponaut implementation defect.

### Attempt 2 — Explicit-Source Parsing Defect

Job:

`3d26a9f4-42cc-4fb7-9e5c-bff3cdfb6c36`

Prompt:

> Use the first 3 seconds of video 1, followed by the first 3 seconds of video 2, and add the title "SECOND HALF" at 0:04.

Result:

The prompt failed before rendering because explicit source-time phrases were incorrectly extracted as semantic references:

`seconds of video`

This produced ambiguous semantic source classification and safe rejection.

Root cause:

`extractSemanticSourceReferences()` could match the substring before the numeric source ordinal, leaving `video 1` / `video 2` outside the semantic match.

Fix:

`28b9fdb672fda9155911d276d12aff5d5a392b1b`

The parser now excludes explicit numeric source references from semantic source extraction while preserving legitimate semantic descriptions.

### Final Rerun — PASS

Job:

`8e14d85d-835d-4ff2-8003-d7ec91de9326`

Deployed revision:

`28b9fdb672fda9155911d276d12aff5d5a392b1b`

Exact prompt:

> Use the first 3 seconds of video 1, followed by the first 3 seconds of video 2, and add the title "SECOND HALF" at 0:04.

PASS.

Verified sequence:

source-1 → source-2

Final output duration:

approximately `6.016s`

`SECOND HALF` was visibly present on source-2 at approximately output `4.51s`.

The prior `SEMANTIC_AMBIGUOUS` parser failure did not recur.

This confirms that unqualified title timestamps are interpreted against the assembled final-output timeline rather than restarting per source.

## H — Non-Text Regression

Job:

`f68a9ec3-a230-496a-859b-82f5ee236b38`

Prompt:

> Make this video black and white.

PASS.

Existing non-text editing remained intact.

Output was playable, black and white, and approximately 10.63s.

## Final 3B-A Sign-Off

`Phase 3B-A — Text & Typography Engine: ✅ COMPLETE`

Production acceptance confirms:

- legacy title compatibility
- ASS/libass production rendering
- exact registered fonts
- semantic font intent
- HEX colors
- nine-point positioning
- rich text runs
- multiple independent text layers
- final-output timing after temporal edits
- final-output timing across explicit multi-source sequence assembly
- no regression in the tested non-text editing path

No known blocking regression remains for Phase 3B-A.

The parent:

`Phase 3B — Text, Captions & Audio`

remains `🚧 IN PROGRESS` pending Phase 3B-C.

---

# Phase 3B-B — Captions / Subtitles Production Acceptance

Production acceptance date: 2026-10-10

## Core Acceptance Matrix

- A — basic subtitles — PASS
  Job: `8de981a1-db70-4fe6-a3c1-1335861defb6`
- B — styled subtitles — PASS
  Job: `72fd0921-c161-4dc0-8eb3-c131e6cb5ff5`
- C — trim + captions — PASS
  Job: `3b26e009-953f-4051-b9ba-b864f1a59f25`
- D — speed + captions — PASS
  Job: `f9d00c24-8a8f-4b25-a9f5-4e771827740b`
- E — multi-source sequence + captions — PASS
  Job: `0cf2e817-29e3-4409-b94c-ebbc26f2a85a`
- F — targeted subtitle correction — PASS
  Job: `9a2d2c2a-8285-4aaa-aeae-e2dcd4c135ca`
- G — global subtitle replacement — PASS
  Job: `71db31f4-e319-4e5f-ace5-a3ef0d492d36`
- H — title + captions coexist — PASS
  Job: `eeecb631-b8f8-4fec-976c-e7b09a2a5188`
- R — non-caption regression — PASS
  Job: `0f8712fa-7d70-4db8-a179-8b142d6fa91b`
- I — no-usable-speech fixture — SKIPPED because no convenient dedicated silent fixture was used for this acceptance batch.

## Correction Planner Blocker

Initial F/G attempts failed before rendering with:

`This edit is not supported yet`

Root cause: server-authorized caption reconciliation occurred after the planner's empty-operation unsupported check.

Fix:

`d7b9c2a423c2f6280e1cd56ba8e2ef339477e4f4`
`Fix subtitle correction planning`

After deployment, both final correction tests passed:

- F — Job: `9a2d2c2a-8285-4aaa-aeae-e2dcd4c135ca`
- G — Job: `71db31f4-e319-4e5f-ace5-a3ef0d492d36`

## Styled-Caption Investigation and Cleanup

Temporary pixel-render diagnostics were introduced during styled-caption verification to distinguish rendering failures from bad visual sampling times. The investigation proved that styled captions were present in the final artifact when inspected inside actual cue intervals.

The heavy runtime diagnostics were removed after acceptance in:

`179c3c119008dcc505635e09cdba17655fdbc2d5`
`Remove heavy caption render diagnostics`

Lightweight caption diagnostics and automated pixel-render regression coverage, including exact `854x480` production geometry, remain.

Post-cleanup smoke test:

Job: `5bbd1e3f-dda8-438b-b3dd-46ae646d82bc`

`3B-B POST-CLEANUP SMOKE PASS` — 17.03s output; burned-in subtitles visible and synchronized; audio/video playable; lightweight diagnostics present; heavy pixel-difference diagnostics absent.

`PHASE 3B-B CORE ACCEPTANCE PASSED`

`Phase 3B-B — Captions / Subtitles: ✅ COMPLETE`

---

# Phase 3B-C — Basic Audio Controls Production Acceptance Plan

Phase status: `🚧 IN PROGRESS`

The following production matrix is required before Phase 3B-C can be marked complete:

- A — mute: `Mute the video.`
- B — exact 50%: `Reduce the volume to 50%.`
- C — qualitative quieter: `Make the audio quieter.`
- D — qualitative louder: `Make the audio louder.`
- E — audio fade in: `Fade the audio in at the beginning.`
- F — audio fade out: `Fade the audio out at the end.`
- G — combined volume + fade: `Reduce the volume to 50% and fade the audio out at the end.`
- H — trim + audio control
- I — speed + audio control
- J — multi-source sequence + global audio control
- K — semantic / multi-moment composition + audio control
- R1 — existing audiovisual fade regression: `Fade out at the end.` must still fade both video and audio.
- R2 — non-audio regression: black-and-white editing remains unchanged.
- R3 — text regression: titles and captions remain unchanged with audio controls.

Acceptance must use measurable audio levels / FFmpeg statistics where practical, not listening alone, and must still inspect a playable final artifact. Audio-only fade acceptance must confirm that the video itself does not visually fade.
