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

## Next task: RV-1

Implement **RV-1 — multi-shot reference-video understanding**: bounded frame/moment extraction from RV-0 validated video, safe multi-moment observation schemas, deterministic temporal aggregation, and tests proving a persistent style is not inferred from a single incidental frame. It must remain server-authoritative and must not enable unsupported rhythm, composition, or transition rendering.
