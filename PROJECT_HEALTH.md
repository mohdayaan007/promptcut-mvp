# Project Health Audit

**Scope:** Static review of the repository and a lint run. No source, configuration, or runtime behavior was changed. `npm run lint` completed with 0 errors and 1 warning (`<img>` in the editor page).

## 1. Executive Summary

### Overall repository health

**Early-stage MVP; functional but operationally fragile (5.2/10).** The codebase is small, easy to navigate, and has a clear primary workflow. Its main risk is not feature complexity; it is production resilience around arbitrary user uploads and synchronous, disk-backed FFmpeg work.

### Key strengths

- Clear App Router layout: landing page, editor page, and a single processing route.
- A deterministic, understandable processing pipeline with normalized output.
- Minimal application surface area and no database or authentication complexity.
- Docker includes the system FFmpeg executable required by the server route.
- Branching guidance is documented in `AGENTS.md`; `develop` is currently checked out.

### Main areas of concern

- No server-side upload type, size, duration, or media-stream validation.
- Temporary processing directories are never removed, so disk consumption grows over time.
- Requests buffer complete inputs and outputs in memory and run FFmpeg synchronously without capacity controls.
- The two-video merge assumes both clips have audio; valid silent videos can fail.
- There are no automated tests, CI configuration, health checks, or production-operational documentation.
- Deployment and dependency setup contain unused components and a possible port-configuration mismatch.

## 2. Architecture Review

### Overall project structure

The application uses Next.js App Router. `src/app/page.js` is the landing page, `src/app/editor/page.js` is a client-side editor, and `src/app/api/process-video/route.js` is the Node.js endpoint that runs FFmpeg. Global layout, styling, and static assets are in conventional locations.

### Separation of concerns

The browser and server responsibilities are separated appropriately at the route boundary. The processing route, however, combines request parsing, prompt parsing, filesystem work, FFmpeg command construction, orchestration, and HTTP response construction in one 250-line module. This is manageable today but will become difficult to change safely as supported edits grow.

### Folder organization

The source tree is compact and understandable. `public/` includes many generated output MP4s, and `luts/` contains unused assets. These blur the distinction between product assets and generated/development artifacts.

### Scalability observations

The design is inherently single-request, local-disk, CPU-bound processing. It can serve an MVP with short clips, but horizontal scale requires each instance to have FFmpeg, writable temporary storage, enough disk, and enough CPU/memory for concurrent encodes. There is no queue, concurrency limit, durable storage, or job status model.

## 3. Code Quality

### Complexity and readability

- `src/app/api/process-video/route.js` is the main complexity concentration. `POST` handles the complete pipeline; its parser helpers and normalization helper are readable, but the orchestration should eventually be separated into focused modules/functions.
- `src/app/editor/page.js` contains both UI layout and request/state logic. It remains readable at 251 lines, though upload handling, request lifecycle, and chat/status presentation will become coupled as the UI grows.
- Naming is generally clear (`normalize`, `parseTrim`, `processedPath`, `finalVideo`).

### Duplicate, dead, or inconsistent code

- `FFPROBE` is declared but unused.
- `@ffmpeg/ffmpeg` and `@ffmpeg/util` are installed but unused; the app uses system FFmpeg instead.
- Docker installs Python, CPU Torch, and Whisper, but no application code invokes them.
- `luts/*.cube` files are unused by the current filter implementation.
- `public/` tracks numerous output MP4 artifacts; they are not referenced by application code.
- `globals.css` contains a duplicate `.font-serif` declaration and theme variables for fonts not configured by the layout.
- Client-side success text is independently inferred from the prompt; it may report an operation differently from, or more broadly than, the server actually applied (for example, it recognizes “cool” while the server only recognizes “blue”).

### Test and documentation coverage

There are no unit, integration, end-to-end, or API tests, and no CI workflow is present. The README is still the default Next.js boilerplate and does not document local FFmpeg prerequisites, supported prompt grammar, deployment, or verification steps.

## 4. Reliability Review

### Likely runtime failures

- The server accepts any submitted `video1` and relies on FFmpeg to reject invalid media. Browser `accept="video/*"` is not a server-side control.
- The merge filter explicitly references `[0:a]` and `[1:a]`. A valid video without an audio stream can therefore fail during concatenation.
- The title filter escapes apostrophes only. Other drawtext/filter-special characters in user-entered title text can break the FFmpeg filter expression. Because `execFile` is used, this is not shell-command injection, but it is a correctness and availability issue.
- Trim times are not validated against media duration or against each other. Invalid, reversed, or out-of-range ranges can produce FFmpeg errors or unexpected output.
- The temporary directory name uses only `Date.now()`. Concurrent requests created in the same millisecond can target the same directory and filenames.
- `drawtext` depends on FFmpeg font availability/configuration, which is not explicitly provisioned or verified in the Docker image.

### Temporary-file management and errors

Every request creates source, normalized, merged, processed, trimmed, and output files under the OS temporary directory. There is no cleanup in either success or failure paths. Disk usage will accumulate until host/container cleanup or failure. Errors are caught and returned consistently as JSON, but raw `err.message` is exposed to clients and errors are only logged with `console.error`; there is no structured operational context, request identifier, or cleanup path.

### Validation gaps

There are no explicit limits for content length, file size, MIME type, video duration, frame dimensions, codecs, prompt length, or concurrent jobs. The route also does not verify that both form fields are file-like values before calling `arrayBuffer()`.

## 5. Performance Review

- `req.formData()`, `file.arrayBuffer()`, `writeFile()`, and final `readFile()` buffer full media payloads in process memory. Large uploads can cause high memory pressure before FFmpeg begins.
- Each clip is re-encoded during normalization; optional merge, filters, trim, and the final output can add further encodes. This is predictable but CPU-heavy, slow, and can compound quality loss.
- FFmpeg is limited to two threads per invocation, but the server does not limit simultaneous invocations. Multiple requests can still exhaust CPU, memory, disk, or process slots.
- Temporary intermediate files multiply disk consumption per request.
- The Docker image installs unused ML dependencies, increasing image build time and image size.
- Generated MP4s checked into `public/` increase repository clone and deployment artifact size.

## 6. Maintainability

The code is approachable now, but the monolithic server route and duplicated client/server prompt interpretation will become the principal maintenance costs. Prompt capabilities are encoded through ad-hoc string matching rather than a shared, explicit operation model. Adding operations will require coordinated edits across UI examples, user messaging, parsers, FFmpeg filters, validation, and tests.

`AGENTS.md` provides useful working guidance. The README should eventually become project-specific, and a small runbook should document FFmpeg prerequisites, container environment expectations, supported operations, failure diagnosis, and resource limits. Development experience would benefit from reproducible dependency installation, automated checks, and sample-media test fixtures.

## 7. Security Review

- **Input handling:** Unvalidated uploads and unbounded CPU/disk work create a straightforward resource-exhaustion risk for a public production endpoint.
- **File handling:** Files are written only to a server-generated temporary path, so user-provided filenames do not control paths. However, file content and volume are not constrained.
- **Process invocation:** `execFile` with an argument array avoids shell interpolation. User title text is still embedded in an FFmpeg filter expression and needs robust filter escaping/validation to avoid malformed processing commands.
- **Information exposure:** Returning raw processing errors can disclose command, codec, filesystem, or environment details.
- **Access controls:** No authentication, authorization, rate limiting, or abuse controls are present in the repository. This may be intentional for an MVP, but it should be treated as a production capacity/security decision.
- **Secrets and environment:** `.env*` is ignored and no environment variables or secrets are referenced by application code. This is simple, but configuration such as limits, logging, and service endpoints cannot currently be adjusted by environment.
- **Dependency posture:** This review did not run a network vulnerability scan. The lockfile should be included in a routine dependency/security check.

## 8. Priority Roadmap

### HIGH PRIORITY

#### Bound and validate video-processing requests

- **Description:** Define and enforce server-side limits for request size, prompt length, file count/type, media readability, duration, and supported stream characteristics before expensive processing begins.
- **Why it matters:** Current requests can consume unbounded memory, disk, and FFmpeg CPU; invalid input fails late and expensively.
- **Expected benefit:** More predictable production capacity, clearer user errors, and lower abuse/failure risk.
- **Estimated implementation effort:** Medium
- **Risk of implementation:** Medium

#### Guarantee temporary-file cleanup and isolate each job

- **Description:** Use collision-resistant job directories and cleanup in a `finally` path after responding/streaming is safely complete; define operational handling for abandoned jobs.
- **Why it matters:** Current temporary files remain indefinitely, and timestamp-only directory names can collide under concurrency.
- **Expected benefit:** Prevents gradual disk exhaustion and cross-request file conflicts.
- **Estimated implementation effort:** Medium
- **Risk of implementation:** Medium

#### Harden the FFmpeg pipeline for real-world media

- **Description:** Validate streams with the existing/appropriate probe mechanism, handle missing audio during normalization/merge, validate trim ranges, and safely constrain title text for FFmpeg filters.
- **Why it matters:** Normal user media (notably silent video) and ordinary title characters can cause processing failures.
- **Expected benefit:** Higher completion rate and safer behavior for supported workflows.
- **Estimated implementation effort:** Medium
- **Risk of implementation:** Medium

#### Establish production resource protection and observability

- **Description:** Add bounded processing concurrency/timeouts and structured request/job logs; add rate/abuse protection appropriate to the deployed platform.
- **Why it matters:** Synchronous encodes can saturate an instance, while current failures are difficult to correlate or diagnose.
- **Expected benefit:** More stable service under load and faster incident diagnosis.
- **Estimated implementation effort:** Medium
- **Risk of implementation:** Medium

### MEDIUM PRIORITY

#### Add automated coverage for processing behavior

- **Description:** Create tests for parser behavior and route-level processing cases using small fixtures: valid single clip, two clips, silent video, invalid media, title escaping, and invalid trims.
- **Why it matters:** FFmpeg changes can silently regress output or supported prompt behavior.
- **Expected benefit:** Safer incremental changes and confidence in production behavior.
- **Estimated implementation effort:** Medium
- **Risk of implementation:** Low

#### Make prompt interpretation a single shared contract

- **Description:** Define supported operations and their parsing/validation in one reusable model, then use it for server behavior and client messaging/examples.
- **Why it matters:** The current client’s status text and server parser already differ for “cool” versus “blue.”
- **Expected benefit:** Accurate user feedback and reduced drift as capabilities expand.
- **Estimated implementation effort:** Medium
- **Risk of implementation:** Medium

#### Verify and align container runtime configuration

- **Description:** Confirm the hosting platform’s `PORT` behavior, add a health-check strategy, and use reproducible dependency installation in the container build.
- **Why it matters:** Docker exposes 8080 while `next start` uses its default port unless the environment sets `PORT`; deployment failures can otherwise be environment-specific.
- **Expected benefit:** More reliable builds and startup behavior.
- **Estimated implementation effort:** Small
- **Risk of implementation:** Low

#### Improve project-specific documentation and CI

- **Description:** Replace the boilerplate README with setup, FFmpeg requirements, supported prompts, tests, and deployment notes; add CI for lint, build, and tests when available.
- **Why it matters:** Current knowledge is concentrated in source and `AGENTS.md`.
- **Expected benefit:** Faster onboarding and fewer environment-dependent mistakes.
- **Estimated implementation effort:** Small
- **Risk of implementation:** Low

### LOW PRIORITY

#### Remove or justify unused assets and dependencies

- **Description:** Audit and remove or document unused FFmpeg WebAssembly dependencies, FFprobe constant, LUTs, ML packages, static output MP4s, duplicate CSS, and unused theme declarations.
- **Why it matters:** Unused material obscures the actual runtime path and increases image/repository size.
- **Expected benefit:** Clearer ownership, faster builds, and smaller artifacts.
- **Estimated implementation effort:** Small
- **Risk of implementation:** Low

#### Improve editor resource hygiene and presentation details

- **Description:** Revoke replaced object URLs, ensure client-side status reflects server-confirmed operations, and address the lint warning for the logo image if appropriate for the asset.
- **Why it matters:** These are small UX/memory/readability issues rather than core service risks.
- **Expected benefit:** Cleaner long-running editor sessions and a warning-free lint result.
- **Estimated implementation effort:** Small
- **Risk of implementation:** Low

#### Split processing and UI code as complexity grows

- **Description:** Extract FFmpeg command builders/pipeline stages and editor request/state logic into focused units once behavior is protected by tests.
- **Why it matters:** The current files are readable, but continued feature additions will make them harder to reason about.
- **Expected benefit:** Easier review and safer incremental feature work.
- **Estimated implementation effort:** Medium
- **Risk of implementation:** Medium

## 9. Overall Score

| Area | Score | Rationale |
| --- | ---: | --- |
| Architecture | 6/10 | Clear and minimal, but synchronous local processing has limited scale headroom. |
| Code Quality | 6/10 | Readable small codebase, with a concentrated pipeline and unused/dead elements. |
| Maintainability | 5/10 | Good starting structure and new guidance, but no tests/CI and significant behavior is centralized. |
| Reliability | 4/10 | Happy path is clear; unbounded uploads, no cleanup, and media edge cases are material production risks. |
| Readability | 7/10 | Straightforward naming and flow; comments usefully segment the pipeline. |
| Overall Repository Health | 5.2/10 | Viable MVP, but reliability hardening should precede feature expansion. |

## Recommended Order of Future Improvements

1. Set and enforce server-side upload, prompt, and media limits.
2. Add collision-resistant temporary job directories and guaranteed cleanup.
3. Harden stream probing, missing-audio merge behavior, trim validation, and title/filter handling.
4. Add bounded concurrency, execution timeouts, request/job logging, and platform-appropriate abuse protection.
5. Add representative processing tests and run them in CI with lint/build checks.
6. Centralize the supported-prompt contract so client messaging and server behavior stay aligned.
7. Verify container port/health behavior and make dependency installation reproducible.
8. Replace boilerplate documentation and remove or explicitly justify unused runtime dependencies and assets.
9. Split pipeline/UI modules only after tests protect current behavior.
