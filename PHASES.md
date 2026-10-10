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

Status: `✅ COMPLETE`

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

Status: `✅ COMPLETE`

Purpose:

Allow users to identify a source-local video range from what is said, while preserving the existing V2 authoritative-sequence, validation, and FFmpeg execution model.

### In Scope

#### Exact / Near-Exact Spoken Phrases

Examples:

- `Start when I say "Welcome to Kerala".`
- `Use the part where she says "The price is 500 rupees".`
- `End after he says "Thanks for watching".`

Quoted or phrase-like requests should be matched deterministically against an authoritative transcript. Matching may normalize case, Unicode, punctuation, whitespace, deterministic contractions, and narrowly controlled number/currency and STT-formatting variants. It must not turn an unresolved quoted phrase into broad semantic guessing.

#### Semantic Spoken Content

Examples:

- `Use the part where I explain pricing.`
- `Show the section where I talk about our refund policy.`
- `Start when I begin talking about Cliponaut.`

The result must cover a coherent spoken section, rather than merely the one sentence containing a keyword. For example, a pricing request may include the introduction to plans, the price, and the included benefits through the transition to the next topic.

### Spoken Moment Modes

3A.5C-B reuses the user-facing modes from visual moment selection:

- `EVENT_SEGMENT`: the coherent resolved spoken section.
- `START_BOUNDARY`: the resolved phrase/topic start through the authoritative source duration.
- `END_BOUNDARY`: source time `0` through the resolved phrase/topic end.
- `START_END_BOUNDARY`: first resolved spoken boundary through second resolved spoken boundary, with `end > start` required.

Both boundaries are speech-based in this phase. Mixed visual and spoken boundaries are out of scope.

### Source Scope and Candidate Safety

- One source: search its speech.
- Explicit source: process/search only that source.
- Semantic source: resolve it first with Phase 3A.5B-B, then process only its speech.
- Multiple sources without scope: independently process/search every uploaded source and aggregate server-validated candidates.

Candidate safety remains strict:

- 0 candidates: safe no-match rejection.
- Exactly 1 candidate: proceed.
- 2 or more candidates: safe ambiguity rejection.

Cliponaut must not select the first occurrence, upload order, longest section, or a supposedly "best" explanation. This applies both to repeated matches in one source and matches across sources.

### Production Architecture: Hybrid Transcript-First

`prompt structural extraction → source-scope strategy → semantic source resolution when required → temporary FFmpeg audio extraction → Gemini timestamped transcription → canonical server-owned transcript → deterministic exact/normalized phrase matching OR semantic transcript matching → server candidate validation and aggregation → authoritative sourceId + start + end → existing planner for remaining operations → V2 validation → FFmpeg execution`

Spoken intent must route before and exclusively from visual moment localization. A request such as `Use the part where she says...` must never enter the visual localizer merely because it contains `use the part where`.

The server remains authoritative: Gemini interprets, but Cliponaut validates and derives execution values. After spoken localization, the final planner must not alter the authoritative `sourceId`, `start`, `end`, or sequence order. Additional supported operations, such as global black and white, may remain in the final plan.

### Transcription Contract and Lifecycle

The current environment has been compatibility-tested with `@google/genai` 2.20.0:

`worker-local video → temporary FFmpeg mono 16 kHz AAC/M4A → Gemini Files upload → gemini-3.5-transcribe interaction → verbatim word annotations`

The dedicated transcription primitive is audio-based. The existing Gemini video File remains in use for semantic source classification, visual understanding, and final edit planning; it is not replaced by the temporary transcription audio File.

Gemini word annotations must be normalized by server code into a canonical source-owned transcript conceptually like:

```json
{
  "sourceId": "source-1",
  "segments": [
    {
      "segmentId": "source-1-seg-1",
      "start": 0.8,
      "end": 3.7,
      "text": "Welcome to Kerala",
      "words": [{ "start": 0.8, "end": 1.2, "text": "Welcome" }]
    }
  ]
}
```

Cliponaut assigns stable segment IDs; Gemini must not supply authoritative IDs. The first version keeps transcripts only in worker memory for the current job. It does not add transcript persistence to PostgreSQL or object storage. Temporary extracted audio and temporary Gemini audio Files must be deleted after both success and failure.

For semantic topic matching, Gemini should receive canonical transcript text/segments and return transcript segment ID ranges—not raw execution timestamps. Cliponaut validates ownership and ordering, derives the authoritative timestamps from its transcript, then constructs the V2 range.

### Compatibility Evidence and Initial Tolerance

Two local engineering spikes established the primitive:

- `Kerala Homestay.mp4`: 7.838s source / 7.767s audio; transcript `120`; one word annotation from 2.2–2.5s; approximately 4.5s transcription latency; one call; no retry; cleanup succeeded. This proved the primitive but was too speech-light for quality evaluation.
- `Intro Cliponaut Testing.mp4`: 10.625s source; 28 monotonic word annotations within the source duration; approximately 4.95s transcription latency; one call; no retry; cleanup succeeded. The transcript included `Hello, team TechStars... I'm a solo founder of Clip or Not...`; `Cliponaut` was rendered approximately as `Clip or Not`.

The evidence supports conservative near-exact STT normalization. It does not establish frame-perfect timing. For controlled short speech, approximately ±1 second is the initial human production-testing tolerance for spoken boundaries. It is provisional, not a universal guarantee, and requires manual production-style validation.

### Dependencies and Out of Scope

Gemini remains the only paid AI/API dependency for this phase. Do not add Deepgram, AssemblyAI, paid Whisper APIs, AWS Transcribe, paid Google Speech-to-Text, or another paid transcription/media SaaS.

No self-hosted STT is needed now. A future investigation of open-source options such as whisper.cpp or faster-whisper is justified only by measured production evidence of timing/transcription accuracy, quota/availability, latency, or cost limitations.

3A.5C-B does not include speaker identity/diarization as a product feature, mixed visual/speech boundaries, multi-moment composition, highlights/reels, transcript editing UI, subtitles/captions, translation, dubbing, audio cleanup, music sync, embeddings/vector databases, or a new paid service.

### Production Sign-Off and Realistic-Media Performance Follow-Up

Production acceptance A–O passed on revision `3f1490d1786facfdcd3ce113ee9b6070646ec7b9`. The final automated state was:

- `npm run test:jobs` — 84/84 PASS
- `npm run lint` — PASS except the existing unrelated `<img>` warning in `src/app/editor/page.js`
- `npm run build` — PASS locally
- `git diff --check` — PASS

Two production-found exact-phrase matcher fixes are part of this completed phase:

- `465f9f6244cf7160bf3ba82d63c52fa0f775d23d` — `Fix duplicate spoken phrase matches`: normalized exact occurrences are collected first; near-exact fallback runs only when there are no exact occurrences, while genuinely repeated exact phrases remain ambiguous.
- `3f1490d1786facfdcd3ce113ee9b6070646ec7b9` — `Fix normalized spoken phrase matching`: bounded contiguous windows of original Gemini word annotations are normalized as whole text, compared with the normalized target, and retain the original first/last annotation timestamps. This handles normalization cardinality changes such as `I'm a solo founder` without collapsing genuine repeats.

Deterministic normalization remains conservative and production-proven for `$12` ↔ `twelve dollars`, supported contractions such as `I'm` ↔ `I am`, and the narrowly supported `Clip or Not` ↔ `Cliponaut` compatibility case. It is not general fuzzy semantic equivalence. Exact normalized matches always take precedence over near-exact fallback.

Semantic spoken requests such as `Use the part where I explain pricing.` operate over canonical transcript segments. Gemini may identify a coherent discussion through stable segment IDs, never authoritative timestamps; the server validates those IDs and derives the authoritative range. This preserves the distinction between the spoken and visual routing paths, the strict global 0 / 1 / 2+ candidate safety rule, and final-planner protection of the authoritative spoken sequence.

No database, Railway service, durable-job model, or FFmpeg architecture was introduced for C-B. Job-scoped cancellation remains shared across planning and rendering; transcription and semantic matching use bounded transient retries, and temporary extracted audio and Gemini files are cleaned up best-effort. Cancellation remains expected cancellation rather than ordinary job failure.

Short fixtures establish semantic correctness only. After basic acceptance, separately test realistic workloads—such as a five-minute source and multiple five-minute sources—and record upload, extraction, transcription, transcript matching, planning, rendering, total latency, retries, CPU/RAM, and Gemini request usage. Do not infer paying-user long-media performance from short-fixture results.

## Phase 3A.5C-C — Multi-Moment Composition

Status: `✅ COMPLETE`

Purpose:

Combine multiple independently described visual and spoken moments into one ordered edit while preserving server-authoritative source IDs, ranges, ordering, validation, and existing V2 execution behavior.

### Supported Composition Behavior

Phase 3A.5C-C supports ordered compositions of 2–5 independently localized moments.

Moments may include:

- visual event segments
- exact / normalized spoken phrases
- semantic spoken sections
- combinations of visual and spoken moments
- multiple moments from the same source
- multiple moments across different explicitly scoped sources

Representative prompts include:

> From video 1, use the part where the person walks through the temple, then from video 2, use the part where the person is talking to the camera.

> Use the part where I say "customer support", then the part where I say "twelve dollars".

> From video 1, use the part where the person walks through the temple, then from video 2, use the part where I explain pricing, and make it black and white.

The requested order is authoritative. Cliponaut must not sort localized moments by source timestamp.

### Architecture and Safety

Each requested moment is localized independently using the existing Phase 3A.5C-A visual path or Phase 3A.5C-B spoken path.

The resulting server-authoritative moment sequence is converted into one V2 `sequence` operation.

The final planner may preserve supported global operations, but it must not change:

- localized source IDs
- localized start/end ranges
- requested sequence order
- number of accepted moments

Composition parsing is quote-aware so separator phrases inside quoted speech do not accidentally split or reroute the request.

Atomic safety remains strict:

- every requested moment must resolve successfully
- one ambiguous or unmatched moment rejects the entire composition
- no partial composition may render
- repeated exact spoken phrases remain ambiguous rather than selecting the first occurrence
- unsafe source-scoped non-sequence operations are rejected across multi-source compositions

The existing V2 validator and executor remain authoritative.

### Mixed-Frame-Rate Production Fix

Initial Production Test A exposed a shared FFmpeg concat issue rather than a C-C planning failure.

Production FFmpeg `5.1.9-0+deb12u1` reproduced extreme frame duplication when concatenating mixed 24 fps and 30 fps inputs without an explicit output FPS policy.

The executor fix added:

`-fps_mode vfr`

specifically to shared concat output.

Production negative control without this option reproduced the runaway. With explicit VFR, the same synthetic mixed-rate concat completed normally.

Implementation commits:

- `18ef583e58027b9f30070c1335d82c80bce871b2` — Add multi-moment composition
- `6edd50841ff5ca1e7e4c81dadcb0255d653fcb89` — Fix mixed frame rate sequence concat

Final automated verification:

- `npm run test:jobs` — 95/95 PASS
- `npm run lint` — PASS except the existing unrelated `<img>` warning
- `npm run build` — PASS
- `git diff --check` — PASS

### Production Sign-Off

Production acceptance completed on revision:

`6edd50841ff5ca1e7e4c81dadcb0255d653fcb89`

Six final acceptance and regression jobs passed:

1. Visual + Visual composition
2. Exact spoken composition in reverse source chronology
3. Mixed visual + semantic spoken composition with global black and white
4. Atomic rejection when the second moment is ambiguous
5. Phase 3A.5C-A single visual regression
6. Phase 3A.5C-B single spoken regression

The mixed-frame-rate concat runaway did not recur.

No known blocking regression remains.

---

## Phase 3A.5C Final Sign-Off

`Phase 3A.5C — Semantic Moment Selection: ✅ COMPLETE`

Cliponaut can now:

- identify which uploaded source the user means
- find visually described moments inside footage
- find exact and semantic spoken moments
- combine multiple independently localized moments
- preserve requested sequence order
- mix visual and spoken localization in one edit
- safely reject ambiguous compositions atomically
- layer supported global operations over the authoritative composition

Phase 3A.5C is complete because implementation, automated verification, deployment, production acceptance, and regression coverage for C-A, C-B, and C-C have all passed.

---

# Phase 3B — Text, Captions & Audio

Status: `✅ COMPLETE`

Purpose:

Extend Cliponaut's natural-language editing model beyond basic single-style titles into a reusable text, typography, caption, and basic audio system.

The goal is not to recreate every desktop-editor control immediately. The goal is to build foundations that preserve Cliponaut's long-term product direction:

> ChatGPT for video editing.

Users should be able to describe the visual intent they want without needing to know exact editor terminology, font names, or implementation details.

Phase 3B is divided into:

- Phase 3B-A — Text & Typography Engine
- Phase 3B-B — Captions / Subtitles
- Phase 3B-C — Basic Audio Controls

Uploaded music, additional audio tracks, beat syncing, audio ducking, and multi-track audio composition are not part of the current Phase 3B scope.

---

## Phase 3B-A — Text & Typography Engine

Status: `✅ COMPLETE`

Purpose:

Replace the current single-style title model with a reusable rich-text foundation that can later power both titles and subtitles.

### Core Product Behavior

Cliponaut should support natural-language requests such as:

> Add the title "Trip to Kerala" at 0:03 using Instrument Serif.

> Add "Trip to Kerala" at 0:03. Keep "Trip to" clean and simple, but make "Kerala" elegant and larger.

> Make "Trip to" Helvetica-style and white, while "Kerala" uses an editorial serif and #45A049.

> Use a fun font for the title.

> Use a retro-style font and make the video feel retro too.

> Use a gaming-style font for the title.

> Use a classy, elegant font.

Users should not be required to know exact font names.

### Rich Text Model

A text layer may contain multiple independently styled runs.

Example:

`Trip to Kerala`

may resolve to:

- `Trip to ` — clean sans-serif, 48 px, #FFFFFF
- `Kerala` — editorial serif, 58 px, #45A049

The engine must not assume that one title has only one:

- font
- size
- color
- weight
- style

Multiple text layers must also be allowed in the same edit.

### Font Architecture

The existing hardcoded three-font model must evolve into a scalable font catalog.

The catalog should:

- support a broad set of legally usable font assets
- allow new fonts to be registered without rewriting the text engine
- include searchable semantic metadata / tags
- support exact font-name lookup when available
- support semantic style lookup when the user describes a visual intent instead of a font name
- provide deterministic fallback behavior when an exact requested font is unavailable
- never allow the AI planner to invent an unavailable font file

Representative semantic tags may include:

- clean
- minimal
- sans-serif
- serif
- editorial
- elegant
- luxury
- playful
- fun
- handwritten
- retro
- vintage
- 70s
- 80s
- 90s
- gaming
- futuristic
- technical
- cinematic
- bold
- condensed
- mono
- display
- documentary

The initial catalog does not need to contain every font in existence.

The architecture must make adding additional supported fonts primarily a catalog / asset operation rather than an editor-core rewrite.

Custom user-uploaded fonts may be added in a future phase.

### Semantic Font Selection

When the user specifies an exact supported font:

> Use Instrument Serif.

the exact valid font should be used.

When the user describes an intent:

> Use a classy font.

the AI may interpret the semantic typography intent, but the server must resolve that intent only against registered font metadata.

Do not add a separate Gemini call solely for font selection if the existing planning flow can carry the typography intent.

Principle:

> AI interprets. Server validates. Renderer executes.

### Colors

Text colors must support:

- arbitrary validated six-digit HEX colors such as `#FFFFFF`, `#677DEC`, `#45A049`
- existing named colors such as white, black, red, yellow, etc.

Invalid color values must be rejected safely.

Different text runs inside one layer may use different colors.

### Sizes

The engine must continue understanding convenient natural-language sizes such as:

- small
- medium
- large

It should also support explicit validated numeric font sizes.

Different runs inside the same text layer may use different sizes.

### Positioning

Phase 3B-A should support at minimum:

- top-left
- top-center
- top-right
- center-left
- center
- center-right
- bottom-left
- bottom-center
- bottom-right

Arbitrary visual-object-relative placement such as:

> Put the title above the person's shoulder.

is not required in this phase.

### Timing Semantics

Unqualified timestamps refer to the final assembled output timeline.

Example:

> Add "Trip to Kerala" at 0:03.

means:

`00:03` of the final edited video.

It must not mean:

- 00:03 of every uploaded source
- automatically 00:03 of source-1
- 00:03 of each clip independently

Text rendering should occur in a timeline stage where trim, speed, sequence, and composition operations cannot silently shift the requested final-output timestamp.

Explicit source-relative text timing may be added separately once source-to-output timeline mapping is formally supported.

### Backward Compatibility

Existing title prompts must continue working.

Examples include:

> Add the title "Trip to Kerala" at 0:03.

> Use Instrument Serif and add the title "A Day In Kerala" at 0:05.

Existing:

- title text
- start time
- default duration behavior
- supported legacy fonts
- named colors
- simple size words
- existing title positioning

must not regress.

### Renderer Direction

The current one-`drawtext`-filter-per-title model is not sufficient for the long-term rich-text requirements.

Phase 3B-A should introduce a renderer architecture capable of:

- inline font changes
- inline size changes
- inline color changes
- multiple text runs
- multiple text layers
- reuse by Phase 3B-B captions

ASS/libass or an equivalently capable deterministic server-side text-rendering approach is preferred over continuously extending a brittle single-style `drawtext` representation.

The final implementation must remain compatible with the production Railway FFmpeg environment.

### Out of Scope for 3B-A

Do not expand this phase into a complete motion-graphics editor.

The following are intentionally deferred:

- animated typography
- word-by-word caption highlighting
- gradients
- text masks
- curved text
- perspective text
- advanced blend modes
- brand kits
- user-uploaded custom fonts
- arbitrary visual-object-relative placement
- text tracking of moving objects

The architecture should avoid blocking these capabilities later.

### Phase 3B-A Acceptance Criteria

Phase 3B-A is not complete until automated and production testing demonstrates:

1. Existing basic title prompts remain compatible.
2. Arbitrary valid HEX colors render correctly.
3. At least one title can contain multiple differently styled text runs.
4. Multiple independent text layers can render in one output.
5. Exact supported font requests resolve deterministically.
6. Semantic font-style requests resolve only to registered fonts.
7. An unavailable exact font does not cause the AI to invent or reference a nonexistent font asset.
8. Rich text supports different font, size, and color values inside one title.
9. Nine-point positioning works safely.
10. Unqualified timestamps are interpreted against the final output timeline.
11. A title timestamp remains correct when the same job includes sequence / composition and temporal editing.
12. Existing trim, sequence, semantic moment, color, zoom, speed, fade, and crop behavior does not regress.
13. The implementation does not introduce a separate AI call solely to choose a font unless production evidence shows it is necessary.
14. The production Railway FFmpeg environment successfully renders the chosen rich-text format.
15. Invalid font, color, size, timing, or positioning values fail validation rather than reaching FFmpeg unsafely.

Phase completion requires production acceptance, not only local tests.

### Phase 3B-A Completion Sign-Off

Phase 3B-A is production accepted.

Implementation commit:

`c9f0e5b17d16771f8c9ced88354f212dcd18ea6c`

Production blocker fix:

`28b9fdb672fda9155911d276d12aff5d5a392b1b`

Completed capabilities include:

- backward-compatible legacy titles
- reusable rich-text runs inside one title
- multiple independent text layers
- scalable server-side font catalog
- exact supported font resolution
- semantic font-style resolution against registered fonts only
- arbitrary validated six-digit HEX colors
- run-level fonts, colors, sizes, and weights
- nine-point title positioning
- ASS/libass deterministic server-side rendering
- escaped user text and Unicode-safe rendering
- final-output timeline semantics for title timestamps
- title timing preserved through sequence, trim, and speed operations
- no separate Gemini call solely for font selection

Automated verification after the production blocker fix:

- `100/100` job/editor tests passed
- lint passed with only the existing unrelated `<img>` warning
- production build passed
- `git diff --check` passed

Production acceptance verified:

- ASS/libass rendering with bundled fonts
- legacy title compatibility
- HEX color + exact font + bottom-right placement
- semantic font intent
- mixed rich typography within one title
- multiple independent text layers
- final-output title timing after trim + speed
- final-output title timing across an explicit multi-source sequence
- existing black-and-white editing regression

The final multi-source acceptance job:

`8e14d85d-835d-4ff2-8003-d7ec91de9326`

produced an approximately `6.016s` output with:

`source-1 → source-2`

and rendered `SECOND HALF` on source-2 at approximately output `0:04`, confirming that unqualified text timestamps use the assembled final-output timeline.

A production parsing defect discovered during acceptance caused explicit phrases such as:

`first 3 seconds of video 1`

to be misread as semantic references such as:

`seconds of video`

The focused fix in `28b9fdb` prevents explicit numeric source references from entering semantic source classification while preserving legitimate semantic source descriptions.

Final result:

`Phase 3B-A — Text & Typography Engine: ✅ COMPLETE`

`Phase 3B — Text, Captions & Audio: ✅ COMPLETE` — Phases 3B-A, 3B-B, and 3B-C have completed production acceptance.

---

## Phase 3B-B — Captions / Subtitles

Status: `✅ COMPLETE`

Purpose:

Reuse the Phase 3A.5C-B transcription infrastructure and the Phase 3B-A text engine to render synchronized subtitles.

Initial scope should include:

- automatic subtitles from existing speech transcription
- correct transcript timing
- readable default caption styling
- font selection
- HEX / named colors
- caption size
- caption positioning
- compatibility with trims
- compatibility with semantic moment selection
- compatibility with multi-moment composition
- burned-in subtitles in exported MP4
- editable structured caption data before final rendering
- targeted subtitle text correction by timestamp and/or matching text
- global subtitle find-and-replace across all caption cues
- preservation of existing caption timing when only text is corrected
- safe failure when the requested subtitle text cannot be matched confidently

Example correction prompts should include:

> Change the subtitle "I am the founder of clip or not" to "I am the founder of Cliponaut" at 0:07.

> Change "clip or not" everywhere to "Cliponaut" in the video.

Subtitle correction must modify caption text only. It must not alter the underlying spoken audio.

When a timestamp is provided, the correction should target the matching cue at or around that final-output timestamp.

When the user explicitly says "everywhere", the correction should apply to every matching caption cue.

If multiple possible matches exist and the user did not provide enough information to disambiguate them, Cliponaut should fail safely rather than edit an arbitrary cue.

Titles may be expressive while subtitles should default to highly readable typography unless the user explicitly requests otherwise.

Deferred:

- karaoke / word-by-word highlighting
- translation
- bilingual captions
- speaker identification
- caption animation presets
- manual caption-editor UI

### Phase 3B-B Completion Sign-Off

Completed capabilities:

- automatic burned-in subtitles from existing transcription
- readable defaults, supported font selection, HEX / named colors, subtitle size, and positioning
- correct timing through trim and speed
- multi-source sequence compatibility and title + caption coexistence
- editable structured cues before rendering
- targeted subtitle correction and global subtitle replacement
- timing preservation during text-only corrections with unchanged underlying audio
- safe matching/correction behavior
- ASS/libass rendering reused from 3B-A

#### Core Production Acceptance

- A — basic subtitles — PASS — Job: `8de981a1-db70-4fe6-a3c1-1335861defb6`
- B — styled subtitles — PASS — Job: `72fd0921-c161-4dc0-8eb3-c131e6cb5ff5`
- C — trim + captions — PASS — Job: `3b26e009-953f-4051-b9ba-b864f1a59f25`
- D — speed + captions — PASS — Job: `f9d00c24-8a8f-4b25-a9f5-4e771827740b`
- E — multi-source sequence + captions — PASS — Job: `0cf2e817-29e3-4409-b94c-ebbc26f2a85a`
- F — targeted subtitle correction — PASS — Job: `9a2d2c2a-8285-4aaa-aeae-e2dcd4c135ca`
- G — global subtitle replacement — PASS — Job: `71db31f4-e319-4e5f-ace5-a3ef0d492d36`
- H — title + captions coexist — PASS — Job: `eeecb631-b8f8-4fec-976c-e7b09a2a5188`
- R — non-caption regression — PASS — Job: `0f8712fa-7d70-4db8-a179-8b142d6fa91b`
- I — no-usable-speech fixture — SKIPPED because no convenient dedicated silent fixture was used for this acceptance batch.

#### Correction Planner Blocker

Initial F/G attempts failed before rendering with `This edit is not supported yet` because server-authorized caption reconciliation occurred after the planner's empty-operation unsupported check.

Fix:

`d7b9c2a423c2f6280e1cd56ba8e2ef339477e4f4`
`Fix subtitle correction planning`

After deployment, both F and G passed.

#### Caption-Render Investigation and Cleanup

Temporary pixel-render diagnostics proved that styled captions were present in the final artifact when inspected inside actual cue intervals. The heavy runtime pixel diagnostics were removed after acceptance in:

`179c3c119008dcc505635e09cdba17655fdbc2d5`
`Remove heavy caption render diagnostics`

Lightweight caption diagnostics and automated pixel-render regression coverage, including exact `854x480` production geometry, remain.

Post-cleanup smoke test:

Job: `5bbd1e3f-dda8-438b-b3dd-46ae646d82bc`

`3B-B POST-CLEANUP SMOKE PASS` — 17.03s output; burned-in subtitles visible and synchronized; audio/video playable; lightweight diagnostics present; heavy pixel-difference diagnostics absent.

`Phase 3B-B — Captions / Subtitles: ✅ COMPLETE`

---

## Phase 3B-C — Basic Audio Controls

Status: `✅ COMPLETE`

Purpose:

Add a deliberately small set of natural-language audio controls without introducing a multi-track audio editor.

Initial scope:

- mute
- explicit volume adjustment
- increase / decrease volume
- audio-only fade in
- audio-only fade out
- correct audio behavior through existing trim / speed / sequence / composition operations

Representative prompts:

> Mute the video.

> Reduce the volume to 50%.

> Make the audio quieter.

> Fade the audio out at the end.

### Operation Model

`audio_volume` is a global final-output operation:

```json
{
  "type": "audio_volume",
  "factor": 0.5
}
```

- maximum one operation
- never source-scoped in 3B-C
- finite factor range: `0` to `2`
- `0` mute, `1` unchanged, `0.5` 50%, `1.5` 150%
- deterministic relative defaults: quieter / lower / decrease → `0.5`; louder / increase → `1.5`

`audio_fade` is a global final-output operation:

```json
{
  "type": "audio_fade",
  "mode": "out",
  "duration": 1
}
```

- maximum one operation
- never source-scoped in 3B-C
- modes: `in`, `out`, `both`
- reuses existing safe fade-duration limits unless implementation establishes a concrete reason not to
- may coexist with `audio_volume`

### Timeline and Compatibility Rules

Audio controls operate on the assembled final-output timeline after sequence / merge, visual operations, trim / speed, titles, and captions. They must compose safely with trim, speed, explicit sequences, semantic moment selection, multi-moment composition, titles, and captions.

The existing `fade` operation remains unchanged: `Fade out at the end.` continues to fade both video and audio. `Fade the audio out at the end.` is audio-only and must use `audio_fade`.

Implementation may combine audio filters into one FFmpeg pass where safe, and should avoid unnecessary video re-encoding.

Deferred:

- uploaded music / replacement music / additional audio tracks
- per-source or per-clip volume
- arbitrary time-ranged volume automation / keyframed volume
- audio placement against individual output clips
- music looping
- automatic music selection
- ducking
- beat syncing
- AI noise removal
- silence removal
- speaker isolation
- dubbing
- multi-track audio timeline editing

These deferred capabilities should only be designed when product demand justifies the additional timeline and mixing architecture.

### Production Acceptance Matrix

- A — mute — PASS
  Job: `83a2d07c-0497-4097-b2e1-29296976bc10`
  Evidence: mean −91.0 dB, AAC retained, playable.
- B — exact 50% — PASS
  Job: `32be45f9-daf4-451d-be88-d106782dc278`
  Evidence: baseline −38.2 dB → −44.4 dB, approximately −6.2 dB.
- C — quieter — PASS
  Job: `117dd9b6-61a9-4677-8063-616f01fc1bbb`
  Evidence: −44.4 dB mean / −12.6 dB peak, consistent with factor 0.5.
- D — louder — PASS
  Job: `500c153a-841b-4dba-8181-1d1682d7baa6`
  Evidence: −34.9 dB vs −38.2 dB baseline, +3.3 dB, consistent with factor 1.5; no clipping evidence.
- E — audio fade-in — PASS
  Job: `e6b3ee3f-8eb2-4a1a-b18a-af8f096d68b3`
  Evidence: first second −72.9 dB; normal section −36.3 dB.
- F — audio fade-out — PASS
  Job: `5a4909a7-9368-4d90-adff-d99cf459d5e7`
  Evidence: mid-video −36.3 dB; final second −60.6 dB.
- G — 50% + audio fade-out — PASS
  Job: `175b3989-d4a6-4fa7-955c-b46673eaa1d7`
  Evidence: mid-video −42.3 dB; final second −66.6 dB.
- H — trim + audio — PASS
  Job: `6ab40126-5983-4700-88c9-8b1108b22a41`
  Evidence: 10.005s; opening section retained; audio consistent with 0.5 gain.
- I — speed + audio — PASS
  Job: `709eba2b-a5f0-49da-9835-448bd93ad409`
  Evidence: 11.433s at 1.5x; audio consistent with 0.5; playable and synchronized.
- J — multi-source sequence + global audio — PASS
  Job: `524be2e1-fae3-4fb6-b86a-0c7f1bc4a92c`
  Evidence: 6.016s; correct source order; approximately −5.8 dB and −6.2 dB across the two source sections.
- K — semantic/multi-moment composition + global mute — PASS
  Job: `868c5a7f-6a8a-44e3-b5c7-5cb7f9f92823`
  Evidence: correct temple-walking → talking-to-camera order; AAC retained; −91.0 dB full-output mean/peak.
- R1 — legacy audiovisual fade — PASS
  Job: `9d9df021-24c1-4efa-a97a-07fa2b55bbd1`
- R2 — black-and-white regression — PASS
  Job: `d36b9651-360c-4cad-9653-1d8c729efd30`
  Evidence: ~17s playable black-and-white output; no unintended audio-control behavior.
- R3 — captions + audio — PASS
  Job: `7c716b5b-9f25-480d-80f8-33ddcf4daa34`
  Evidence: 5 source cues → 5 final cues; first cue 1.9–4.3s; last cue 13.2–15s; no renderer warnings; `captionsRendered: true`; `audioOnlyPostProcessApplied: true`; `audiovisualFadeApplied: false`; artifact recovered and audio measured.

### Phase 3B-C Completion Sign-Off

Completed capabilities:

- server-authoritative global `audio_volume`, including deterministic mute, exact percentage, quieter, and louder behavior
- audio-only fade in/out, including coexistence of volume and audio fade operations
- backward-compatible audiovisual `fade` behavior
- final-output timeline semantics compatible with trim, speed, explicit sequence, semantic and multi-moment composition, and captions
- video stream-copy during audio-only post-processing where safe

Automated verification after upload hardening: `117/117` job tests passed; lint, production build, and `git diff --check` passed. No multi-track audio, music, ducking, or beat-sync scope was added.

Initial Batch 1 testing exposed intermittent browser multipart-upload failures before worker pickup. This was not an audio-engine failure. The acceptance fix was:

`c31aac21672c24302591a973d7e10f5cc5c0c266`
`Harden direct multipart uploads`

It added a maximum of three PUT attempts, 500ms/1000ms backoff, retries for network failures/408/429/5xx only, no retries for ordinary permanent 4xx responses, abort-aware retry waiting, successful-confirmation-only progress accounting, and safer network-vs-HTTP diagnostics. The remaining acceptance jobs completed after deployment without recurrence of the original direct-upload failure.

`Phase 3B-C — Basic Audio Controls: ✅ COMPLETE`

---

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
