import { readFounderStagingJson } from "@/lib/jobs/storage";
import { FOUNDER_REFERENCE_STYLE_ASSETS, founderReferenceStyleStagingEnabled, validateFounderReferenceStyleManifest } from "@/lib/editor-core/founder-reference-style-staging-contract";
import { FOUNDER_REFERENCE_STYLE_REFERENCES, founderReferenceStyleReference } from "@/lib/editor-core/founder-reference-style-staging";

function unavailable() { throw new Error("Founder Reference Style staging assets are unavailable"); }

/**
 * The project may use the regular private store only when it is explicitly
 * configured as an isolated staging bucket. This guards against accidentally
 * pointing the founder-only workflow at production storage.
 */
export function assertFounderReferenceStyleStorageIsolation() {
  if (!founderReferenceStyleStagingEnabled()) unavailable();
  const stagingBucket = process.env.FOUNDER_REFERENCE_STYLE_STAGING_BUCKET;
  const runtimeEnvironment = process.env.FOUNDER_REFERENCE_STYLE_RUNTIME_ENVIRONMENT;
  if (!stagingBucket || runtimeEnvironment !== "staging" || stagingBucket !== process.env.STORAGE_BUCKET || !/staging/i.test(stagingBucket)) unavailable();
  return stagingBucket;
}

export async function loadFounderReferenceStyleManifest(referenceId = FOUNDER_REFERENCE_STYLE_ASSETS.reference.id, { readJson = readFounderStagingJson } = {}) {
  assertFounderReferenceStyleStorageIsolation();
  if (!founderReferenceStyleReference(referenceId)) unavailable();
  return validateFounderReferenceStyleManifest(await readJson(`founder-reference-style/v1/manifest-${referenceId}.json`));
}

export function founderReferenceStyleApprovedReferences() { return Object.freeze(FOUNDER_REFERENCE_STYLE_REFERENCES.map(({ id, label }) => Object.freeze({ id, label }))); }

export function founderReferenceStyleSourceManifest(manifest) {
  const source = manifest.source;
  return Object.freeze({ index: 0, key: source.key, type: source.type, size: source.size, originalName: "founder-source.mp4", stagingAssetId: source.id, stagingDigest: source.sha256 });
}

export function founderReferenceStyleReferenceManifest(manifest) {
  const reference = manifest.reference;
  return Object.freeze({ key: reference.key, type: reference.type, size: reference.size, originalName: "founder-reference.mp4", stagingAssetId: reference.id, stagingDigest: reference.sha256 });
}

export { FOUNDER_REFERENCE_STYLE_ASSETS };
