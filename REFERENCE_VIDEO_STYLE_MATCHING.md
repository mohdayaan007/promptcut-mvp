# Reference-Video Style Matching

## RV-0 foundation

Reference-video matching is separate from editable source media. A job may have one private `reference` attachment with a discriminated `kind` of `image` or `video`; only ordered `sources` receive `source-1` through `source-5`, enter V2 sequences, determine export eligibility, or contribute video/audio to output.

RV-0 accepts a bounded video reference only behind the server-side `REFERENCE_VIDEO_STYLE_MATCHING_ENABLED=true` gate, and every new video manifest must explicitly state `kind: "video"`. Existing image callers may omit `kind` for backward compatibility. The public UI remains image reference only. Even when that foundation gate is on, the worker validates decoded media and then stops with a concise unavailable error: it cannot silently run incomplete video matching, insert reference media, or use reference audio.

The contract is one MP4/MOV/WebM/MKV reference, at most 250 MB, 60 seconds, one video stream, at most four total streams, a longer side no greater than 3840, a shorter side no greater than 2160, and no more than 3840x2160 decoded pixels. This accepts both landscape and portrait 4K while bounding memory. Finite frame rate must be plausible (no greater than 120 fps); ordinary VFR media is accepted through its valid average or nominal frame rate.

Browser metadata selects an upload route only. The worker first uses `ffprobe` (maximum 10 seconds) to verify container, duration, dimensions, stream shape, and frame rate. It then uses controller-owned `ffmpeg` children to decode three reduced-resolution representative frames (each bounded to 5 seconds). Frame decoding proves packets can actually be decoded; it is not frame sampling, shot analysis, or style understanding. The existing execution controller cancels the exact active probe/decode child, with its normal termination behavior. These limits bound private-object retention, download/decode load, and future multi-moment analysis while accepting common creator clips.

The worker downloads reference video only to job scratch. Existing abort and retention cleanup include its private reference key, and scratch cleanup remains in the job `finally` path. Cancellation is checked before and after download and through controller-owned subprocess validation. No output, database-history, or public-URL behavior changes.

## Intended multi-shot architecture (RV-1 and later)

A reference video must not be reduced to one screenshot. RV-1 will turn RV-0 media facts into a bounded temporal sampling and shot-analysis plan: multiple representative moments, each with a small frame budget, followed by server-side aggregation. RV-0 exposes a deterministic bounded manifest of temporal windows (`reference-moment-*`) but deliberately performs no sampling, shot detection, Gemini call, proxy render, or treatment derivation.

The eventual analysis has independent observations for photographic look (exposure, tonal structure, palette, contrast, texture), typography (font character, hierarchy, positioning, readability), composition, rhythm (cut density and sustained-versus-fast temporal pattern), and supported transitions. AI may interpret bounded observed facts; the server owns allowed categories, cross-moment aggregation, canonical treatment construction, validation, target constraints, and FFmpeg execution.

B2A image-reference photographic treatment and B2B typography analysis will be reused as components, not incorrectly applied to one incidental video frame. Their outputs remain bounded inputs to one combined validated creative treatment. The target's content, duration, source sequence, aspect ratio, and actual renderer capabilities constrain every transfer. User instructions can narrow or override a reference-derived decision. A minor trait may be omitted only when that does not misrepresent the result; if a central requested style characteristic cannot be reproduced, Cliponaut must explicitly state the limitation or reject the request rather than claim a successful match.

RV-0 does not promise shot reconstruction, arbitrary composition changes, cut or transition cloning, reference-audio transfer, selective subject grading, or execution primitives absent from the renderer. Reference media is private, temporary job input and must never be logged as a path, signed URL, object key, Gemini URI, or content dump. Future stages must bound frame count, decode resolution, model requests, runtime, and retention; handle malformed media, cancellation, quota, timeout, upload failure, and cleanup; and return only safe user-facing errors. Clearly disallowed reference media remains subject to the planned reference-safety policy before analysis or rendering.

## RV-1 internal temporal understanding

RV-1 is internal-only and preserves the product boundary of **one original video,
one reference video, one prompt, one eventual output**. It does not alter normal
multi-source editing outside this workflow. RV-1 analyzes the validated reference
only; it cannot merge, insert, or transfer reference video/audio, modify target
footage, create an edit plan, or create a final MP4.

The deterministic extractor first runs a bounded FFmpeg scene-score scan
(scene > 0.28) to nominate hard visual changes. A second low-resolution
visual-change scan (scene > 0.001, 64px) may nominate overlay/title candidates;
it is evidence of change, not proof of text or a new shot. A deterministic
allocator preserves opening/end evidence, prioritizes distinct shots, then uses
event and coverage anchors without exceeding 18 JPEGs at 320px width. When more
shots exist than the budget can represent, unrepresented shot IDs are recorded and
coverage is explicitly incomplete. The scans are bounded to 12s/8s respectively
and each frame extraction to four seconds with normal controller-owned process
cancellation. RV-1 cannot guarantee discovery of tiny, low-contrast, static, or
brief overlays; absence is uncertainty, not a style claim.

The visual-change scan is partitioned into four small, slightly overlapping
temporal windows with a two-event cap per window. This prevents early camera
motion from consuming the whole event budget before a later title can be sampled.
It still does not establish that an event is typography: motion, flash, and
exposure changes remain only visual-change candidates. If a window fails, evidence
is marked incomplete rather than silently claiming full temporal coverage. A window
that reaches its two-candidate cap is recorded as saturated: scanning succeeded,
but visual-event coverage is incomplete because later candidates in that window may
not have been retained.

Reference inputs retain RV-0's 1080p and 4K landscape/portrait support. Most
evidence stays at 320px wide; at most four event candidates from an input whose
long side is at least 1920 receive bounded 640px inspection. This improves the
chance of retaining meaningful typography, texture, and composition detail without
turning RV-1 into unrestricted high-resolution extraction.

Reference Video Evidence v1 contains ordered non-overlapping server-owned shot and
frame IDs, validated timestamps, bounded coverage state, visual-change events, and
private scratch paths used only inside the worker. Before an internal interpreter
sees a frame, a trusted adapter reads a nonempty JPEG, enforces per-frame and total
request byte limits, and supplies only JPEG bytes plus server-owned metadata.
Paths, URLs, object keys, and image bytes never enter logs or model responses.
Observations must use frames from their own shot and temporally relevant
non-overlapping intervals; unexpected fields, invented IDs, malformed manifests,
and cross-shot evidence reject safely. Typography includes role, font character,
weight, prominence, placement/alignment, and color character; composition includes
framing, balance, title-safe area, subject placement, and negative space.

A supplied internal interpreter is injectable for tests only; RV-1 does not invoke
Gemini in public jobs. Its explicit budget is one request, no retries, a 10-second
abortable deadline, bounded JPEG payloads, and a 64 KB response cap. The adapter
must honor cancellation; timeout/cancellation rejects the caller even if an
untrusted adapter fails to cooperate.

Reference Video Creative Signature v1 deterministically separates persistent
photographic support, opening/closing/recurring typography, scene-specific
treatments, composition facts, objective per-shot rhythm, grounded transitions,
conflicts, and incomplete evidence. Coverage uses unioned supporting intervals and
independent-shot support, reports both full-reference and observed coverage, and
never promotes a tiny single-shot observation into a persistent trait. An isolated
warm scene remains scene-specific in an otherwise cool reference. Rhythm comes
from server-owned shot timing; transitions remain unknown unless grounded at actual
temporal boundary evidence. This signature is creative evidence, never executable
instructions.

Persistent photographic conclusions require both meaningful unioned coverage and
independent sampled support: a model-supplied interval does not turn one frame into
proof that a long shot has a continuous look. Insufficient evidence remains
provisional. The signature preserves palette, exposure, contrast, saturation, and
texture as independent persistent/provisional evidence records with supporting
observation, frame, and shot IDs; a stable cool palette can therefore coexist with
scene-specific contrast or exposure differences. Typography is recurring only when equivalent supported characteristics
repeat across distinct observations; a single middle title is scene-specific.
Opening, closing, sustained, recurring, and scene-specific title evidence are
exclusive categories. Composition patterns likewise require repeated known
support across independent shots and retain supporting observation IDs; unknown
observations cannot create a global compositional identity.

Evidence manifests are strict server-owned timelines: shots are contiguous and
ordered, frames have one deterministic parent shot at a boundary, hard-cut events
must correspond to a shot boundary, and all count/coverage declarations are
bounded and internally consistent. RV-1 can establish bounded extracted evidence,
not real creative-model accuracy; real model evaluation remains required before
any future matching or rendering stage.

The one internal interpreter deadline covers JPEG loading, the one injected
interpretation request, and response validation. Both the loader and interpreter
receive the same abort signal. Production adapters must actually terminate their
underlying I/O on abort; RV-1 can reject the result safely at deadline, but cannot
magically stop an adapter that ignores cancellation.

## RV-2 handoff

RV-2 may combine **Reference Creative Signature + Original Video Characteristics
+ User Prompt** into a validated target-aware creative treatment. It must reuse
B2A photographic and B2B typography capabilities only where evidence and renderer
support exist. Composition, rhythm, and transitions remain observations until a
safe renderer capability exists. If a central requested characteristic cannot be
reproduced, Cliponaut must disclose the limitation or safely reject it; it must not
pretend to have matched the reference.
