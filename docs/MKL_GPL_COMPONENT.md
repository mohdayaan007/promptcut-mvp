# MKL GPL Component — Release Preparation

## Scope and release gates

`scripts/founder-mkl-local-evaluation.py` is Cliponaut's original MKL runner.
It calls `color-matcher` with `method="mkl"` for every decoded frame, validates
the transform and output, preserves compatible source audio through FFmpeg
stream copy, and writes only a numerical JSON report. The Node worker and the
Python runner communicate through an OS subprocess, trusted absolute paths, an
MP4 output, and that JSON report.

The prepared image is not a customer release. `CLIPONAUT_MKL_RUNTIME_PREPARED`
only acknowledges an image that contains the runtime; the separate
`CLIPONAUT_CUSTOMER_MKL_RELEASE_ENABLED` gate remains false unless a future
approved deployment explicitly sets it. Current public reference-video safety
gates remain unchanged.

## Attribution and exact component

- Upstream: `hahnec/color-matcher`, `0.6.0`.
- Copyright: Copyright (c) 2020 Christopher Hahne `<info@christopherhahne.de>`.
- License: GNU GPL version 3 or later.
- Wheel: `color_matcher-0.6.0-py3-none-any.whl`, SHA-256
  `fd642f9414c33b7f3ebc96fe0888c1c6200836142664589ce2ccb52ebcda7734`.
- Numerical dependency: `numpy==2.0.2`, CPython 3.11 Linux x86_64 wheel,
  SHA-256 `13e689d772146140a252c3a28501da66dfecd77490b498b168b501835041f951`.

The image installs the complete upstream GPL text from the wheel at
`/usr/share/licenses/color-matcher/LICENSE`. The exact package lock is
`python/mkl-runtime-requirements.txt`.

## Reproducible build and source obligations

The Dockerfile uses Debian Bookworm's CPython 3.11, installs only the two
hash-pinned wheels with `pip --no-deps --require-hashes`, and executes the
runner's import-only `--runtime-check` during build. It does not process media
or customer data during image construction.

Before conveying an image containing this GPL component, make the matching
Corresponding Source available alongside the artifact or through a clear,
durable source offer. That source set must include the unmodified upstream
`color-matcher` 0.6.0 source and license, this runner including its
memory-release change, the dependency lock, and these build instructions.
The repository carries the exact upstream archive and bundle inventory in
`docs/MKL_GPL_SOURCE_BUNDLE.md`. Before conveying an image, publish that
inventory with the release artifact or a durable source offer under Cliponaut's
control.

## Outstanding legal review

The OS subprocess/files/JSON boundary is an intentional separation mechanism,
not a conclusion that the proprietary Node worker is outside GPL obligations.
Counsel must determine whether the Node worker plus bespoke runner is a
combined work and whether the Railway build/image arrangement is a conveyance.
Do not enable customer MKL until that review approves the packaging, notices,
Corresponding Source availability, and deployment arrangement.
