/**
 * The public reference-video contract is deliberately stricter than ordinary
 * source-media validation. This module validates only server-attached evidence;
 * browser metadata and provider prose never satisfy it.
 */
export const REQUIRED_REFERENCE_VIDEO_SAFETY_CATEGORIES = Object.freeze(["sexual_content", "violence", "csam"]);

export function hasApprovedReferenceVideoSafety(reference) {
  const safety = reference?.safety;
  return Boolean(
    safety &&
    safety.version === 1 &&
    safety.decision === "approved" &&
    typeof safety.evidenceId === "string" &&
    /^[a-z0-9_-]{16,128}$/i.test(safety.evidenceId) &&
    Array.isArray(safety.coveredCategories) &&
    REQUIRED_REFERENCE_VIDEO_SAFETY_CATEGORIES.every((category) => safety.coveredCategories.includes(category))
  );
}

export function assertApprovedReferenceVideoSafety(reference) {
  if (!hasApprovedReferenceVideoSafety(reference)) {
    throw new Error("Dedicated reference-video safety evidence is required");
  }
}
