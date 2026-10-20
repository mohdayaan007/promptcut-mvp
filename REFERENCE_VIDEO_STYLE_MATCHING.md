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

## RV-2A internal target-aware render proof

RV-2A is an internal-only bridge from a strictly validated RV-1 signature to the
existing B2A reference-style-treatment operation and B2B title renderer. It accepts
exactly one target source and one server-bound reference descriptor with kind video,
signature version, and evidence version. The trusted worker must bind those artifacts
to the same job/reference; the pure transfer function validates their structure and
version but cannot establish database provenance by itself. The reference is never
inserted into the source catalog, sequence, audio graph, or output.

Photographic transfer is only considered when RV-1 has complete, non-conflicting,
persistent palette evidence and the target has validated bounded B2A observations
and metrics. RV-1 evidence is authoritative: its palette and any persistent exposure
or saturation facts build the reference side of the B2A derivation. A richer B2A
reference observation is checked for agreement, never silently substituted as an
unrelated creative profile. Missing fine-grained tonal, highlight, or color-band
facts remain neutral rather than invented. The existing target-aware B2A treatment
builder remains the sole source of renderer-mappable normalized controls and retains
its highlight and skin safeguards. Provisional, conflicting, incomplete, and
scene-specific evidence is reported as needing more evidence; it never becomes a
global grade by itself.

Reference typography can adapt style only when the user explicitly supplies title
text through the existing title parser. User wording, punctuation, case, explicit
timestamp, duration, placement, and supported font choice win over reference
evidence. Opening/closing evidence supplies timing only when the user did not.
RV-2A maps supported font character, weight, prominence, position, and color to the
existing bounded title catalog; it never copies reference wording, claims an exact
proprietary font, or extends a brief title across the target duration. Unsupported
exact fonts and invalid title timing reject safely.

Explicit user instructions outrank reference evidence. An explicit warm/cool request
adapts only competing reference thermal axes while preserving independently supported
photographic structure; ordinary validated operations such as trim and captions may
be passed through in the existing base plan. Conflicting global visual treatments,
duplicate titles, unsupported exact fonts, and empty would-be matching plans reject.
The override is bounded and signed: it cannot silently collapse to neutral or reverse
the requested warm/cool direction, but it retains the independently supported
non-thermal recipe instead of replacing the reference treatment with a blanket
filter. RV-2A accepts only internally consistent creative signatures: persistent and
provisional records must be exact members of the photographic-characteristic set,
their sampled support, coverage, conflicts, and optional trusted provenance must all
agree. Coarse RV-1 palette evidence establishes broad warmth only; it cannot invent
fine color-band, highlight, or saturation-character claims. Such details are used
only when explicitly observed in the compatible B2A analysis. A central request to
match the reference rejects when the required photographic evidence is insufficient;
an ordinary trim or caption operation cannot turn that into a partial claimed match.
Missing RV-1 exposure, saturation, contrast, or richer color/tonal evidence is not
silently converted into a `medium`, `natural`, or neutral creative target: the
corresponding recipe axis remains neutral. Persistent broad palette evidence can
still authorize only its bounded warm/cool direction, while persistent exposure,
saturation, and contrast evidence can authorize their matching canonical axes.
Reference title styling is similarly limited to a user-authorized title clause and
applies field-by-field, so unrelated prompt wording cannot accidentally override a
reference-derived title style or invent title text. Quoted title wording is literal:
punctuation and style-like words inside the quote do not become style commands.
Unsupported central requests such as exact transition cloning, subject-aware
reframing, camera movement, transition matching, editing-rhythm copying, composition
recreation, pacing reconstruction, or cut
reconstruction reject rather than return a misleading matched result. Composition,
rhythm, and transitions remain observational until a validated renderer capability
exists. Diagnostics distinguish applied, adapted, needs-evidence, unsupported, and
rejected decisions without exposing private media data. RV-2A has synthetic-signature
local validation only; real Gemini interpretation and creator-reference evaluation
remain the next integration boundary.

The internal proof uses generated 854×480 target fixtures with audio and a
controlled signature. It separately verifies a photographic-only render with
an RGB pixel comparison (so a hue-preserving-luma transfer cannot be mistaken
for a no-op), and a nonzero-time title render with no title pixels before its
requested interval. The existing executor preserves the original target audio
and aspect ratio; reference video/audio never enter the render plan. This proves
only renderer integration for a synthetic signature, not that real creator
references have been interpreted or matched successfully.

## RV-2B internal Gemini observation adapter

RV-2B adds an internal-only, one-call Gemini adapter between RV-1's bounded
JPEG evidence and its existing strict observation validator. It sends only the
server-extracted JPEG bytes as direct inline `image/jpeg` parts together with
server-owned frame IDs, shot IDs, timestamps, shot boundaries, and evidence
limits. It never uploads a persistent Gemini File, sends reference audio,
exposes local paths or storage URLs, or asks the model for filters, plans,
LUTs, or exact fonts. The model returns a versioned descriptive observation
document: `safe` plus only the RV-1 photographic, typography, composition,
rhythm, and transition fields. `unknown` is required whenever the sampled
evidence cannot establish a characteristic.

The adapter permits exactly one request and no automatic retry. The locally
installed `@google/genai` 2.20.0 SDK supports
`automaticFunctionCalling.disable`; RV-2B sets it to `true` and supplies no
tools, so its automatic function-calling continuation loop is disabled rather
than merely assumed absent. The full
deadline covers bounded JPEG loading, the injected model request, and response
validation. A pre-aborted or cancelled operation returns a cancellation reason;
an elapsed deadline returns a distinct timeout reason. The injected SDK adapter
receives the same abort signal and must honor it to terminate underlying I/O.
Client-side cancellation can stop the request locally but cannot guarantee that
a provider has not already started processing or incurred a charge.
Responses are capped by the existing RV-1 payload limit, then validated against
the strict server-owned evidence manifest. Invented frame/shot IDs, invalid
intervals, overlaps, malformed JSON/schema, empty evidence, excessive
responses, and provider errors reject safely.

Reference safety remains fail-closed. The single bounded response must declare
`safe`; a false or unverifiable result is rejected before creative observations
are accepted, with the concise user-facing message “This reference can’t be
used for style matching. Please choose another image or video.” The schema
allows ordinary non-explicit fashion, swimwear, kissing, portraits, and
lifestyle media. It does not expose a moderation taxonomy to users. Because
one bounded request is the cost/privacy budget, safety and descriptive data are
returned in the same schema, but the server discards every observation before
aggregation when safety fails.

RV-2B is not public worker/UI activation and is not creator-fidelity proof.
Mocked integration tests exercise real FFmpeg temporal extraction, direct
inline request construction, strict validation, signature aggregation, and
RV-2A consumption. A separately authorized live evaluation with actual creator
reference videos, approved credentials, and controlled output review is still
required before claiming real-model creative-match quality.
