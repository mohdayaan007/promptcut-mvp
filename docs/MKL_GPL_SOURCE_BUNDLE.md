# MKL GPL Corresponding Source Bundle

This release branch carries the exact upstream source distribution used by the
isolated MKL component:

- `third_party/color-matcher-0.6.0/color-matcher-0.6.0.tar.gz`
- SHA-256: `7ba8a00782c3e5e5931dda7b1fb9c572ace82de0c6c97654432b7cfe0aa74843`
- Upstream package: `color-matcher` 0.6.0, Copyright (c) 2020 Christopher
  Hahne, GNU GPL version 3 or later.

The source bundle for a conveyed image must include that archive, its GPL text,
`scripts/founder-mkl-local-evaluation.py`,
`python/mkl-runtime-requirements.txt`, `Dockerfile`, and
`docs/MKL_GPL_COMPONENT.md`. The image itself installs the GPL text at
`/usr/share/licenses/color-matcher/LICENSE` and the component notice at
`/usr/share/doc/cliponaut-mkl/GPL-COMPONENT.md`.

This is a source-compliance artifact, not legal advice. In particular, the
subprocess/files/JSON boundary does not resolve whether the proprietary Node
worker and bespoke Python runner are a combined work. Counsel must approve the
final notice, Corresponding Source delivery method, and Railway conveyance
arrangement before customer enablement.
