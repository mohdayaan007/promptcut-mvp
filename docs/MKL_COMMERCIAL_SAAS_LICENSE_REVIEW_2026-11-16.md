# MKL Commercial SaaS License Review — 2026-11-16

**Status:** Technical HOSTED PASS; public MKL feature remains **OFF**. This is a factual release decision aid, not a legal opinion.

## Verified implementation

- Cliponaut deploys a **server-side** Docker image to Railway. Browser customers upload source media and send a five-frame aggregate RGB mean/covariance profile from a locally selected reference video; no reference pixels/video are sent to the server.
- An authenticated Node worker launches `scripts/founder-mkl-local-evaluation.py` as a separate Python process, providing private absolute file paths and consuming an MP4 and numerical JSON report.
- The Python process imports and invokes upstream `color-matcher==0.6.0` (`ColorMatcher.transfer(..., method="mkl")`) and NumPy. Source outputs are encoded through FFmpeg and AAC stream-copied where compatible.
- `color-matcher==0.6.0` is **GNU GPL v3-or-later** (PyPI release March 30, 2025). Its exact upstream archive is inventoried in `docs/MKL_GPL_SOURCE_BUNDLE.md`, and the Docker image includes its GPL license text and the component notice.
- The proprietary worker and the Python runner are *separate processes*, but are designed to cooperate. Separation alone does **not** establish independent works for GPL purposes.
- Customer applications receive MP4 output, not executable code, Python wheels, or Docker images through the ordinary hosted editor experience.
- The hosted founder test passed with accepted colour and preserved footage/audio. The public release flag remains disabled.

## License baseline and likely treatment

1. **Commercial use is allowed** under the GPL; the relevant distinction is conditions on *conveying software copies*, not whether a service charges money.
2. **Ordinary network access to a hosted GPLv3 program is not itself conveying copies.** GPLv3 section 0 says mere network interaction without transferring a copy is not conveying. GPLv3 section 2 permits making, running, and propagating covered works without conveying them, subject to license compliance. **Do not conflate GPLv3 and AGPLv3:** the latter has an additional network-interaction source obligation.
3. **Generated MP4s are not automatically GPL-licensed.** The GPLv3 section 2 output provision generally excludes outputs that do not themselves contain covered program material.
4. **Railway packaging is a separate question.** Building and hosting an image on infrastructure operated by a third party requires checking the conditions of GPLv3 section 2's facilities-provider permission, the contract/deployment setup and whether any copy is conveyed outside those conditions.
5. **The Node/Python coupling is a distinct legal question.** The FSF describes fork/exec, pipes and command-line arguments as typically indicative of separate programs, but sufficiently intimate semantics can change the analysis. Our bespoke runner consumes numerical profiles, processes input/output files and returns only results; counsel should examine whether this constitutes separate works or a combined work when *copies are conveyed*.
6. **If software copies are conveyed beyond a permitted internal/facilities arrangement**, the relevant GPL terms, attribution, access to Corresponding Source for covered code and any coupled combined work, and any applicable downstream rights must be satisfied. A source archive inventory alone is **not** proof of end-to-end compliance.

## Before enabling the public switch

- [x] Preserve exact GPL package, version, upstream source archive hash, full license, runner, lockfile and build reproducibility in the repository.
- [x] Keep founder-only and public release flags separate.
- [x] Prove the hosted workflow and output quality under the founder account.
- [ ] **Legal release decision:** Document whether Railway hosting qualifies for the GPLv3 section 2 facility-provider arrangement, and whether the subprocess bridge constitutes a single work or separate programs for relevant conveying. Consult competent open-source counsel or seek a written permission/alternative commercial license from the upstream rights-holder where necessary.
- [ ] **Operational compliance if conveying:** Make the exact Corresponding Source and appropriate notices available to recipients in a form consistent with the relevant GPLv3 provisions; ensure any required permissions/rights are preserved. Do not infer that simply placing notices inside a private container is sufficient.
- [ ] Confirm any third-party dependency notices and distribution obligations in the final image/release package.
- [ ] Only after clearance: switch `CLIPONAUT_CUSTOMER_MKL_RELEASE_ENABLED=true` for web **and** worker together. Preserve subscriber entitlement checks, founder exemption, quota of 15 and all unrelated billing/environment settings. Run a controlled subscriber smoke test and watch job failures before wider promotion.

## Options for the founder

**A. Hosted GPLv3-only operation with a documented compliance opinion.** Potentially fastest if no copies are conveyed to customers and Railway arrangement fits section 2; legal sign-off needed on the particular implementation.

**B. Obtain commercial permission / dual license** from the upstream copyright holder, Christopher Hahne, for the particular hosted/proprietary integration. This may simplify future distribution; terms and availability must be negotiated, not assumed.

**C. Replace the dependency** with an independently implemented or commercially permitted colour-transfer component, then rerun the already-defined SSIM/audio acceptance and one hosted render. This is more engineering effort and not automatically equivalent.

## Primary sources

- GPLv3 authoritative text: https://www.gnu.org/licenses/gpl-3.0.html
- FSF license FAQ on separate processes and combining works: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation
- FSF: Why the Affero GPL differs: https://www.gnu.org/licenses/why-affero-gpl.html
- PyPI exact release: https://pypi.org/project/color-matcher/0.6.0/
- Upstream repository: https://github.com/hahnec/color-matcher
- Repository package archive inventory: `docs/MKL_GPL_SOURCE_BUNDLE.md`

**No live feature flags or deployment configuration are changed by this document.**
