# Phase 4 acceptance — October 26, 2026

**Release verdict: NOT ACCEPTED. Hosted conversational acceptance is blocked, not proven failed or successful.** PR #5 remains draft. Do not merge, enable public Phase 4, or deploy these changes without explicit founder approval.

Engineering fix commit: `1e07a0bb6ff435f906cd5b075c53e3de4a4254a7` on `feature/phase4-conversational-editing`.

## Baseline and access

- Read PR #5 and its October 26 hosted-testing handoff, including [the second-turn ambiguity report](https://github.com/mohdayaan007/promptcut-mvp/pull/5#issuecomment-6409685125). The earlier screenshot was captured during rendering; it is not a final-duration measurement.
- Railway web configuration and worker configuration both explicitly pin `c5a8af84fcc155812ed0253201603374edd33f4f`. Current successful web deployment: `af99fc6e-15d2-48a9-be84-43d244f3779b`; worker: `d4c808cf-5e48-40da-9fa0-debb0dc4c991`. The web deployment ID supersedes the older ID in the handoff while keeping the same commit.
- Original supplied file was read locally: `Ahmed Perfumes Testing.mp4`, 22,847,340 bytes, 1280×720 H.264, AAC, duration **34.738078s**, video stream 34.738078s, audio 34.644771s, nominal 30 fps. Stream metadata reports 1,017 video frames; variable timing must not be inferred from nominal fps alone.
- Founder entered the access code directly on the site and reported signed in. No secret was requested in chat or read from Railway variables.
- A fresh Ahmed upload was started with the exact first prompt. Job `4a68a473-e65a-4853-b508-afb13ed796b4`; web logs show upload-session creation at **12:06:40 IST / 06:36:40 UTC**. The browser still showed uploading at the last observation. No final output was downloaded.
- Browser/computer-control tools became unavailable during this run. That prevents inspecting the founder's existing second edit, completing the fresh hosted chain, gathering screenshots, and testing responsive layouts. No workaround read cookies or browser storage.
- No production migration, configuration change, deployment, storage deletion, concurrency change, public enablement, main-branch merge, RV work, or Dodo work was performed.

## Acceptance matrix

`BLOCKED` means missing required evidence, not a demonstrated product failure. A release requires all mandatory hosted rows to pass.

| Check | Result | Evidence and limit |
| --- | --- | --- |
| Existing founder's second edit completed | BLOCKED | HTTP 200 in the handoff only confirms acceptance. Existing job/session output remains inaccessible to this run. |
| Existing founder's finished output is approximately 10s | BLOCKED | No downloaded final MP4 from that session. |
| Existing founder's first five seconds removed from previous edit | BLOCKED | No source/output frame or audio comparison from that session. |
| Fresh hosted Ahmed semantic selection | BLOCKED | Exact prompt submitted; upload accepted; no final result observed. Initial founder-reported 15s result remains historical evidence only. |
| Output-relative start cut in deterministic renderer | PASS, local | Eight independent MP4s; 15.000s selection → 10.000s start-trimmed result. Correct-side frame and audio comparisons below. |
| Black and white → cinematic → normal | PASS, local | Exact requested follow-up wording, separately rendered artifacts, single style, original grade restored, 10s cuts retained. Not hosted Ahmed acceptance. |
| More than five turns | PASS, local | Eight independent renders; existing 25-turn cumulative plan regression also passes. Not 25 worker jobs or eight hosted turns. |
| Real PostgreSQL same-version concurrent submissions | PASS, local | One accepted, one 409 under a real row lock. Knowing the pending version also returns 409 rather than queuing another delta. |
| Follow-up after failed render | PASS, local | Real multipart storage upload → actual worker → completed MP4 → deliberate disposable-storage failure → previous download retained → restored source → successful follow-up. |
| Persisted session/version history and ownership | PASS, local | Actual session GET/POST handlers against PostgreSQL; expired access denied; ordinary requests denied by founder gate. Browser refresh behavior remains blocked. |
| Unsupported instructions preserve prior state | PASS, local | 422 without creating a version; compound/negated/scoped fast-path prompts reject atomically. Hosted presentation remains blocked. |
| Undo restoration and continued editing | PASS, local | Rendered component mounts replacement beneath opaque cover; route regression continues from the explicitly selected successful job after Undo. Browser timing/stale-frame checks remain blocked. |
| Retained preview labels and confirmation identity | PASS, local | Actual component rendering labels previous output; same-job repeated completion confirmation is idempotent; follow-up user turns carry job identity. Live duplicate-message cause remains unverified. |
| Ordinary customer upload, render, download | PASS, hosted | Job `1b426dd7-eb57-41ee-adb7-52139031d5d6`; 2.005s monochrome MP4 downloaded, 60 frames, full decode passes. Local integration separately verifies ordinary upload response has no session. |
| Real Ahmed A/V sync across the cumulative chain | BLOCKED | Only original-source metadata available. Synthetic media A/V checks pass below. |
| Hosted refresh, history, failure/cancellation recovery | BLOCKED | Browser tools unavailable. Automated cancellation coverage is not a hosted cancellation test. |
| Hosted download after 15-minute URL expiry | BLOCKED | Initial ordinary download passed; expiry renewal and delayed conversational download not exercised. |
| Desktop responsive and mobile behavior | BLOCKED | No completed viewport checks or screenshots. Build/static rendering do not establish layout quality. |
| Hosted visual/audio creative quality | BLOCKED | Await objective hosted completion before final founder review. |

## Confirmed defects and changes

1. **Legacy trim composed incorrectly.** A prior V1 10–25s trim followed by `Now trim the first five seconds too.` previously created a 5–full-source sequence while retaining the old global trim. That applies a second window and can retain the wrong ending/duration. Existing global trim/merge is now canonicalized into source-relative sequence clips before applying the delta. Regression includes cross-source boundaries and original-plan immutability.
2. **Fast paths dropped user intent.** `Also add black and white and mute it.` previously returned only black and white. Negation and source-specific wording could also become global style edits. Fast paths now require a complete supported instruction or reject safely. This deliberately does not add new compound-command coverage.
3. **Undo replacement could never become ready.** The result video rendered only in normal preview mode, while its readiness handler was conditional on restoring mode. The replacement now mounts under the existing opaque cover only when the restored URL is selected. Static component tests verify old media stays unmounted before replacement selection.
4. **Follow-up ignored Undo-selected state.** The API always used the latest completed server version even when the browser displayed an earlier successful version. Client follow-ups now identify the displayed base job; the API resolves it only within the authenticated session's completed versions. Version numbers stay linear; no new schema, redo, or branching UI.
5. **Pending-version submissions could stack edits on stale successful state.** The version lock rejected simultaneous equal-version requests but allowed a request using the newly queued version before completion. Under the same lock, authoritative job state now rejects another pending delta.
6. **Preview/status recovery lacked clear identity.** Retained output now says `Previous edit (15s)` once metadata is known. Polling avoids overlapping requests; confirmations are keyed by job. Hydration refreshes the server version counter, and recovery retains an available previous preview while reconnecting to an active follow-up. A failed latest attempt remains a failure after restoring its successful media. Browser timing remains a required hosted retest.
7. **Integration assertion compared container headers.** The prior test assumed distinct MP4 renders must have different first 512 bytes. It now compares whole artifacts and still probes downloaded media. The local S3 emulator additionally needed `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`; this was applied only to the disposable test runner, never production.

## Objective media evidence

Fixture: generated 34-second video with changing frames and a time-varying chirp. Initial selection is explicitly seeded at source **10–25s**. This fixture does **not** test Gemini, speech understanding, or Ahmed content selection.

| Turn | Instruction | MP4 duration | Video frames | Audio/video duration difference |
| --- | --- | --- | --- | --- |
| 1 | Explicit fixture selection 10–25s | 15.000s | 450 | 0 ms |
| 2 | Now trim the first five seconds too. | 10.000s | 300 | 0 ms |
| 3 | Also add black and white. | 10.005s | 300 | 5 ms |
| 4 | Make it cinematic instead. | 10.005s | 300 | 5 ms |
| 5 | Bring it back to normal. | 10.000s | 300 | 0 ms |
| 6 | Also add black and white. | 10.005s | 300 | 5 ms |
| 7 | Make it cinematic instead. | 10.005s | 300 | 5 ms |
| 8 | Bring it back to normal. | 10.000s | 300 | 0 ms |

All eight artifacts decode fully with FFmpeg `-xerror`. Frame MSE at output 0.5s:

- Correct reference, previous output 5.5s: **6.066**.
- Wrong end trim, previous output 0.5s: **4,994.656**.
- Wrong original-source 5.5s: **6,269.788**.
- Retained ending, output 9.8s versus previous 14.8s: **3.217**.
- Normal reset versus pre-style trimmed frame: **0**, indicating exact decoded restoration in this fixture.
- Cinematic versus normal: **26.360**, a measurable change; not a creative-quality score.

Audio correlation of previous-output 6–8s against trimmed-output 1–3s: **0.9999988**, best offset **0 samples at 16 kHz**. This verifies the same source timing for that interval; it is not a lip-sync judgment on the real talking-head footage.

Machine-readable evidence: [eight-turn media results](evidence/phase4-media-2026-10-26.json) and [hosted ordinary output probe](evidence/phase4-ordinary-hosted-2026-10-26.json). Generated synthetic MP4s and full logs are retained locally in the checkout's ignored `evidence/` directory; no founder media or signed URL is committed.

## Automated verification

- `npm run test:jobs`: **175/175 PASS**, using the already-installed full FFmpeg build with libass.
- Conversation state, presentation, component rendering, existing FFmpeg conversation test, and founder-access tests: **16/16 PASS**.
- New eight-render media test: **1/1 PASS**.
- Real PostgreSQL session API integration: **1/1 PASS**.
- Real worker + local S3-compatible multipart storage integration: **1/1 PASS**.
- `npm run lint`: **PASS**, zero errors, existing unrelated `<img>` warning in `src/app/editor/page.js`.
- `npm run build`: **PASS**, exit 0. Normal restricted execution failed because the CSS compiler could not bind a local port; the approved local-process execution succeeded.
- `git diff --check`: **PASS**.

The default local FFmpeg lacks the ASS filter and initially failed caption tests. Selecting `/opt/homebrew/opt/ffmpeg-full/bin` resolved this environment mismatch; no caption assertions or production rendering code were weakened.

Local integration used disposable PostgreSQL and S3rver installed outside the repository, loopback listeners, isolated credentials, and no Gemini key. No paid service or permanent infrastructure was created. The integration invokes real route handlers rather than an HTTP browser; distinguish that from hosted E2E.

## Remaining engineering acceptance work

1. Restore browser/computer access to this chat. Inspect the founder's existing completed edit if the browser still retains its session, or resume the fresh accepted upload. Do not request another source video or ask the founder to enter test prompts.
2. Download actual selected and trimmed outputs; collect job/session/version identifiers without tokens. Probe durations/frames, compare start and ending to the prior output, and correlate audio against the prior output offset by five seconds.
3. Complete the exact style chain and at least six hosted turns in the same session. Check a refreshed tab mid-sequence, persisted history, failure/unsupported/cancel recovery, cross-tab version conflicts, and a download after initial signed URL expiry.
4. Verify desktop/mobile layout, previous-output labeling, duplicate-message identity, and Undo cover/readiness in a real browser.
5. If hosted retests require these fixes, obtain explicit approval for the specific code revision before changing the pinned web/worker production revisions. Keep the founder gate private and PR draft. Recheck ordinary-user behavior after any approved release.
6. The founder gate was not disabled: that requires a production configuration change and potentially redeployment. The instruction to disable it appears in the handoff, not in the user's deployment authorization. Request an explicit bounded shutdown approval after the hosted session; never silently redeploy.

## Final founder-review checklist — only after objective hosted checks pass

- Watch the actual approximately 10-second Ahmed output once: does the remaining speech feel acceptable after the intentionally requested start cut, and is the ending natural?
- Compare black and white, cinematic, and normal versions: are the looks visually acceptable, with normal restoring the original color treatment and the same cut?
- Listen once for distracting clicks, unnatural speech, or perceived lip-sync issues.
- Decide whether to accept the creative quality, request a specific aesthetic adjustment, or keep Phase 4 private. Public release and merging PR #5 require a separate decision.

No routine technical testing is delegated back to the founder. Until blocked hosted checks pass, Phase 4 remains incomplete.
