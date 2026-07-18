# Project Overview

Cliponaut is a prompt-driven video editing application. Users upload one or two video clips, describe a supported edit in plain language, preview the generated MP4, and download it.

# Product Goal

Make short, straightforward video edits accessible without a timeline-based editor. The current product supports automatic merging, basic color looks, title overlays, and trimming through simple prompts.

# Project Status

Cliponaut is a live MVP currently deployed in production.

The current engineering focus is improving reliability, maintainability, and user experience before expanding the feature set.

# Tech Stack

- Next.js App Router and React
- Tailwind CSS for styling
- Node.js API route runtime
- System FFmpeg for video normalization, concatenation, filtering, trimming, and encoding
- Vercel Analytics
- Docker for containerized deployment

# Repository Structure

- `src/app/page.js` — landing page and demo video controls.
- `src/app/editor/page.js` — client-side upload, prompt, preview, and download experience.
- `src/app/api/process-video/route.js` — multipart upload handling and FFmpeg processing pipeline.
- `src/app/layout.js` — shared layout, metadata, font, and analytics.
- `src/app/globals.css` — global styles and Tailwind import.
- `public/` — static assets, including the demo video, logo, and existing output artifacts.
- `luts/` — LUT files present in the repository; they are not currently used by the processing route.
- `Dockerfile` — production image definition, including system FFmpeg.

# Video Processing Pipeline

1. The editor submits `video1`, optional `video2`, and `prompt` to `POST /api/process-video`.
2. The API writes uploads to a uniquely named operating-system temporary directory.
3. Each input is normalized to 1280×720, 30 fps, H.264 video, and AAC audio.
4. When a second clip is provided, both normalized clips are concatenated.
5. The prompt is parsed with fixed keyword and regular-expression rules for supported color looks, title overlays, and trims; it does not call an AI model.
6. FFmpeg applies the selected filters, then any trim, performs a final encode, and returns an MP4 response.
7. The browser creates an object URL for preview and download; API outputs are not persisted by the application.

# Development Workflow

- `develop` is the primary development branch.
- `main` is the production branch.
- Develop and test changes on `develop` before merging them into `main`.
- Use `npm run dev` for local development, `npm run lint` for linting, and `npm run build` to validate the production build.
- Local and deployed processing requires the `ffmpeg` executable to be available to the Node.js process.

# Engineering Philosophy

- Prioritize reliability before new features.
- Prefer incremental improvements over large rewrites.
- Understand existing code before modifying it.
- Preserve existing behavior unless explicitly requested.
- Explain significant architectural decisions before implementing them.
- When proposing significant changes, explain the reasoning before implementation.
- Avoid unnecessary dependencies.
- Fix root causes rather than adding workarounds.

# Coding Guidelines

- Keep page-specific UI in its App Router route and keep server-side processing in the API route.
- Maintain the current input/output contract for `POST /api/process-video` unless a coordinated change is intended.
- Treat prompt support as explicit parser behavior: only claim support for operations implemented in the route.
- Keep FFmpeg commands deterministic and compatible with the container runtime.
- Preserve the existing normalized output format when changing processing steps unless a format change is intentional and verified.

# Safety Guidelines

- Inspect existing behavior and repository state before edits.
- Do not delete or overwrite user uploads, sample assets, or generated artifacts without explicit authorization.
- Treat uploaded video data as temporary processing input and avoid logging its contents.
- Validate changes involving FFmpeg with representative clips, including one- and two-video workflows when relevant.
- Be cautious with large uploads and long-running synchronous processing in the API route.

# Deployment Notes

- The Docker image uses Node 22 on Debian and installs system FFmpeg, Python, CPU Torch, and Whisper.
- The current application code relies on system FFmpeg; it does not use the installed Torch or Whisper packages, FFprobe, or FFmpeg WebAssembly dependencies.
- The API route declares the Node.js runtime and is not compatible with an Edge-only deployment.
- The Dockerfile exposes port 8080, while `next start` uses its default port unless the deployment environment supplies `PORT`.
- Vercel Analytics is included, but the repository has no Vercel-specific deployment configuration.

# AI Collaboration

Before implementing major changes:

1. Understand the existing implementation.
2. Explain the proposed approach.
3. Minimize the scope of changes.
4. Preserve backwards compatibility where practical.
