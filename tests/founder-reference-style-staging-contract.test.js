import test from "node:test";
import assert from "node:assert/strict";
import { FOUNDER_REFERENCE_STYLE_ASSETS, FOUNDER_REFERENCE_STYLE_STAGING_VERSION, validateFounderReferenceStyleManifest } from "../src/lib/editor-core/founder-reference-style-staging-contract.js";
import { assertFounderReferenceStyleStorageIsolation, founderReferenceStyleSourceManifest } from "../src/lib/founder-reference-style-assets.js";

const sha = "a".repeat(64);
const asset = (role, extra = {}) => ({ id: FOUNDER_REFERENCE_STYLE_ASSETS[role].id, key: FOUNDER_REFERENCE_STYLE_ASSETS[role].key, type: "video/mp4", sha256: sha, size: 1024, duration: 12.5, width: 1280, height: 720, hasAudio: role === "source", ...extra });
const manifest = () => ({ version: FOUNDER_REFERENCE_STYLE_STAGING_VERSION, reference: asset("reference"), source: asset("source"), profile: { version: "founder-reference-style-profile/1", id: FOUNDER_REFERENCE_STYLE_ASSETS.profile.id, referenceAssetId: FOUNDER_REFERENCE_STYLE_ASSETS.reference.id, referenceSha256: sha, observation: { warmth: "cool", saturation: "low", contrast: "high", typography: "mixed", animation: "phrase_rise", uncertainty: ["exact font unknown"] }, colour: { treatment: { version: 2, recipe: { temperature: -0.03 } }, confidence: "medium", limitations: ["global grade"] }, typography: { confidence: "low", limitations: ["still-frame evidence"] } } });

test("founder staging manifest uses fixed server-owned IDs and validated profile evidence", () => {
  const value = validateFounderReferenceStyleManifest(manifest());
  assert.equal(value.source.key, "founder-reference-style/v1/source.mp4");
  assert.equal(value.profile.colour.treatment.recipe.temperature, -0.03);
  assert.equal(founderReferenceStyleSourceManifest(value).stagingAssetId, FOUNDER_REFERENCE_STYLE_ASSETS.source.id);
});

test("founder staging rejects substituted paths, asset IDs, and unbound profiles", () => {
  const replaced = manifest(); replaced.source.key = "jobs/production/source.mp4";
  assert.throws(() => validateFounderReferenceStyleManifest(replaced), /source asset identity/);
  const unbound = manifest(); unbound.profile.referenceSha256 = "b".repeat(64);
  assert.throws(() => validateFounderReferenceStyleManifest(unbound), /profile identity/);
});

test("founder staging requires an explicitly isolated staging bucket", () => {
  const saved = { enabled: process.env.FOUNDER_REFERENCE_STYLE_STAGING_ENABLED, environment: process.env.FOUNDER_REFERENCE_STYLE_RUNTIME_ENVIRONMENT, bucket: process.env.STORAGE_BUCKET, staging: process.env.FOUNDER_REFERENCE_STYLE_STAGING_BUCKET };
  try {
    process.env.FOUNDER_REFERENCE_STYLE_STAGING_ENABLED = "true"; process.env.FOUNDER_REFERENCE_STYLE_RUNTIME_ENVIRONMENT = "staging"; process.env.STORAGE_BUCKET = "cliponaut-reference-style-staging"; process.env.FOUNDER_REFERENCE_STYLE_STAGING_BUCKET = "cliponaut-reference-style-staging";
    assert.equal(assertFounderReferenceStyleStorageIsolation(), "cliponaut-reference-style-staging");
    process.env.FOUNDER_REFERENCE_STYLE_STAGING_BUCKET = "cliponaut-production";
    assert.throws(() => assertFounderReferenceStyleStorageIsolation(), /unavailable/);
  } finally { Object.assign(process.env, { FOUNDER_REFERENCE_STYLE_STAGING_ENABLED: saved.enabled, FOUNDER_REFERENCE_STYLE_RUNTIME_ENVIRONMENT: saved.environment, STORAGE_BUCKET: saved.bucket, FOUNDER_REFERENCE_STYLE_STAGING_BUCKET: saved.staging }); }
});
