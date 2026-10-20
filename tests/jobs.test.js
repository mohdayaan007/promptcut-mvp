import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MAX_DIRECT_UPLOAD_FILE_BYTES, JOB_STATUSES, MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_VIDEO_BYTES, MAX_REFERENCE_VIDEO_DURATION_SECONDS, validateJobRequest, validateReferenceManifest, validateUploadManifest } from "@/lib/jobs/job-config";
import { buildNormalizationFilter, createMediaProfile } from "@/lib/editor-core/media-profile";
import { DIRECT_UPLOAD_CORS, jobInputObjectKeys, referenceObjectKey, sourceObjectKey } from "@/lib/jobs/storage";
import { safeSourceMetadata } from "@/lib/jobs/http";
import { ACTIVE_JOB_STATUSES, canCompleteUndoMediaRestoration, clearTerminalJob, consumeUndo, describeUndoRestoration, discardUndoActiveJob, emptyUndoState, findUndoTurnIndex, getInitialUndoAnchor, invalidateUndoPrevious, isActiveJobStatus, isCurrentPresentationAttempt, isRecoverableJobStatus, loadUndoState, PartUploadError, promoteSuccessfulJob, recordTerminalJob, resolveUndoRestoration, saveUndoState, setUndoActiveJob, shouldScheduleUndoOriginalReveal, shouldShowUndoControl, terminalAttemptPresentation, undoMediaReadyAction, undoPreviewMode, UNDO_STATE_VERSION, uploadAndQueueJob, uploadPartWithRetry, waitForBrowserPaint } from "@/lib/client/direct-upload";
import { EDIT_JOBS_SCHEMA } from "@/lib/jobs/job-store";
import { createEditPlan, extractMomentCompositionRequests, extractSemanticSourceReferences, extractSpokenMomentRequest, extractVisualMomentRequest, requiresMomentCompositionUnderstanding, requiresSpokenMomentUnderstanding, requiresVisualMomentUnderstanding, requiresVisualSourceUnderstanding } from "@/lib/editor-core/edit-plan";
import { validateEditPlan } from "@/lib/editor-core/plan-validator";
import { createSourceCatalog } from "@/lib/editor-core/source-catalog";
import { createDelegatedStyleDecisionJsonSchema, createEditPlanJsonSchema, createSemanticSourceClassificationJsonSchema, createSemanticTranscriptMatchJsonSchema, createStyleIntentJsonSchema, createVisualMomentLocalizationJsonSchema } from "@/lib/editor-core/ai-editor/schema";
import { buildDelegatedStyleContents, createAiEditPlan, createStylePlanningDiagnostics, reconcileReferenceStylePlan, resolveSemanticSourceClassifications, resolveVisualMomentLocalizations, summarizeStylePlanDiagnostic, UnsupportedEditRequestError } from "@/lib/editor-core/ai-editor/planner";
import { buildAiEditorPrompt, buildDelegatedStyleDecisionPrompt, buildSemanticTranscriptMatchPrompt, buildStyleIntentPrompt, buildVisualMomentLocalizationPrompt } from "@/lib/editor-core/ai-editor/prompt";
import { buildReferenceStyleTreatmentFilters, buildReferenceToneCurveFilter, buildReferenceToneCurvePoints, buildStyleProfileFilters, buildStyleRecipeFilters, buildToneCurveFilter, buildToneCurvePoints, buildVibranceFilter, buildVisualAdjustmentFilters, compileStyleProfileForExecution, createExecutionController, createStyleProfileExecutionDiagnostic, EditExecutionCancelledError, executeEditPlan, orderedVisualOperations, perceptualAdjustmentMagnitude, titleReadabilityForLuma, VISUAL_OPERATION_ORDER } from "@/lib/editor-core/edit-executor";
import { CAPABILITY_REGISTRY } from "@/lib/editor-core/capability-registry";
import { TranscriptValidationError, createCanonicalTranscript, findPhraseOccurrences, normalizePhrase, pairPhraseOccurrences, validateTranscriptWords } from "@/lib/editor-core/spoken-transcript";
import { extractSpeechAudio, transcribeSource, wordAnnotations, SpokenTranscriptionError } from "@/lib/editor-core/spoken-transcription";
import { FONT_CATALOG, resolveFontId, resolveSemanticFontIntent } from "@/lib/title-config";
import { buildAssDocument, buildAssFilter } from "@/lib/title-renderer";
import { parseTitle } from "@/lib/title-parser";
import { applyCaptionCorrection, CaptionError, createCaptionCues, extractCaptionCorrection, extractCaptionStyleRequest, mapCaptionCuesToOutput, requestsCaptions } from "@/lib/editor-core/caption-engine";
import { extractAudioControlIntent, reconcileAudioControls } from "@/lib/editor-core/audio-controls";
import { extractVisualAdjustmentIntent, reconcileVisualAdjustments } from "@/lib/editor-core/visual-adjustments";
import { CANONICAL_VISUAL_RECIPE_FIELDS, CANONICAL_VISUAL_RECIPE_LIMITS, NEUTRAL_VISUAL_RECIPE, STYLE_PROFILE_CATALOG, STYLE_PROFILE_CONSTRAINTS, STYLE_PROFILE_IDS, STYLE_PROFILE_STRENGTHS, compileStyleProfile, createCanonicalVisualRecipe, interpolateCanonicalVisualRecipe, resolveCurrentStyleProfile, resolveStyleProfile } from "@/lib/editor-core/style-profiles";
import { createCanonicalReferenceStyleTreatment, REFERENCE_STYLE_TREATMENT_VERSION } from "@/lib/editor-core/reference-style-treatment";
import { measureReferenceRgbFrame, REFERENCE_FRAME_METRICS_VERSION, summarizeReferenceFrameMetrics } from "@/lib/editor-core/reference-style-metrics";
import { createReferenceStyleProxyFrames, extractTargetReferenceFrames } from "@/lib/editor-core/reference-style-media";
import { extractStyleProfileIntent, isDeterministicallySafeStyleRequest, isServerSafeTextStyleOnlyRequest, normalizeDelegatedStyleDecision, normalizeTextStyleIntent, reconcileResolvedStyleProfile, requiresDelegatedStyleJudgment } from "@/lib/editor-core/style-intent";
import { analyzeReferenceStyle, createReferenceStyleDiagnostic, createReferenceStyleFailureDiagnostic, deriveReferenceStyleTreatment, evaluateReferenceStyleProxy, isB2aProxyRefinementEnabled, refineReferenceStyleTreatment, REFERENCE_STYLE_SAFE_ERROR, ReferenceStyleError, referenceStyleAnalysisSchema, referenceStyleProxyEvaluationSchema, referenceStyleReferenceAnalysisSchema, referenceStyleTargetAnalysisSchema, requestsReferenceStyleMatch, TONAL_COLOR_BIASES, validateReferenceStyleAnalysis } from "@/lib/editor-core/reference-style-matching";
import { analyzeTypographyReference, deriveTypographyTitleTreatment, extractTypographyReferenceSelector, reconcileTypographyReferenceTitlePlan, requestsTypographyReferenceMatch, selectTypographyReferenceCandidate, typographyReferenceAnalysisSchema, TypographyReferenceError, validateTypographyReferenceAnalysis } from "@/lib/editor-core/typography-reference-matching";
import { assertReferenceVideoFoundationEnabled, assertReferenceVideoMatchingImplemented, createReferenceVideoSamplingPlan, decodeReferenceVideoFrames, ReferenceVideoError, validateReferenceVideoFile } from "@/lib/editor-core/reference-video-foundation";

function canonicalStyleRecipe(recipe) {
  return { shadows: 0, highlights: 0, vibrance: 0, blackLift: 0, midtoneGamma: 0, ...recipe };
}

test("B1 style profiles compile server-owned bounded canonical recipes", () => {
  assert.deepEqual(STYLE_PROFILE_IDS, ["clean_commercial", "warm_travel", "cinematic", "soft_nostalgic", "vibrant_social", "dark_moody", "natural_documentary"]);
  const currentVersions = { clean_commercial: 2, cinematic: 2, soft_nostalgic: 3, vibrant_social: 2, dark_moody: 2, natural_documentary: 2 };
  for (const profileId of STYLE_PROFILE_IDS) {
    const current = resolveCurrentStyleProfile(profileId);
    assert.equal(current.profileId, profileId);
    assert.equal(current.profileVersion, currentVersions[profileId] || 1);
    assert.deepEqual(current, resolveStyleProfile(profileId, currentVersions[profileId] || 1));
  }
  assert.throws(() => resolveCurrentStyleProfile("unknown"), /unknown profile/);
  assert.throws(() => resolveStyleProfile("cinematic", 99), /unknown cinematic version/);
  assert.throws(() => compileStyleProfile({ profileId: "cinematic", strength: "maximum" }), /unsupported strength/);
  assert.throws(() => compileStyleProfile({ profileId: "cinematic", constraints: ["skin_detection"] }), /unsupported constraint/);

  const cinematic = resolveCurrentStyleProfile("cinematic");
  assert.deepEqual(interpolateCanonicalVisualRecipe(cinematic.recipe, 0), NEUTRAL_VISUAL_RECIPE);
  const subtle = compileStyleProfile({ profileId: "cinematic", strength: "subtle" });
  const standard = compileStyleProfile({ profileId: "cinematic", strength: "standard" });
  const strong = compileStyleProfile({ profileId: "cinematic", strength: "strong" });
  const magnitude = (recipe) => Object.values(recipe).reduce((total, value) => total + Math.abs(value), 0);
  assert.ok(magnitude(subtle.recipe) < magnitude(standard.recipe));
  assert.ok(magnitude(standard.recipe) < magnitude(strong.recipe));
  assert.deepEqual(compileStyleProfile({ profileId: "cinematic" }), standard);

  for (const profileId of STYLE_PROFILE_IDS) for (const strength of Object.keys(STYLE_PROFILE_STRENGTHS)) {
    const { recipe } = compileStyleProfile({ profileId, strength });
    for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
      assert.equal(Number.isFinite(recipe[field]), true);
      assert.ok(recipe[field] >= CANONICAL_VISUAL_RECIPE_LIMITS[field].min);
      assert.ok(recipe[field] <= CANONICAL_VISUAL_RECIPE_LIMITS[field].max);
    }
  }

  const dark = compileStyleProfile({ profileId: "dark_moody", strength: "strong" });
  const noDarkening = compileStyleProfile({ profileId: "dark_moody", strength: "strong", constraints: ["avoid_darkening"] });
  assert.ok(dark.recipe.brightness < 0);
  assert.equal(noDarkening.recipe.brightness, 0);
  const vibrant = compileStyleProfile({ profileId: "vibrant_social", strength: "strong" });
  const noOversaturation = compileStyleProfile({ profileId: "vibrant_social", strength: "strong", constraints: ["avoid_oversaturation"] });
  assert.ok(noOversaturation.recipe.saturation <= vibrant.recipe.saturation);
  const warm = compileStyleProfile({ profileId: "warm_travel", strength: "strong" });
  const conservative = compileStyleProfile({ profileId: "warm_travel", strength: "strong", constraints: ["conservative_color"] });
  const skinToneConservative = compileStyleProfile({ profileId: "warm_travel", strength: "strong", constraints: ["skin_tone_conservative"] });
  for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
    assert.ok(Math.abs(conservative.recipe[field]) <= Math.abs(warm.recipe[field]));
    assert.ok(Math.abs(skinToneConservative.recipe[field]) <= Math.abs(warm.recipe[field]));
  }
  for (const constrained of [noDarkening, noOversaturation, conservative, skinToneConservative]) {
    const unconstrained = compileStyleProfile({ profileId: constrained.profileId, profileVersion: constrained.profileVersion, strength: constrained.strength });
    for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
      assert.ok(Math.abs(constrained.recipe[field]) <= Math.abs(unconstrained.recipe[field]), `${constrained.constraints.join(",")} cannot increase ${field}`);
    }
  }
  assert.equal(Object.hasOwn(skinToneConservative.recipe, "skinDetection"), false, "constraint is global conservatism, never a skin-detection claim");

  const snapshot = JSON.stringify(STYLE_PROFILE_CATALOG);
  assert.throws(() => compileStyleProfile({ profileId: "cinematic", recipe: { brightness: 1 } }), /unsupported compiler field: recipe/);
  assert.throws(() => compileStyleProfile({ profileId: "cinematic", filters: ["eq=contrast=2"] }), /unsupported compiler field: filters/);
  assert.throws(() => compileStyleProfile({ profileId: "cinematic", lutPath: "/private.cube" }), /unsupported compiler field: lutPath/);
  assert.throws(() => compileStyleProfile({ profileId: "cinematic", arbitrary: "value" }), /unsupported compiler field: arbitrary/);
  assert.throws(() => compileStyleProfile(null), /compiler input must be a plain object/);
  assert.throws(() => compileStyleProfile(new Date()), /compiler input must be a plain object/);
  assert.equal(Object.isFrozen(compileStyleProfile({ profileId: "cinematic" }).recipe), true);
  assert.equal(JSON.stringify(STYLE_PROFILE_CATALOG), snapshot, "compilation cannot mutate catalog definitions");
  assert.deepEqual(compileStyleProfile({ profileId: "cinematic" }), standard, "repeated compilation is identical");
  assert.throws(() => createCanonicalVisualRecipe({ brightness: Infinity }), /finite number/);
  assert.throws(() => createCanonicalVisualRecipe({ filter: "eq=contrast=2" }), /unsupported recipe field/);
});

test("B1 profile calibrations preserve historical recipes and explicit current versions", () => {
  const v1Recipes = {
    clean_commercial: canonicalStyleRecipe({ brightness: 0.04, contrast: 0.2, saturation: 0.05, temperature: 0.02, tint: 0 }),
    natural_documentary: canonicalStyleRecipe({ brightness: 0.015, contrast: 0.08, saturation: 0.02, temperature: 0.01, tint: 0 })
  };
  const v2Recipes = {
    clean_commercial: canonicalStyleRecipe({ brightness: 0.075, contrast: 0.31, saturation: 0.12, temperature: 0.05, tint: 0 }),
    natural_documentary: canonicalStyleRecipe({ brightness: 0.045, contrast: 0.22, saturation: 0.075, temperature: 0.015, tint: 0 })
  };
  const unchangedProfiles = {
    warm_travel: canonicalStyleRecipe({ brightness: 0.05, contrast: 0.16, saturation: 0.16, temperature: 0.24, tint: 0.01 })
  };
  for (const [profileId, recipe] of Object.entries(v1Recipes)) {
    assert.deepEqual(resolveStyleProfile(profileId, 1).recipe, recipe, `${profileId} v1 remains reproducible`);
    assert.deepEqual(resolveCurrentStyleProfile(profileId).recipe, v2Recipes[profileId]);
    assert.equal(resolveCurrentStyleProfile(profileId).profileVersion, 2);
    for (const strength of ["subtle", "standard", "strong"]) {
      const compiled = compileStyleProfile({ profileId, strength });
      const expectedFactor = STYLE_PROFILE_STRENGTHS[strength];
      for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
        assert.equal(compiled.recipe[field], v2Recipes[profileId][field] * expectedFactor, `${profileId} ${strength} ${field}`);
      }
    }
  }
  for (const [profileId, recipe] of Object.entries(unchangedProfiles)) {
    assert.equal(STYLE_PROFILE_CATALOG[profileId].currentVersion, 1, `${profileId} version remains unchanged`);
    assert.deepEqual(resolveCurrentStyleProfile(profileId).recipe, recipe, `${profileId} recipe remains unchanged`);
  }

  const cleanV1 = compileStyleProfile({ profileId: "clean_commercial", profileVersion: 1, strength: "standard", constraints: ["skin_tone_conservative"] });
  const cleanV2 = compileStyleProfile({ profileId: "clean_commercial", strength: "standard", constraints: ["skin_tone_conservative"] });
  assert.deepEqual(cleanV2.recipe, canonicalStyleRecipe({ brightness: 0.0525, contrast: 0.18445, saturation: 0.054599999999999996, temperature: 0.01575, tint: 0 }));
  assert.ok(Object.values(cleanV2.recipe).reduce((sum, value) => sum + Math.abs(value), 0) > Object.values(cleanV1.recipe).reduce((sum, value) => sum + Math.abs(value), 0));
  assert.deepEqual(buildStyleProfileFilters({ profileId: "clean_commercial", strength: "standard", constraints: ["skin_tone_conservative"] }), [
    "eq=brightness=0.0602:contrast=1.2537:saturation=1.1539",
    "colorbalance=rs=0.0141:gs=0.0000:bs=-0.0141:rm=0.0188:gm=0.0000:bm=-0.0188:rh=0.0141:gh=0.0000:bh=-0.0141:pl=1"
  ]);

  const naturalV1 = compileStyleProfile({ profileId: "natural_documentary", profileVersion: 1, strength: "standard", constraints: ["avoid_darkening"] });
  const naturalV2 = compileStyleProfile({ profileId: "natural_documentary", strength: "standard", constraints: ["avoid_darkening"] });
  assert.deepEqual(naturalV2.recipe, canonicalStyleRecipe({ brightness: 0.0315, contrast: 0.154, saturation: 0.0525, temperature: 0.010499999999999999, tint: 0 }));
  assert.ok(Object.values(naturalV2.recipe).reduce((sum, value) => sum + Math.abs(value), 0) > Object.values(naturalV1.recipe).reduce((sum, value) => sum + Math.abs(value), 0));
  assert.deepEqual(buildStyleProfileFilters({ profileId: "natural_documentary", strength: "standard", constraints: ["avoid_darkening"] }), [
    "eq=brightness=0.0455:contrast=1.2280:saturation=1.1506",
    "colorbalance=rs=0.0114:gs=0.0000:bs=-0.0114:rm=0.0152:gm=0.0000:bm=-0.0152:rh=0.0114:gh=0.0000:bh=-0.0114:pl=1"
  ]);
  for (const recipe of [cleanV2.recipe, naturalV2.recipe]) for (const value of Object.values(recipe)) {
    assert.ok(Number.isFinite(value) && value >= -1 && value <= 1);
  }
});

test("B1 cinematic v2 protects shadows while retaining the v1 filmic character", () => {
  const v1Recipe = canonicalStyleRecipe({ brightness: -0.04, contrast: 0.3, saturation: -0.08, temperature: 0.05, tint: -0.02 });
  const v2Recipe = canonicalStyleRecipe({ brightness: 0, contrast: 0.23, saturation: -0.08, temperature: 0.05, tint: -0.02 });
  const otherCurrentVersions = {
    clean_commercial: 2,
    warm_travel: 1,
    soft_nostalgic: 3,
    vibrant_social: 2,
    dark_moody: 2,
    natural_documentary: 2
  };

  assert.deepEqual(resolveStyleProfile("cinematic", 1).recipe, v1Recipe, "cinematic v1 remains reproducible");
  assert.deepEqual(resolveCurrentStyleProfile("cinematic"), {
    profileId: "cinematic",
    profileVersion: 2,
    recipe: v2Recipe
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(otherCurrentVersions).map(([profileId]) => [profileId, STYLE_PROFILE_CATALOG[profileId].currentVersion])),
    otherCurrentVersions,
    "other profile versions remain stable during the cinematic calibration"
  );

  for (const strength of ["subtle", "standard", "strong"]) {
    const compiled = compileStyleProfile({ profileId: "cinematic", strength });
    const factor = STYLE_PROFILE_STRENGTHS[strength];
    for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
      assert.equal(compiled.recipe[field], v2Recipe[field] * factor, `cinematic v2 ${strength} ${field}`);
    }
  }

  const v1Standard = compileStyleProfile({ profileId: "cinematic", profileVersion: 1, strength: "standard" });
  const v2Standard = compileStyleProfile({ profileId: "cinematic", strength: "standard" });
  assert.deepEqual(v2Standard.recipe, canonicalStyleRecipe({
    brightness: 0,
    contrast: 0.161,
    saturation: -0.055999999999999994,
    temperature: 0.034999999999999996,
    tint: -0.013999999999999999
  }));
  assert.ok(v2Standard.recipe.brightness > v1Standard.recipe.brightness, "v2 removes automatic brightness darkening");
  assert.ok(v2Standard.recipe.contrast > 0 && v2Standard.recipe.contrast < v1Standard.recipe.contrast, "v2 retains moderated contrast");
  for (const field of ["saturation", "temperature", "tint"]) {
    assert.equal(v2Standard.recipe[field], v1Standard.recipe[field], `v2 preserves cinematic ${field}`);
  }

  assert.deepEqual(buildVisualAdjustmentFilters(v1Standard.recipe), [
    "eq=brightness=-0.0534:contrast=1.3342:saturation=0.8439",
    "colorbalance=rs=0.0241:gs=0.0155:bs=-0.0241:rm=0.0321:gm=0.0155:bm=-0.0321:rh=0.0241:gh=0.0155:bh=-0.0241:pl=1"
  ]);
  assert.deepEqual(buildStyleProfileFilters({ profileId: "cinematic", strength: "standard" }), [
    "eq=brightness=0.0000:contrast=1.2854:saturation=0.8439",
    "colorbalance=rs=0.0241:gs=0.0155:bs=-0.0241:rm=0.0321:gm=0.0155:bm=-0.0321:rh=0.0241:gh=0.0155:bh=-0.0241:pl=1"
  ]);
});

test("B1 cinematic v2 protects bright saturated highlights only when existing risk evidence is present", () => {
  const unconstrained = compileStyleProfile({ profileId: "cinematic", strength: "standard" });
  const protectedCinematic = compileStyleProfile({
    profileId: "cinematic",
    strength: "standard",
    constraints: ["avoid_oversaturation"]
  });

  assert.deepEqual(unconstrained.recipe, canonicalStyleRecipe({
    brightness: 0,
    contrast: 0.161,
    saturation: -0.055999999999999994,
    temperature: 0.034999999999999996,
    tint: -0.013999999999999999
  }), "ordinary explicit cinematic remains its historical v2 treatment");
  assert.deepEqual(protectedCinematic.recipe, canonicalStyleRecipe({
    brightness: 0,
    contrast: 0.10465000000000001,
    saturation: -0.041999999999999996,
    temperature: 0.017499999999999998,
    tint: -0.006999999999999999,
    highlights: -0.12
  }));
  assert.deepEqual(buildStyleProfileFilters({
    profileId: "cinematic",
    strength: "standard",
    constraints: ["avoid_oversaturation"]
  }), [
    "curves=master='0/0 0.25/0.2500 0.75/0.7286 1/1'",
    "eq=brightness=0.0000:contrast=1.2222:saturation=0.8669",
    "colorbalance=rs=0.0166:gs=0.0108:bs=-0.0166:rm=0.0221:gm=0.0108:bm=-0.0221:rh=0.0166:gh=0.0108:bh=-0.0166:pl=1"
  ]);
  assert.deepEqual(
    compileStyleProfile({ profileId: "vibrant_social", strength: "strong", constraints: ["avoid_oversaturation"] }).recipe,
    canonicalStyleRecipe({ brightness: 0.025, contrast: 0.06, saturation: 0.025, temperature: 0, tint: 0, shadows: 0.04, highlights: 0.03, vibrance: 0.18 }),
    "the cinematic-specific protection does not alter other profile compilation"
  );
});

test("B1 soft nostalgic v3 preserves prior versions while restoring airy photographic color", () => {
  const v1Recipe = canonicalStyleRecipe({ brightness: 0.07, contrast: -0.18, saturation: -0.2, temperature: 0.12, tint: 0.02 });
  const v2Recipe = canonicalStyleRecipe({ brightness: 0.04, contrast: -0.13, saturation: -0.18, temperature: 0.12, tint: 0.02 });
  const v3Recipe = canonicalStyleRecipe({ brightness: 0.055, contrast: -0.035, saturation: -0.055, temperature: 0.1, tint: 0.015, shadows: 0.1, highlights: 0.08, vibrance: 0.12 });
  const otherCurrentProfiles = {
    clean_commercial: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0.075, contrast: 0.31, saturation: 0.12, temperature: 0.05, tint: 0 }) },
    warm_travel: { profileVersion: 1, recipe: canonicalStyleRecipe({ brightness: 0.05, contrast: 0.16, saturation: 0.16, temperature: 0.24, tint: 0.01 }) },
    cinematic: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0, contrast: 0.23, saturation: -0.08, temperature: 0.05, tint: -0.02 }) },
    vibrant_social: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0.025, contrast: 0.06, saturation: 0.025, temperature: 0, tint: 0, shadows: 0.04, highlights: 0.03, vibrance: 0.18 }) },
    dark_moody: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: -0.045, contrast: 0.16, saturation: -0.02, temperature: -0.03, tint: -0.01, shadows: 0.12, highlights: 0.15, vibrance: 0.1 }) },
    natural_documentary: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0.045, contrast: 0.22, saturation: 0.075, temperature: 0.015, tint: 0 }) }
  };

  assert.deepEqual(resolveStyleProfile("soft_nostalgic", 1).recipe, v1Recipe, "soft nostalgic v1 remains reproducible");
  assert.deepEqual(resolveStyleProfile("soft_nostalgic", 2).recipe, v2Recipe, "soft nostalgic v2 remains reproducible");
  assert.deepEqual(resolveCurrentStyleProfile("soft_nostalgic"), {
    profileId: "soft_nostalgic",
    profileVersion: 3,
    recipe: v3Recipe
  });
  for (const [profileId, expected] of Object.entries(otherCurrentProfiles)) {
    assert.deepEqual(resolveCurrentStyleProfile(profileId), { profileId, ...expected }, `${profileId} remains unchanged`);
  }

  for (const strength of ["subtle", "standard", "strong"]) {
    const compiled = compileStyleProfile({ profileId: "soft_nostalgic", strength });
    const factor = STYLE_PROFILE_STRENGTHS[strength];
    for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
      assert.equal(compiled.recipe[field], v3Recipe[field] * factor, `soft nostalgic v3 ${strength} ${field}`);
      assert.ok(compiled.recipe[field] >= -1 && compiled.recipe[field] <= 1, `soft nostalgic v3 ${strength} ${field} remains bounded`);
    }
  }

  const v1Standard = compileStyleProfile({ profileId: "soft_nostalgic", profileVersion: 1, strength: "standard" });
  const v2Standard = compileStyleProfile({ profileId: "soft_nostalgic", profileVersion: 2, strength: "standard" });
  const v3Standard = compileStyleProfile({ profileId: "soft_nostalgic", strength: "standard" });
  assert.deepEqual(v3Standard.recipe, canonicalStyleRecipe({
    brightness: 0.0385,
    contrast: -0.0245,
    saturation: -0.0385,
    temperature: 0.06999999999999999,
    tint: 0.010499999999999999,
    shadows: 0.06999999999999999,
    highlights: 0.055999999999999994,
    vibrance: 0.08399999999999999
  }));
  assert.ok(v3Standard.recipe.brightness > v2Standard.recipe.brightness, "v3 preserves the airy lift");
  assert.ok(v3Standard.recipe.contrast > v2Standard.recipe.contrast && v3Standard.recipe.contrast < 0, "v3 softens rather than flattens contrast");
  assert.ok(v3Standard.recipe.saturation > v2Standard.recipe.saturation && v3Standard.recipe.saturation < 0, "v3 restores color life while retaining restraint");
  assert.ok(v3Standard.recipe.temperature < v2Standard.recipe.temperature && v3Standard.recipe.temperature > 0, "v3 remains warm without v2's blanket warmth");
  assert.ok(v3Standard.recipe.shadows > 0 && v3Standard.recipe.highlights > 0 && v3Standard.recipe.vibrance > 0, "v3 uses bounded tonal and selective-color shaping");

  assert.deepEqual(buildVisualAdjustmentFilters(v1Standard.recipe), [
    "eq=brightness=0.0725:contrast=0.7527:saturation=0.7370",
    "colorbalance=rs=0.0392:gs=-0.0155:bs=-0.0392:rm=0.0523:gm=-0.0155:bm=-0.0523:rh=0.0392:gh=-0.0155:bh=-0.0392:pl=1"
  ]);
  assert.deepEqual(buildStyleRecipeFilters(v2Standard.recipe), [
    "eq=brightness=0.0534:contrast=0.7949:saturation=0.7527",
    "colorbalance=rs=0.0392:gs=-0.0155:bs=-0.0392:rm=0.0523:gm=-0.0155:bm=-0.0523:rh=0.0392:gh=-0.0155:bh=-0.0392:pl=1"
  ], "v2 retains its historical filter chain");
  assert.deepEqual(buildStyleProfileFilters({ profileId: "soft_nostalgic", strength: "standard" }), [
    "curves=master='0/0 0.25/0.2696 0.75/0.7639 1/1'",
    "eq=brightness=0.0635:contrast=0.9007:saturation=0.8731",
    "vibrance=intensity=0.1089:rbal=1:gbal=1:bbal=1:alternate=0",
    "colorbalance=rs=0.0354:gs=-0.0134:bs=-0.0354:rm=0.0472:gm=-0.0134:bm=-0.0472:rh=0.0354:gh=-0.0134:bh=-0.0354:pl=1"
  ]);
});

test("B1 dark moody v2 preserves practical-light color and low-key structure without v1 blanket darkening", () => {
  const v1Recipe = canonicalStyleRecipe({ brightness: -0.16, contrast: 0.24, saturation: -0.1, temperature: -0.04, tint: -0.03 });
  const v2Recipe = canonicalStyleRecipe({ brightness: -0.045, contrast: 0.16, saturation: -0.02, temperature: -0.03, tint: -0.01, shadows: 0.12, highlights: 0.15, vibrance: 0.1 });
  const founderLockedProfiles = {
    clean_commercial: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0.075, contrast: 0.31, saturation: 0.12, temperature: 0.05, tint: 0 }) },
    warm_travel: { profileVersion: 1, recipe: canonicalStyleRecipe({ brightness: 0.05, contrast: 0.16, saturation: 0.16, temperature: 0.24, tint: 0.01 }) },
    cinematic: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0, contrast: 0.23, saturation: -0.08, temperature: 0.05, tint: -0.02 }) },
    soft_nostalgic: { profileVersion: 3, recipe: canonicalStyleRecipe({ brightness: 0.055, contrast: -0.035, saturation: -0.055, temperature: 0.1, tint: 0.015, shadows: 0.1, highlights: 0.08, vibrance: 0.12 }) },
    vibrant_social: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0.025, contrast: 0.06, saturation: 0.025, temperature: 0, tint: 0, shadows: 0.04, highlights: 0.03, vibrance: 0.18 }) },
    natural_documentary: { profileVersion: 2, recipe: canonicalStyleRecipe({ brightness: 0.045, contrast: 0.22, saturation: 0.075, temperature: 0.015, tint: 0 }) }
  };

  assert.deepEqual(resolveStyleProfile("dark_moody", 1).recipe, v1Recipe, "dark moody v1 remains reproducible");
  assert.deepEqual(resolveCurrentStyleProfile("dark_moody"), {
    profileId: "dark_moody",
    profileVersion: 2,
    recipe: v2Recipe
  });
  for (const [profileId, expected] of Object.entries(founderLockedProfiles)) {
    assert.deepEqual(resolveCurrentStyleProfile(profileId), { profileId, ...expected }, `${profileId} remains unchanged`);
  }

  for (const strength of ["subtle", "standard", "strong"]) {
    const compiled = compileStyleProfile({ profileId: "dark_moody", strength });
    const factor = STYLE_PROFILE_STRENGTHS[strength];
    for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
      assert.equal(compiled.recipe[field], v2Recipe[field] * factor, `dark moody v2 ${strength} ${field}`);
      assert.ok(compiled.recipe[field] >= -1 && compiled.recipe[field] <= 1, `dark moody v2 ${strength} ${field} remains bounded`);
    }
  }

  const v1Standard = compileStyleProfile({ profileId: "dark_moody", profileVersion: 1, strength: "standard" });
  const v2Standard = compileStyleProfile({ profileId: "dark_moody", strength: "standard" });
  assert.deepEqual(v2Standard.recipe, canonicalStyleRecipe({
    brightness: -0.0315,
    contrast: 0.11199999999999999,
    saturation: -0.013999999999999999,
    temperature: -0.020999999999999998,
    tint: -0.006999999999999999,
    shadows: 0.08399999999999999,
    highlights: 0.105,
    vibrance: 0.06999999999999999
  }));
  assert.ok(v2Standard.recipe.brightness > v1Standard.recipe.brightness && v2Standard.recipe.brightness < 0, "v2 remains low-key without v1 blanket darkening");
  assert.ok(v2Standard.recipe.contrast > 0 && v2Standard.recipe.contrast < v1Standard.recipe.contrast, "v2 retains controlled tonal separation");
  assert.ok(v2Standard.recipe.saturation > v1Standard.recipe.saturation, "v2 preserves more practical-light color than v1");
  assert.ok(v2Standard.recipe.shadows > 0 && v2Standard.recipe.highlights > 0 && v2Standard.recipe.vibrance > 0, "v2 uses bounded tonal structure and selective color");

  assert.deepEqual(buildVisualAdjustmentFilters(v1Standard.recipe), [
    "eq=brightness=-0.1155:contrast=1.2927:saturation=0.8232",
    "colorbalance=rs=-0.0213:gs=0.0193:bs=0.0213:rm=-0.0285:gm=0.0193:bm=0.0285:rh=-0.0213:gh=0.0193:bh=0.0213:pl=1"
  ]);
  assert.deepEqual(buildStyleProfileFilters({ profileId: "dark_moody", strength: "standard" }), [
    "curves=master='0/0 0.25/0.2718 0.75/0.7698 1/1'",
    "eq=brightness=-0.0569:contrast=1.2311:saturation=0.9264",
    "vibrance=intensity=0.0982:rbal=1:gbal=1:bbal=1:alternate=0",
    "colorbalance=rs=-0.0183:gs=0.0108:bs=0.0183:rm=-0.0244:gm=0.0108:bm=0.0244:rh=-0.0183:gh=0.0108:bh=0.0183:pl=1"
  ]);
});

test("B1 internal tone and vibrance primitives are bounded, deterministic, and legacy-neutral", () => {
  assert.deepEqual(CANONICAL_VISUAL_RECIPE_FIELDS, ["brightness", "contrast", "saturation", "temperature", "tint", "shadows", "highlights", "vibrance", "blackLift", "midtoneGamma"]);
  assert.deepEqual(createCanonicalVisualRecipe({ brightness: 0.2 }), canonicalStyleRecipe({ brightness: 0.2, contrast: 0, saturation: 0, temperature: 0, tint: 0 }));
  for (const field of ["shadows", "highlights", "vibrance", "blackLift", "midtoneGamma"]) {
    assert.throws(() => createCanonicalVisualRecipe({ [field]: 1.01 }), new RegExp(`${field} must be a finite number`));
    assert.throws(() => createCanonicalVisualRecipe({ [field]: -1.01 }), new RegExp(`${field} must be a finite number`));
    assert.throws(() => createCanonicalVisualRecipe({ [field]: Number.NaN }), new RegExp(`${field} must be a finite number`));
  }

  assert.deepEqual(buildToneCurvePoints(), { shadowPoint: 0.25, highlightPoint: 0.75 });
  assert.deepEqual(buildToneCurvePoints({ shadows: 1, highlights: 1 }), { shadowPoint: 0.35, highlightPoint: 0.83 });
  assert.deepEqual(buildToneCurvePoints({ shadows: -1, highlights: -1 }), { shadowPoint: 0.15, highlightPoint: 0.67 });
  for (const values of [{ shadows: -1, highlights: 1 }, { shadows: 1, highlights: -1 }]) {
    const { shadowPoint, highlightPoint } = buildToneCurvePoints(values);
    assert.ok(shadowPoint >= 0.08 && shadowPoint <= 0.42);
    assert.ok(highlightPoint >= shadowPoint + 0.12 && highlightPoint <= 0.94);
  }
  assert.equal(buildToneCurveFilter(), null);
  assert.equal(buildVibranceFilter(), null);
  const portableToneCurve = buildToneCurveFilter({ shadows: 1, highlights: -1 });
  assert.equal(portableToneCurve, "curves=master='0/0 0.25/0.3500 0.75/0.6700 1/1'");
  assert.equal(portableToneCurve.includes("interp="), false, "server-owned curves omit unsupported interpolation options");
  assert.equal(buildVibranceFilter({ vibrance: 1 }), "vibrance=intensity=0.5000:rbal=1:gbal=1:bbal=1:alternate=0");
  assert.equal(buildVibranceFilter({ vibrance: -1 }), "vibrance=intensity=-0.5000:rbal=1:gbal=1:bbal=1:alternate=0");
  assert.throws(() => buildToneCurveFilter({ shadows: Infinity }), /shadows must be a finite number/);
  assert.throws(() => buildVibranceFilter({ vibrance: -2 }), /vibrance must be a finite number/);

  const extendedRecipe = canonicalStyleRecipe({ brightness: 0.1, contrast: 0.1, saturation: 0.05, temperature: 0.03, tint: -0.02, shadows: 0.5, highlights: -0.5, vibrance: 0.4 });
  assert.deepEqual(buildStyleRecipeFilters(extendedRecipe), [
    "curves=master='0/0 0.25/0.3135 0.75/0.6992 1/1'",
    "eq=brightness=0.0866:contrast=1.1775:saturation=1.1466",
    "vibrance=intensity=0.2755:rbal=1:gbal=1:bbal=1:alternate=0",
    "colorbalance=rs=0.0199:gs=0.0188:bs=-0.0199:rm=0.0266:gm=0.0188:bm=-0.0266:rh=0.0199:gh=0.0188:bh=-0.0199:pl=1"
  ]);

  const legacyFilterChains = {
    "clean_commercial@1": ["eq=brightness=0.0427:contrast=1.2156:saturation=1.1205", "colorbalance=rs=0.0133:gs=0.0000:bs=-0.0133:rm=0.0177:gm=0.0000:bm=-0.0177:rh=0.0133:gh=0.0000:bh=-0.0133:pl=1"],
    "clean_commercial@2": ["eq=brightness=0.0602:contrast=1.2795:saturation=1.1960", "colorbalance=rs=0.0217:gs=0.0000:bs=-0.0217:rm=0.0289:gm=0.0000:bm=-0.0289:rh=0.0217:gh=0.0000:bh=-0.0217:pl=1"],
    "warm_travel@1": ["eq=brightness=0.0482:contrast=1.1895:saturation=1.2311", "colorbalance=rs=0.0527:gs=-0.0108:bs=-0.0527:rm=0.0702:gm=-0.0108:bm=-0.0702:rh=0.0527:gh=-0.0108:bh=-0.0527:pl=1"],
    "cinematic@1": ["eq=brightness=-0.0534:contrast=1.3342:saturation=0.8439", "colorbalance=rs=0.0241:gs=0.0155:bs=-0.0241:rm=0.0321:gm=0.0155:bm=-0.0321:rh=0.0241:gh=0.0155:bh=-0.0241:pl=1"],
    "cinematic@2": ["eq=brightness=0.0000:contrast=1.2854:saturation=0.8439", "colorbalance=rs=0.0241:gs=0.0155:bs=-0.0241:rm=0.0321:gm=0.0155:bm=-0.0321:rh=0.0241:gh=0.0155:bh=-0.0241:pl=1"],
    "soft_nostalgic@1": ["eq=brightness=0.0725:contrast=0.7527:saturation=0.7370", "colorbalance=rs=0.0392:gs=-0.0155:bs=-0.0392:rm=0.0523:gm=-0.0155:bm=-0.0523:rh=0.0392:gh=-0.0155:bh=-0.0392:pl=1"],
    "soft_nostalgic@2": ["eq=brightness=0.0534:contrast=0.7949:saturation=0.7527", "colorbalance=rs=0.0392:gs=-0.0155:bs=-0.0392:rm=0.0523:gm=-0.0155:bm=-0.0523:rh=0.0392:gh=-0.0155:bh=-0.0392:pl=1"],
    "vibrant_social@1": ["eq=brightness=0.0427:contrast=1.1895:saturation=1.3207", "colorbalance=rs=0.0165:gs=0.0000:bs=-0.0165:rm=0.0219:gm=0.0000:bm=-0.0219:rh=0.0165:gh=0.0000:bh=-0.0165:pl=1"],
    "dark_moody@1": ["eq=brightness=-0.1155:contrast=1.2927:saturation=0.8232", "colorbalance=rs=-0.0213:gs=0.0193:bs=0.0213:rm=-0.0285:gm=0.0193:bm=0.0285:rh=-0.0213:gh=0.0193:bh=0.0213:pl=1"],
    "natural_documentary@1": ["eq=brightness=0.0253:contrast=1.1280:saturation=1.0736", "colorbalance=rs=0.0092:gs=0.0000:bs=-0.0092:rm=0.0123:gm=0.0000:bm=-0.0123:rh=0.0092:gh=0.0000:bh=-0.0092:pl=1"],
    "natural_documentary@2": ["eq=brightness=0.0455:contrast=1.2280:saturation=1.1506", "colorbalance=rs=0.0114:gs=0.0000:bs=-0.0114:rm=0.0152:gm=0.0000:bm=-0.0152:rh=0.0114:gh=0.0000:bh=-0.0114:pl=1"]
  };
  for (const [key, expectedFilters] of Object.entries(legacyFilterChains)) {
    const [profileId, version] = key.split("@");
    const profileVersion = Number(version);
    const recipe = compileStyleProfile({ profileId, profileVersion, strength: "standard" }).recipe;
    assert.equal(recipe.shadows, 0, `${profileId} v${profileVersion} defaults shadows to neutral`);
    assert.equal(recipe.highlights, 0, `${profileId} v${profileVersion} defaults highlights to neutral`);
    assert.equal(recipe.vibrance, 0, `${profileId} v${profileVersion} defaults vibrance to neutral`);
    assert.equal(recipe.blackLift, 0, `${profileId} v${profileVersion} defaults blackLift to neutral`);
    assert.equal(recipe.midtoneGamma, 0, `${profileId} v${profileVersion} defaults midtoneGamma to neutral`);
    assert.deepEqual(buildStyleRecipeFilters(recipe), expectedFilters, `${profileId} v${profileVersion} preserves its exact legacy filter chain`);
    assert.deepEqual(buildStyleRecipeFilters(recipe), buildVisualAdjustmentFilters(recipe), `${profileId} v${profileVersion} emits no extended filter`);
  }
});

test("B2 Stage 0 canonical reference treatments add bounded black and midtone controls without changing B1", () => {
  const neutral = createCanonicalReferenceStyleTreatment();
  assert.deepEqual(neutral, { version: REFERENCE_STYLE_TREATMENT_VERSION, recipe: { ...NEUTRAL_VISUAL_RECIPE, shadowTemperature: 0, midtoneTemperature: 0, highlightTemperature: 0 } });
  assert.equal(Object.isFrozen(neutral), true);
  assert.equal(Object.isFrozen(neutral.recipe), true);
  assert.throws(() => createCanonicalReferenceStyleTreatment(null), /treatment must be a plain object/);
  assert.throws(() => createCanonicalReferenceStyleTreatment({ profileId: "cinematic" }), /unsupported treatment field/);
  assert.throws(() => createCanonicalReferenceStyleTreatment({ version: 3 }), /unsupported version/);
  assert.throws(() => createCanonicalReferenceStyleTreatment({ recipe: { blackLift: 1.01 } }), /blackLift must be a finite number/);
  assert.throws(() => createCanonicalReferenceStyleTreatment({ recipe: { midtoneGamma: -1.01 } }), /midtoneGamma must be a finite number/);

  const treatment = createCanonicalReferenceStyleTreatment({
    recipe: {
      brightness: 0.1, contrast: 0.1, saturation: 0.05, temperature: 0.1, tint: -0.05,
      shadows: 0.2, highlights: -0.2, vibrance: 0.2, blackLift: 0.5, midtoneGamma: 0.5
    }
  });
  assert.deepEqual(buildReferenceStyleTreatmentFilters(treatment.recipe), [
    "eq=brightness=0.0866:contrast=1.1775:saturation=1.1466:gamma=1.1142",
    "vibrance=intensity=0.1803:rbal=1:gbal=1:bbal=1:alternate=0",
    "colorbalance=rs=0.0390:gs=0.0309:bs=-0.0390:rm=0.0520:gm=0.0309:bm=-0.0520:rh=0.0390:gh=0.0309:bh=-0.0390:pl=0",
    "curves=master='0/0.0349 0.25/0.2861 0.75/0.7211 1/0.9800'"
  ]);
  assert.deepEqual(buildReferenceToneCurvePoints({ blackLift: 1 }), { blackPoint: 0.055, shadowPoint: 0.25, highlightPoint: 0.75 });
  assert.deepEqual(buildReferenceToneCurvePoints({ blackLift: -1 }), { blackPoint: 0, shadowPoint: 0.21, highlightPoint: 0.75 });
  assert.equal(buildReferenceToneCurveFilter({ blackLift: 0, shadows: 0.2 }), buildToneCurveFilter({ shadows: 0.2 }), "neutral B2 black control delegates to the legacy curve exactly");
  assert.throws(() => buildReferenceToneCurveFilter({ blackLift: Infinity }), /blackLift must be a finite number/);

  for (const profileId of STYLE_PROFILE_IDS) {
    const recipe = compileStyleProfile({ profileId, strength: "standard" }).recipe;
    assert.equal(recipe.blackLift, 0, `${profileId} leaves blackLift neutral`);
    assert.equal(recipe.midtoneGamma, 0, `${profileId} leaves midtoneGamma neutral`);
    const b1Filters = buildStyleRecipeFilters(recipe);
    const b2Filters = buildReferenceStyleTreatmentFilters(recipe);
    const hasReferenceColorBalance = recipe.temperature !== 0 || recipe.tint !== 0;
    assert.deepEqual(
      b2Filters,
      hasReferenceColorBalance
        ? [
          ...b1Filters.filter((filter) => !filter.startsWith("curves=")).map((filter) => filter.startsWith("colorbalance=") ? filter.replace(":pl=1", ":pl=0") : filter),
          buildReferenceToneCurveFilter(recipe, { protectColorbalanceHighlights: true })
        ]
        : b1Filters,
      `${profileId} keeps B1's ordering and bounded values while B2 disables colorbalance's unsafe lightness-preservation branch`
    );
  }
});

test("B2 Stage 0 RGB24 headroom metrics are deterministic and bounded", () => {
  const frame = Uint8Array.from([
    0, 0, 0,
    128, 128, 128,
    255, 255, 255,
    255, 0, 0
  ]);
  const metrics = measureReferenceRgbFrame(frame);
  assert.deepEqual(metrics, {
    version: REFERENCE_FRAME_METRICS_VERSION,
    lumaP05: 0,
    lumaP50: 54 / 255,
    lumaP95: 1,
    lumaP99: 1,
    nearBlackFraction: 0.25,
    nearWhiteFraction: 0.25,
    saturationIndex: 0.25
  });
  assert.throws(() => measureReferenceRgbFrame(new Uint8Array()), /non-empty RGB24/);
  assert.throws(() => measureReferenceRgbFrame(Uint8Array.from([1, 2])), /RGB24/);
  assert.deepEqual(summarizeReferenceFrameMetrics([metrics, {
    ...metrics, lumaP50: 0.25, saturationIndex: 0.75
  }]), {
    lumaP05: 0,
    lumaP50: (0.25 + (54 / 255)) / 2,
    lumaP95: 1,
    lumaP99: 1,
    nearBlackFraction: 0.25,
    nearWhiteFraction: 0.25,
    saturationIndex: 0.5
  });
  assert.throws(() => summarizeReferenceFrameMetrics([]), /non-empty array/);
  assert.throws(() => summarizeReferenceFrameMetrics([{ ...metrics, lumaP95: 2 }]), /lumaP95 must be a finite number/);
});

test("B2A reference style contracts keep private image metadata separate and derive bounded target-aware treatments", () => {
  assert.deepEqual(validateReferenceManifest({ name: "look.jpg", type: "image/jpeg", size: 42 }), { kind: "image", name: "look.jpg", type: "image/jpeg", size: 42 });
  assert.equal(validateReferenceManifest(null), null);
  assert.throws(() => validateReferenceManifest({ name: "look.gif", type: "image/gif", size: 42 }), /JPG, PNG, or WebP/);
  assert.throws(() => validateReferenceManifest({ name: "look.jpg", type: "image/jpeg", size: MAX_REFERENCE_IMAGE_BYTES + 1 }), /25 MB/);
  assert.equal(requestsReferenceStyleMatch("Make my video look like this.", true), true);
  assert.equal(requestsReferenceStyleMatch("Make my video look like this.", false), false);
  const analysis = {
    safe: true,
    reference: { context: "lifestyle", peopleOrSkin: true, exposure: "high", saturation: "high", warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange", highlightCharacter: "flash", blackCharacter: "deep", saturationCharacter: "rich", colorSeparation: "editorial" },
    target: { context: "portrait", coherent: true, peopleOrSkin: true, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "muted", colorSeparation: "neutral", compatible: true },
    treatment: { exposure: "raise", exposureIntensity: "strong", contrast: "raise", contrastIntensity: "strong", blacks: "lower", blackIntensity: "strong", highlights: "lower", highlightIntensity: "strong", color: "raise", colorIntensity: "strong", warmth: "warm", warmthIntensity: "strong", ambientColorCharacter: "warm_golden", highlightCharacter: "flash", colorSeparation: "editorial", mood: "luminous" }
  };
  assert.equal(referenceStyleAnalysisSchema().additionalProperties, false);
  const treatment = deriveReferenceStyleTreatment({ analysis, metrics: { lumaP05: 0.02, lumaP50: 0.45, lumaP95: 0.96, nearBlackFraction: 0.1, nearWhiteFraction: 0.05, saturationIndex: 0.8 } });
  assert.equal(treatment.version, 2);
  assert.equal(treatment.recipe.brightness, 0.07, "near-clipped targets cap reference-directed exposure lift");
  assert.equal(treatment.recipe.saturation, 0.08, "warm human targets retain color while capping the combined orange pressure");
  assert.equal(treatment.recipe.temperature, 0.075, "warm human targets use a restrained global warmth envelope");
  assert.equal(treatment.recipe.shadows, 0, "underexposed targets do not deepen blacks");
  assert.throws(() => validateReferenceStyleAnalysis({ ...analysis, safe: false }), (error) => error instanceof ReferenceStyleError && error.message === REFERENCE_STYLE_SAFE_ERROR);
  assert.throws(() => deriveReferenceStyleTreatment({ analysis: { ...analysis, target: { ...analysis.target, coherent: false } }, metrics: { lumaP05: 0.1, lumaP50: 0.5, lumaP95: 0.8, nearBlackFraction: 0, nearWhiteFraction: 0, saturationIndex: 0.2 } }), /visually coherent footage/);
  const plan = validateEditPlan({ version: "1", operations: [{ type: "reference_style_treatment", treatment }] });
  assert.equal(plan.operations[0].treatment.recipe.temperature, 0.075);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "reference_style_treatment", sourceId: "source-1", treatment }] }), /sourceId is supported only/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "reference_style_treatment", treatment }, { type: "style_profile", profileId: "cinematic" }] }), /conflicts with named visual styles/);
  const diagnostic = createReferenceStyleDiagnostic({ jobId: "job-safe", analysis, metrics: { lumaP05: 0.02, lumaP50: 0.45, lumaP95: 0.96, nearBlackFraction: 0.1, nearWhiteFraction: 0.05, saturationIndex: 0.8 }, treatment });
  assert.equal(diagnostic.referenceSignature.context, "lifestyle");
  assert.equal(diagnostic.targetSignature.context, "portrait");
  assert.equal(diagnostic.derivedDelta.warmth, "raise");
  assert.deepEqual(diagnostic.recipe, treatment.recipe);
  assert.ok(diagnostic.filters.every((filter) => typeof filter === "string"));
  assert.doesNotMatch(JSON.stringify(diagnostic), /uri|path|secret|token|https?:/i);
});

test("RV-0 keeps a bounded video reference distinct from editable sources and gated by server capability", async () => {
  const image = { name: "look.jpg", type: "image/jpeg", size: 42 };
  const videoReference = { kind: "video", name: "inspiration.mov", type: "video/quicktime", size: 1024 };
  assert.deepEqual(validateReferenceManifest(image), { kind: "image", ...image }, "legacy image metadata remains compatible");
  assert.throws(() => validateReferenceManifest({ name: "implicit.mp4", type: "video/mp4", size: 3 }, { videoReferenceEnabled: false }), /include kind/);
  assert.throws(() => validateReferenceManifest(videoReference, { videoReferenceEnabled: false }), /not available yet/);
  assert.deepEqual(validateReferenceManifest(videoReference, { videoReferenceEnabled: true }), videoReference);
  assert.throws(() => validateReferenceManifest({ ...videoReference, type: "video/avi" }, { videoReferenceEnabled: true }), /MP4, MOV, WebM, or MKV/);
  assert.throws(() => validateReferenceManifest({ ...videoReference, size: MAX_REFERENCE_VIDEO_BYTES + 1 }, { videoReferenceEnabled: true }), /250 MB/);
  assert.throws(() => validateReferenceManifest({ kind: "video", name: "contradictory.jpg", type: "image/jpeg", size: 3 }, { videoReferenceEnabled: true }), /kind and media type do not match/);

  const actualMedia = { format: { duration: "12.5", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" }, { codec_type: "audio", codec_name: "aac" }] };
  const decode = async () => [3.125, 6.25, 9.375];
  const media = await validateReferenceVideoFile({ inputPath: "/private/reference.mov", type: "video/quicktime", probe: async () => actualMedia, decode });
  assert.deepEqual(media, { duration: 12.5, width: 1920, height: 1080, videoCodec: "h264", frameRate: 30000 / 1001, hasAudio: true, container: "mov", decodedFrameTimestamps: [3.125, 6.25, 9.375] });
  const sampling = createReferenceVideoSamplingPlan(media);
  assert.equal(sampling.version, 1);
  assert.equal(sampling.moments.length, 2, "future temporal analysis is bounded without running it");
  assert.deepEqual(sampling.moments.map((moment) => moment.momentId), ["reference-moment-1", "reference-moment-2"]);
  for (const malformed of [
    { format: { duration: "12" }, streams: [] },
    { format: { duration: String(MAX_REFERENCE_VIDEO_DURATION_SECONDS + 1), format_name: "mov,mp4,m4a,3gp,3g2,mj2" }, streams: actualMedia.streams },
    { format: { duration: "12", format_name: "image2" }, streams: actualMedia.streams },
    { format: { duration: "12", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }, streams: [{ codec_type: "video", codec_name: "h264", width: 10, height: 10, avg_frame_rate: "24/1" }] }
  ]) {
    await assert.rejects(() => validateReferenceVideoFile({ inputPath: "/private/misleading.mp4", type: "video/mp4", probe: async () => malformed, decode }), (error) => error instanceof ReferenceVideoError && error.reason === "REFERENCE_VIDEO_INVALID_MEDIA");
  }
  const cancelled = createExecutionController();
  cancelled.cancel();
  await assert.rejects(() => validateReferenceVideoFile({ inputPath: "/private/cancelled.mp4", type: "video/mp4", executionController: cancelled, probe: async () => actualMedia, decode }), EditExecutionCancelledError, "reference validation observes the job-owned cancellation controller");
  cancelled.dispose();

  assert.throws(() => assertReferenceVideoFoundationEnabled({}), (error) => error instanceof ReferenceVideoError && error.reason === "REFERENCE_VIDEO_DISABLED");
  assert.doesNotThrow(() => assertReferenceVideoFoundationEnabled({ REFERENCE_VIDEO_STYLE_MATCHING_ENABLED: "true" }));
  assert.throws(() => assertReferenceVideoMatchingImplemented(), (error) => error instanceof ReferenceVideoError && error.reason === "REFERENCE_VIDEO_MATCHING_NOT_IMPLEMENTED", "the gate cannot activate an unfinished matching engine");

  const referenceKey = referenceObjectKey("job-safe", "video");
  const sourceKeys = [sourceObjectKey("job-safe", 0), sourceObjectKey("job-safe", 1)];
  assert.equal(referenceKey, "jobs/job-safe/reference/video");
  assert.ok(!sourceKeys.includes(referenceKey));
  assert.deepEqual(jobInputObjectKeys({ sources: sourceKeys.map((key) => ({ key })), reference: { key: referenceKey } }), [...sourceKeys, referenceKey], "retention cleanup includes the private video reference without putting it in source order");
  const catalog = createSourceCatalog([{ index: 0, name: "creator.mp4", type: "video/mp4", size: 1 }], [{ duration: 5, width: 640, height: 360, hasAudio: true }]);
  assert.deepEqual(catalog.map((source) => source.sourceId), ["source-1"], "reference media cannot obtain a source ID, timeline clip, or export slot");
});

test("RV-0 reference video dimensions are orientation-independent and frame rates stay bounded", async () => {
  const base = { format: { duration: "20", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }, streams: [{ codec_type: "video", codec_name: "h264", width: 3840, height: 2160, avg_frame_rate: "30000/1001" }] };
  const verify = (data) => validateReferenceVideoFile({ inputPath: "/private/reference.mp4", type: "video/mp4", probe: async () => data, decode: async () => [] });
  assert.equal((await verify(base)).width, 3840, "landscape 4K is accepted");
  assert.equal((await verify({ ...base, streams: [{ ...base.streams[0], width: 2160, height: 3840 }] })).height, 3840, "portrait 4K is accepted");
  assert.equal((await verify({ ...base, streams: [{ ...base.streams[0], width: 1080, height: 1920, avg_frame_rate: "60/1" }] })).height, 1920, "ordinary vertical creator footage is accepted");
  for (const stream of [
    { ...base.streams[0], width: 3841, height: 2160 },
    { ...base.streams[0], width: 3000, height: 3000 },
    { ...base.streams[0], avg_frame_rate: "0/0" },
    { ...base.streams[0], avg_frame_rate: "240/1" }
  ]) {
    await assert.rejects(() => verify({ ...base, streams: [stream] }), (error) => error instanceof ReferenceVideoError && error.reason === "REFERENCE_VIDEO_INVALID_MEDIA");
  }
});

test("RV-0 bounded frame decoding samples representative frames and stops on cancellation or decode failure", async () => {
  const commands = [];
  const timestamps = await decodeReferenceVideoFrames({
    inputPath: "/private/reference.mp4", duration: 20,
    run: async (command, args, options) => { commands.push({ command, args, options }); return { stdout: "", stderr: "" }; }
  });
  assert.deepEqual(timestamps, [5, 10, 15]);
  assert.equal(commands.length, 3);
  assert.ok(commands.every(({ command, args }) => command === "ffmpeg" && args.includes("scale=320:-2") && args.includes("-frames:v")), "decode work is fixed to three reduced-resolution frames");
  const controller = createExecutionController();
  let calls = 0;
  await assert.rejects(() => decodeReferenceVideoFrames({
    inputPath: "/private/reference.mp4", duration: 20, executionController: controller,
    run: async () => { calls += 1; controller.cancel(); throw new EditExecutionCancelledError(); }
  }), EditExecutionCancelledError);
  assert.equal(calls, 1, "cancellation stops later representative-frame probes");
  controller.dispose();
  await assert.rejects(() => decodeReferenceVideoFrames({ inputPath: "/private/broken.mp4", duration: 20, run: async () => { throw new Error("broken packets"); } }), (error) => error instanceof ReferenceVideoError && error.reason === "REFERENCE_VIDEO_INVALID_MEDIA");
});

test("B2A reference-directed signatures retain strong bounded authority while skin protects only hue axes", () => {
  const analysis = {
    safe: true,
    reference: { context: "lifestyle", peopleOrSkin: true, exposure: "high", saturation: "high", warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint", highlightCharacter: "flash", blackCharacter: "deep", saturationCharacter: "rich", colorSeparation: "editorial" },
    target: { context: "portrait", coherent: true, peopleOrSkin: true, exposure: "medium", saturation: "low", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "muted", colorSeparation: "neutral", compatible: true },
    treatment: { exposure: "raise", exposureIntensity: "strong", contrast: "raise", contrastIntensity: "strong", blacks: "lower", blackIntensity: "standard", highlights: "raise", highlightIntensity: "strong", color: "raise", colorIntensity: "strong", warmth: "cool", warmthIntensity: "strong", ambientColorCharacter: "cool_mint", highlightCharacter: "flash", colorSeparation: "editorial", mood: "rich" }
  };
  const treatment = deriveReferenceStyleTreatment({ analysis, metrics: { lumaP05: 0.18, lumaP50: 0.71, lumaP95: 0.8, lumaP99: 0.82, nearBlackFraction: 0, nearWhiteFraction: 0, saturationIndex: 0.105 } });
  assert.deepEqual(treatment.recipe, {
    brightness: 0.14, contrast: 0.14, saturation: 0.22, temperature: -0.12, tint: -0.055,
    shadows: -0.1, highlights: 0.15, vibrance: 0.32, blackLift: -0.14, midtoneGamma: 0.11,
    shadowTemperature: 0, midtoneTemperature: 0, highlightTemperature: 0
  });
  assert.ok(buildReferenceStyleTreatmentFilters(treatment.recipe).length >= 4);
});

test("B2A warm-golden human footage uses a restrained combined treatment while landscapes retain warmth", () => {
  const reference = { context: "lifestyle", peopleOrSkin: true, exposure: "high", saturation: "high", warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange", highlightCharacter: "flash", blackCharacter: "deep", saturationCharacter: "rich", colorSeparation: "editorial" };
  const target = { context: "portrait", coherent: true, peopleOrSkin: true, exposure: "medium", saturation: "low", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "muted", colorSeparation: "neutral", compatible: true };
  const metrics = { lumaP05: 0.18, lumaP50: 0.48, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0, nearWhiteFraction: 0, saturationIndex: 0.1 };
  const human = deriveReferenceStyleTreatment({ analysis: { safe: true, reference, target }, metrics }).recipe;
  const landscape = deriveReferenceStyleTreatment({ analysis: { safe: true, reference, target: { ...target, context: "landscape", peopleOrSkin: false } }, metrics }).recipe;
  assert.deepEqual(
    { temperature: human.temperature, tint: human.tint, saturation: human.saturation, vibrance: human.vibrance, contrast: human.contrast, shadows: human.shadows, blackLift: human.blackLift },
    { temperature: 0.075, tint: 0.025, saturation: 0.08, vibrance: 0.12, contrast: 0.1, shadows: -0.04, blackLift: -0.06 },
    "human warm treatment limits the combined global color and density stack without claiming selective masking"
  );
  assert.ok(landscape.temperature > human.temperature && landscape.saturation > human.saturation && landscape.vibrance > human.vibrance, "non-human outdoor footage retains meaningful reference-directed golden treatment");
  assert.equal(human.brightness, landscape.brightness, "human safety does not unnecessarily remove reference-directed exposure support");
  assert.ok(buildReferenceStyleTreatmentFilters(human).at(-1).startsWith("curves=master="), "human treatment retains protected final curve ordering");
});

test("B2B typography reference analysis maps only registered title styling and preserves user title wording and timing", async () => {
  const prompt = "Use the typography from this reference and add the title 'A Day in Kerala' at 0:03.";
  const observed = { safe: true, typography: "single", candidates: [{ candidateId: "candidate-1", referenceText: "KERALA", role: "creative_title", prominence: "standard", fontCharacter: "serif", weight: "bold", caseStyle: "uppercase", size: "large", color: "yellow", colorLightness: "medium", colorTreatment: "balanced", position: "bottom-center", lineBreakStyle: "single_line" }] };
  const calls = { uploads: 0, deletes: [], requests: [] };
  const aiClient = {
    files: {
      upload: async () => ({ name: `reference-${++calls.uploads}`, uri: "gemini://private-reference", mimeType: "image/jpeg" }),
      delete: async ({ name }) => { calls.deletes.push(name); }
    },
    models: { generateContent: async (request) => { calls.requests.push(request); return { text: JSON.stringify(observed) }; } }
  };
  assert.equal(requestsTypographyReferenceMatch(prompt, true), true);
  assert.equal(requestsTypographyReferenceMatch(prompt, false), false);
  assert.equal(requestsReferenceStyleMatch(prompt, true), false, "typography intent must not enter B2A photographic matching");
  assert.equal(typographyReferenceAnalysisSchema().additionalProperties, false);
  const result = await analyzeTypographyReference({ referencePath: "/private/reference.jpg", referenceMimeType: "image/jpeg", aiClient });
  assert.deepEqual(result.treatment, { font: "instrumentSerif", weight: "bold", size: "large", color: "#F6D365", colorLightness: "medium", colorTreatment: "balanced", position: "bottom-center", caseStyle: "uppercase", lineBreakStyle: "single_line", heroDisplay: false, selectedCandidateId: "candidate-1" });
  assert.equal(calls.uploads, 1);
  assert.deepEqual(calls.deletes, ["reference-1"], "the scratch Gemini reference is cleaned exactly once");
  assert.equal(calls.requests.length, 1);
  assert.ok(!JSON.stringify(calls.requests[0]).includes("ffmpeg"), "analysis request exposes no rendering controls");

  const title = parseTitle(prompt, { stripQuotedText: true });
  assert.deepEqual(title, { text: "A Day in Kerala", start: 3, end: 6, position: "center", size: "medium", color: "white", weight: "regular", font: "inter" });
  assert.equal(parseTitle("Use typography from this reference and add the title ‘A Day in Kerala’ at 0:03.", { stripQuotedText: true }).text, "A Day in Kerala");
  const plan = reconcileTypographyReferenceTitlePlan({ version: "1", operations: [{ type: "captions" }, { type: "title", text: "wrong", start: 0, end: 1, position: "top-left", size: "small", color: "red", weight: "regular", font: "inter" }] }, title, result.treatment);
  const styledTitle = plan.operations.find((operation) => operation.type === "title");
  assert.deepEqual(styledTitle, {
    type: "title", text: "A Day in Kerala", start: 3, end: 6, position: "bottom-center", size: "large", color: "#F6D365", weight: "bold", font: "instrumentSerif", renderCaseStyle: "uppercase", readability: { mode: "target_aware" },
    runs: [{ text: "A Day in Kerala", font: "instrumentSerif", size: "large", color: "#F6D365", weight: "bold" }]
  });
  assert.equal(plan.operations.filter((operation) => operation.type === "title").length, 1, "reference styling never duplicates the title operation");
  assert.equal(plan.operations.some((operation) => operation.type === "captions"), true, "ordinary operations remain intact");
  assert.doesNotThrow(() => validateEditPlan(plan));
});

test("B2B typography references reject ambiguity, absent text, and unsafe or unsupported model output without fabricating a title style", () => {
  const candidate = { candidateId: "candidate-1", referenceText: "Title", role: "creative_title", prominence: "standard", fontCharacter: "sans_serif", weight: "regular", caseStyle: "as_supplied", size: "medium", color: "white", colorLightness: "light", colorTreatment: "balanced", position: "center", lineBreakStyle: "single_line" };
  const base = { safe: true, typography: "single", candidates: [candidate] };
  assert.deepEqual(deriveTypographyTitleTreatment(base), { font: "inter", weight: "regular", size: "medium", color: "#FFFFFF", colorLightness: "light", colorTreatment: "balanced", position: "center", caseStyle: "as_supplied", lineBreakStyle: "single_line", heroDisplay: false, selectedCandidateId: "candidate-1" });
  assert.equal(deriveTypographyTitleTreatment({ ...base, candidates: [{ ...candidate, fontCharacter: "monospace" }] }).font, "jetbrainsMono");
  assert.throws(() => deriveTypographyTitleTreatment({ ...base, typography: "multiple", candidates: [candidate, { ...candidate, candidateId: "candidate-2", referenceText: "Other", size: "large" }] }), (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_REFERENCE_AMBIGUOUS");
  assert.throws(() => deriveTypographyTitleTreatment({ ...base, typography: "none", candidates: [] }), (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_REFERENCE_NO_TEXT");
  assert.throws(() => deriveTypographyTitleTreatment({ ...base, safe: false }), (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_REFERENCE_SAFETY_REJECTED");
  assert.throws(() => validateTypographyReferenceAnalysis({ ...base, candidates: [{ ...candidate, fontCharacter: "Comic Sans", rawFfmpeg: "drawtext" }] }), (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_REFERENCE_INVALID_MODEL_RESPONSE");
  assert.throws(() => reconcileTypographyReferenceTitlePlan({ version: "1", operations: [] }, null, deriveTypographyTitleTreatment(base)), (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_TITLE_REQUIRED");
});

test("B2B typography analysis cleans its Gemini scratch image after a model failure", async () => {
  const deleted = [];
  const aiClient = {
    files: {
      upload: async () => ({ name: "reference-failure", uri: "gemini://private-reference", mimeType: "image/jpeg" }),
      delete: async ({ name }) => { deleted.push(name); }
    },
    models: { generateContent: async () => { throw new Error("temporary model failure"); } }
  };
  await assert.rejects(
    analyzeTypographyReference({ referencePath: "/private/reference.jpg", referenceMimeType: "image/jpeg", aiClient }),
    (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_REFERENCE_MODEL_REQUEST_FAILED"
  );
  assert.deepEqual(deleted, ["reference-failure"]);
});

test("B2B resolves an explicit creative-title selector while refusing unselected mixed typography and ignoring platform UI", () => {
  const candidate = (candidateId, referenceText, role, overrides = {}) => ({
    candidateId, referenceText, role, prominence: "standard", fontCharacter: "sans_serif", weight: "bold", caseStyle: "title_case", size: "medium", color: "white", colorLightness: "light", colorTreatment: "balanced", position: "center", lineBreakStyle: "single_line", ...overrides
  });
  const analysis = {
    safe: true,
    typography: "multiple",
    candidates: [
      candidate("candidate-1", "Blue Hours", "creative_title", { prominence: "high", fontCharacter: "serif", size: "large", color: "blue", position: "top-center" }),
      candidate("candidate-2", "A quiet evening by the coast", "supporting_text", { size: "small", color: "white", position: "bottom-center" }),
      candidate("candidate-3", "@creator", "platform_ui", { size: "small", color: "white", position: "top-left" })
    ]
  };
  assert.throws(() => deriveTypographyTitleTreatment(analysis), (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_REFERENCE_AMBIGUOUS");

  const bigBlueSelector = extractTypographyReferenceSelector("Use the typography of the big blue title in this reference and add the title 'Kerala Diaries' at 0:03.");
  assert.deepEqual(bigBlueSelector, { prominence: "high", color: "#4A90E2", role: "creative_title" });
  const selected = selectTypographyReferenceCandidate(analysis, bigBlueSelector);
  assert.equal(selected.candidateId, "candidate-1");
  assert.equal(deriveTypographyTitleTreatment(analysis, bigBlueSelector).font, "instrumentSerif");

  const textSelector = extractTypographyReferenceSelector("Use the font style of 'Blue Hours' in this reference and add the title 'My Trip' at 0:03.");
  assert.equal(textSelector.referenceText, "Blue Hours");
  assert.equal(selectTypographyReferenceCandidate(analysis, textSelector).candidateId, "candidate-1");
  assert.throws(() => deriveTypographyTitleTreatment(analysis, extractTypographyReferenceSelector("Use the font style of 'Missing Words' in this reference and add the title 'My Trip' at 0:03.")), (error) => error instanceof TypographyReferenceError && error.reason === "TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH");

  const onlyCreativePlusUi = { ...analysis, typography: "single", candidates: [analysis.candidates[0], analysis.candidates[2]] };
  assert.equal(deriveTypographyTitleTreatment(onlyCreativePlusUi).selectedCandidateId, "candidate-1", "platform UI cannot override a single clear creative title");
});

test("B2B Stage 3 matches grounded relative selectors and transfers only rendered reference casing", () => {
  const candidate = (candidateId, referenceText, overrides = {}) => ({
    candidateId, referenceText, role: "creative_title", prominence: "standard", fontCharacter: "sans_serif", weight: "bold", caseStyle: "title_case", size: "medium", color: "white", colorLightness: "light", colorTreatment: "balanced", position: "center", lineBreakStyle: "single_line", ...overrides
  });
  const analysis = {
    safe: true,
    typography: "multiple",
    candidates: [
      candidate("candidate-1", "BLUE HOURS", { prominence: "high", fontCharacter: "condensed_sans", caseStyle: "uppercase", size: "medium", color: "blue", position: "top-center" }),
      candidate("candidate-2", "A story from the coast", { role: "supporting_text", size: "large", color: "white", position: "bottom-center" }),
      candidate("candidate-3", "@creator", { role: "platform_ui", size: "small", position: "top-left" })
    ]
  };
  const bigBlue = extractTypographyReferenceSelector("Use the typography of the big blue title in this reference and add the title 'Kerala Diaries' at 0:03.");
  assert.equal(selectTypographyReferenceCandidate(analysis, bigBlue).candidateId, "candidate-1", "relative prominence must not reject a uniquely blue creative title categorized as medium");
  assert.equal(deriveTypographyTitleTreatment(analysis, bigBlue).font, "barlowCondensed");
  assert.equal(requestsTypographyReferenceMatch("Match the white serif heading in this screenshot and add the title 'Kerala' at 0:03.", true), true);
  const quoted = extractTypographyReferenceSelector("Use the font style of 'Blue Hours' in this reference and add the title 'The Journey Begins' at 0:03.");
  assert.equal(selectTypographyReferenceCandidate(analysis, quoted).candidateId, "candidate-1");
  assert.throws(() => selectTypographyReferenceCandidate(analysis, extractTypographyReferenceSelector("Use the font style of 'Not Present' in this reference and add the title 'Kerala' at 0:03.")), (error) => error.reason === "TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH");
  assert.throws(() => selectTypographyReferenceCandidate({ ...analysis, candidates: [candidate("candidate-1", "ONE", { color: "blue" }), candidate("candidate-2", "TWO", { color: "blue" })] }, bigBlue), (error) => error.reason === "TYPOGRAPHY_REFERENCE_AMBIGUOUS");

  const treatment = deriveTypographyTitleTreatment(analysis, bigBlue);
  const original = { text: "The Journey Begins", start: 3, end: 6, position: "center", size: "medium", color: "white", weight: "regular", font: "inter" };
  const plan = reconcileTypographyReferenceTitlePlan({ version: "1", operations: [] }, original, treatment);
  const title = plan.operations[0];
  assert.equal(title.text, "The Journey Begins", "canonical plan text remains user-authored");
  assert.equal(title.start, 3);
  assert.equal(title.end, 6);
  assert.equal(title.font, "barlowCondensed");
  assert.equal(title.renderCaseStyle, "uppercase");
  assert.match(buildAssDocument([title], { width: 1280, height: 720 }), /THE JOURNEY BEGINS/, "reference all-caps applies only while rendering");

  const preserve = deriveTypographyTitleTreatment(analysis, extractTypographyReferenceSelector("Use the font style of 'Blue Hours' in this reference, keep the original casing, and add the title 'The Journey Begins' at 0:03."));
  const preservePlan = reconcileTypographyReferenceTitlePlan({ version: "1", operations: [] }, original, preserve);
  assert.equal(preservePlan.operations[0].text, "The Journey Begins");
  assert.equal(preservePlan.operations[0].renderCaseStyle, "as_supplied");
  assert.match(buildAssDocument([preservePlan.operations[0]], { width: 1280, height: 720 }), /The Journey Begins/);
  assert.equal(deriveTypographyTitleTreatment({ safe: true, typography: "single", candidates: [candidate("candidate-1", "Modern", { fontCharacter: "sans_serif" })] }).font, "inter", "ordinary sans remains Inter");
});

test("B2B Stage 4 scores imperfect selector evidence safely and exposes only sanitized selection diagnostics", () => {
  const candidate = (candidateId, overrides = {}) => ({
    candidateId, referenceText: `internal-${candidateId}`, role: "creative_title", prominence: "standard", fontCharacter: "sans_serif", weight: "bold", caseStyle: "title_case", size: "medium", color: "white", colorLightness: "light", colorTreatment: "balanced", position: "center", lineBreakStyle: "single_line", ...overrides
  });
  const selector = extractTypographyReferenceSelector("Use the typography of the big blue title in this reference and add the title 'Kerala Diaries' at 0:03.");
  const imperfect = {
    safe: true, typography: "multiple", candidates: [
      candidate("candidate-1", { role: "supporting_text", prominence: "high", fontCharacter: "condensed_sans", caseStyle: "uppercase", color: "purple", position: "top-center" }),
      candidate("candidate-2", { role: "supporting_text", prominence: "standard", color: "white", size: "large", position: "bottom-center" }),
      candidate("candidate-3", { role: "platform_ui", prominence: "high", color: "blue", position: "top-left" })
    ]
  };
  assert.equal(selectTypographyReferenceCandidate(imperfect, selector).candidateId, "candidate-1", "adjacent blue/purple color plus high prominence grounds a uniquely plausible intended title even when its role is imperfect");
  assert.equal(deriveTypographyTitleTreatment(imperfect, selector).font, "barlowCondensed");

  const quoted = extractTypographyReferenceSelector("Use the font style of 'Visible Display' in this reference and add the title 'Kerala Diaries' at 0:03.");
  const quotedAnalysis = { ...imperfect, candidates: [{ ...imperfect.candidates[0], referenceText: "Visible Display" }, ...imperfect.candidates.slice(1)] };
  assert.equal(selectTypographyReferenceCandidate(quotedAnalysis, quoted).candidateId, "candidate-1");
  assert.throws(() => selectTypographyReferenceCandidate(quotedAnalysis, extractTypographyReferenceSelector("Use the font style of 'Missing Display' in this reference and add the title 'Kerala Diaries' at 0:03.")), (error) => error.reason === "TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH");

  const tied = { ...imperfect, candidates: [candidate("candidate-1", { prominence: "high", color: "blue" }), candidate("candidate-2", { prominence: "high", color: "blue" })] };
  assert.throws(() => selectTypographyReferenceCandidate(tied, selector), (error) => error.reason === "TYPOGRAPHY_REFERENCE_AMBIGUOUS" && error.selectionDiagnostic && error.selectionDiagnostic.candidateCount === 2 && error.selectionDiagnostic.candidates.every((entry) => !Object.hasOwn(entry, "referenceText")));
  assert.throws(() => selectTypographyReferenceCandidate({ safe: true, typography: "single", candidates: [candidate("candidate-1", { role: "platform_ui", color: "blue" })] }, selector), (error) => error.reason === "TYPOGRAPHY_REFERENCE_SELECTOR_NO_MATCH");
});

test("B2B Stage 4 derives a bounded reference-inspired hero display without altering ordinary titles", () => {
  const heroAnalysis = {
    safe: true, typography: "single", candidates: [{
      candidateId: "candidate-1", referenceText: "SIMON", role: "creative_title", prominence: "high", fontCharacter: "condensed_sans", weight: "bold", caseStyle: "uppercase", size: "large", color: "white", colorLightness: "light", colorTreatment: "balanced", position: "center", lineBreakStyle: "single_line"
    }]
  };
  const heroTreatment = deriveTypographyTitleTreatment(heroAnalysis);
  assert.equal(heroTreatment.heroDisplay, true);
  const requested = { text: "The Journey Begins", start: 3, end: 6, position: "center", size: "medium", color: "white", weight: "regular", font: "inter" };
  const heroPlan = reconcileTypographyReferenceTitlePlan({ version: "1", operations: [] }, requested, heroTreatment);
  const hero = heroPlan.operations[0];
  assert.equal(hero.text, "The Journey Begins");
  assert.equal(hero.start, 3);
  assert.equal(hero.position, "upper-third");
  assert.equal(hero.presentation, "hero_display");
  assert.equal(hero.font, "barlowCondensed");
  const document = buildAssDocument([hero], { width: 854, height: 480 });
  assert.match(document, /\\an8\\pos\(427,106\)/, "hero placement is safely in the upper third");
  assert.match(document, /\\fnBarlow Condensed ExtraBold\\fs67\\c&H00FFFFFF&\\b1\}THE JOURNEY BEGINS/, "hero scale is materially stronger than the 48px large preset without a heavy event outline");
  assert.doesNotMatch(document, /\\bord/);
  const ordinary = buildAssDocument([{ ...requested, runs: [{ text: requested.text, font: "instrumentSerif", size: "medium", color: "#FFFFFF", weight: "regular" }] }], { width: 854, height: 480 });
  assert.match(ordinary, /\\an5\\pos\(427,240\).*\\fs34/);
  assert.doesNotMatch(ordinary, /upper-third|\\fs67/);
});

test("B2B target-aware readability adds an understated ASS safeguard only for bright target frames", () => {
  assert.equal(titleReadabilityForLuma(0.45), null, "dark backgrounds keep the existing elegant title treatment");
  assert.deepEqual(titleReadabilityForLuma(0.8), { outline: 1.45, shadow: 0.3 }, "bright targets receive a bounded readability treatment");
  assert.deepEqual(titleReadabilityForLuma(0.8, "#CAD8FF"), { outline: 1.05, shadow: 0.2, outlineColor: "#203B5A", outlineAlpha: 142 }, "a light-blue reference title keeps its pale treatment with a subtle cool edge");
  const document = buildAssDocument([{
    text: "Mylene", start: 1, end: 3, position: "bottom-center", readability: titleReadabilityForLuma(0.8),
    runs: [{ text: "Mylene", font: "instrumentSerif", size: "medium", color: "#FFFFFF", weight: "regular" }]
  }], { width: 1280, height: 720 });
  assert.match(document, /\\bord1\.45\\shad0\.3\\3c&H55000000&/, "bright-frame protection remains a subtle outline/shadow rather than a title box");
  assert.match(document, /\\fnInstrument Serif\\fs50\\c&H00FFFFFF&\\b0/);
});

test("B2B preserves observed pale-blue reference character and renders it readably on a bright title region", { timeout: 20_000 }, async () => {
  const analysis = {
    safe: true, typography: "single", candidates: [{
      candidateId: "candidate-1", referenceText: "BLUE HOURS", role: "creative_title", prominence: "high", fontCharacter: "serif", weight: "regular", caseStyle: "uppercase", size: "large", color: "blue", colorLightness: "light", colorTreatment: "pastel", position: "top-center", lineBreakStyle: "single_line"
    }]
  };
  const treatment = deriveTypographyTitleTreatment(analysis, extractTypographyReferenceSelector("Use the typography of the big blue title in this reference and add the title 'Kerala Diaries' at 0:03."));
  assert.equal(treatment.color, "#CAD8FF", "light pastel blue must not collapse to ordinary medium blue");
  assert.equal(treatment.colorLightness, "light");
  assert.equal(treatment.colorTreatment, "pastel");
  assert.equal(deriveTypographyTitleTreatment({ ...analysis, candidates: [{ ...analysis.candidates[0], colorLightness: "medium", colorTreatment: "balanced" }] }).color, "#4A90E2", "ordinary blue remains available for references that actually observe it");

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2b-light-blue-"));
  const sourcePath = path.join(tempDirectory, "bright.mp4");
  try {
    await makeSolidCaptionSource(sourcePath, 2, { width: 854, height: 480, color: "white" });
    const media = [{ duration: 2, width: 854, height: 480, hasAudio: true, frameRate: 30 }];
    const requested = { text: "Kerala Diaries", start: 0.5, end: 1.5, position: "center", size: "medium", color: "white", weight: "regular", font: "inter" };
    const plan = reconcileTypographyReferenceTitlePlan({ version: "1", operations: [] }, requested, treatment);
    validateEditPlan(plan);
    const output = await executeWithWatchdog({ inputPaths: [sourcePath], media, tempDirectory, plan }, { watchdogMs: 15_000 });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.match(ass, /\\c&H00FFD8CA&/, "ASS uses the server-owned pale-blue BGR color");
    assert.match(ass, /\\bord1\.05\\shad0\.2\\3c&H8E5A3B20&/, "bright title region receives a thin translucent cool edge, not a dark box");
    assert.ok(await videoFrameDifference(sourcePath, output, 1) > 100_000, "the reference-inspired pale-blue title visibly renders on bright footage");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2B target-aware readability samples the title region rather than averaging unrelated frame brightness", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2b-title-region-"));
  const sourcePath = path.join(tempDirectory, "split-light.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:size=854x480:rate=30,drawbox=x=0:y=0:w=854:h=150:color=white:t=fill",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", sourcePath
    ]);
    const media = [{ duration: 2, width: 854, height: 480, hasAudio: true, frameRate: 30 }];
    const run = { text: "Kerala", font: "instrumentSerif", size: "medium", color: "#FFFFFF", weight: "regular" };
    const plan = { version: "1", operations: [
      { type: "title", text: "Kerala", start: 0.5, end: 1.5, position: "top-center", size: "medium", color: "white", weight: "regular", font: "instrumentSerif", readability: { mode: "target_aware" }, runs: [run] },
      { type: "title", text: "Kerala", start: 0.5, end: 1.5, position: "bottom-center", size: "medium", color: "white", weight: "regular", font: "instrumentSerif", readability: { mode: "target_aware" }, runs: [run] }
    ] };
    validateEditPlan(plan);
    await executeWithWatchdog({ inputPaths: [sourcePath], media, tempDirectory, plan }, { watchdogMs: 15_000 });
    const dialogues = (await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8")).split("\n").filter((line) => line.startsWith("Dialogue:"));
    assert.match(dialogues[0], /\\an8.*\\bord1\.45/, "the bright upper title region receives the readability edge");
    assert.doesNotMatch(dialogues[1], /\\bord/, "the dark lower title region retains the elegant unmodified treatment");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2A reference analysis contract defaults enrichment but fails closed on safety facts", async () => {
  const complete = {
    safe: true,
    reference: { context: "lifestyle", peopleOrSkin: true, exposure: "high", saturation: "high", warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint", highlightCharacter: "flash", blackCharacter: "deep", saturationCharacter: "rich", colorSeparation: "editorial" },
    target: { context: "portrait", coherent: true, peopleOrSkin: true, exposure: "medium", saturation: "low", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "muted", colorSeparation: "neutral", compatible: true },
    treatment: { exposure: "raise", exposureIntensity: "strong", contrast: "raise", contrastIntensity: "strong", blacks: "lower", blackIntensity: "standard", highlights: "raise", highlightIntensity: "strong", color: "raise", colorIntensity: "strong", warmth: "cool", warmthIntensity: "strong", ambientColorCharacter: "cool_mint", highlightCharacter: "flash", colorSeparation: "editorial", mood: "rich" }
  };
  const metrics = { lumaP05: 0.18, lumaP50: 0.6, lumaP95: 0.8, lumaP99: 0.82, nearBlackFraction: 0, nearWhiteFraction: 0, saturationIndex: 0.1 };
  assert.equal(validateReferenceStyleAnalysis(complete).reference.context, "lifestyle");
  const omittedEnrichment = structuredClone(complete);
  delete omittedEnrichment.reference.context;
  delete omittedEnrichment.target.context;
  for (const field of ["exposureIntensity", "contrastIntensity", "blackIntensity", "highlightIntensity", "colorIntensity", "warmthIntensity", "ambientColorCharacter", "highlightCharacter", "colorSeparation", "mood"]) delete omittedEnrichment.treatment[field];
  const normalized = validateReferenceStyleAnalysis(omittedEnrichment);
  assert.deepEqual(normalized.reference.context, "mixed");
  assert.deepEqual(normalized.target.context, "mixed");
  assert.deepEqual(normalized.treatment, {
    exposure: "raise", exposureIntensity: "standard", contrast: "raise", contrastIntensity: "standard",
    blacks: "lower", blackIntensity: "standard", highlights: "raise", highlightIntensity: "standard",
    color: "raise", colorIntensity: "standard", warmth: "cool", warmthIntensity: "standard",
    ambientColorCharacter: "neutral", highlightCharacter: "natural", colorSeparation: "neutral", mood: "natural"
  });
  assert.ok(deriveReferenceStyleTreatment({ analysis: normalized, metrics }).recipe.brightness > 0, "ordinary coherent reference/target pairs reach server derivation");
  assert.equal(referenceStyleAnalysisSchema().properties.reference.required.includes("context"), false);
  assert.equal(referenceStyleAnalysisSchema().properties.reference.required.includes("ambientColorCharacter"), true);
  assert.equal(referenceStyleAnalysisSchema().properties.treatment, undefined, "production analysis schema excludes model treatment recommendations");

  const missingCritical = structuredClone(complete);
  delete missingCritical.target.compatible;
  assert.throws(() => validateReferenceStyleAnalysis(missingCritical), (error) => error instanceof ReferenceStyleError && error.reason === "REFERENCE_INVALID_MODEL_RESPONSE" && error.field === "target compatible");
  const invalidEnum = structuredClone(complete);
  invalidEnum.treatment.colorSeparation = "neon";
  assert.throws(() => validateReferenceStyleAnalysis(invalidEnum), (error) => error instanceof ReferenceStyleError && error.field === "color separation");
  const nullField = structuredClone(complete);
  nullField.target.peopleOrSkin = null;
  assert.throws(() => validateReferenceStyleAnalysis(nullField), (error) => error instanceof ReferenceStyleError && error.field === "target peopleOrSkin");
  const extraProperty = structuredClone(complete);
  extraProperty.treatment.rawFfmpeg = "eq=brightness=1";
  assert.throws(() => validateReferenceStyleAnalysis(extraProperty), (error) => error instanceof ReferenceStyleError && error.field === "treatment.rawFfmpeg");
  assert.throws(() => validateReferenceStyleAnalysis(null), (error) => error instanceof ReferenceStyleError && error.reason === "REFERENCE_INVALID_MODEL_RESPONSE");
  const incompatible = structuredClone(complete);
  incompatible.target.compatible = false;
  assert.doesNotThrow(() => deriveReferenceStyleTreatment({ analysis: incompatible, metrics }), "content-class mismatch is diagnostic-only for photographic treatment");
  assert.throws(() => validateReferenceStyleAnalysis({ ...complete, safe: false }), (error) => error instanceof ReferenceStyleError && error.reason === "REFERENCE_SAFETY_REJECTED");

  const uploaded = [];
  let generated = 0;
  const productionObservationResponse = structuredClone(complete);
  delete productionObservationResponse.treatment;
  const modelRequests = [];
  const aiClient = {
    files: {
      upload: async () => {
        const file = { name: `uploaded-${uploaded.length}`, uri: `gemini://private-${uploaded.length}`, mimeType: "image/jpeg" };
        uploaded.push(file);
        return file;
      },
      delete: async () => {}
    },
    models: {
      generateContent: async (request) => {
        modelRequests.push(request);
        const response = generated++ === 0 ? { safe: true } : generated === 2 ? productionObservationResponse.reference : productionObservationResponse.target;
        return { text: JSON.stringify(response) };
      }
    }
  };
  const result = await analyzeReferenceStyle({ referencePath: "/private/reference.jpg", referenceMimeType: "image/jpeg", targetFrames: [{ imagePath: "/private/frame.jpg" }], metrics, aiClient });
  assert.equal(result.analysis.reference.context, "lifestyle");
  assert.equal(Object.hasOwn(result.analysis, "treatment"), false, "production model response contains observations, not model treatment authority");
  assert.deepEqual(validateReferenceStyleAnalysis(result.analysis), result.analysis, "normalized production analysis is safe to validate again");
  assert.doesNotThrow(() => deriveReferenceStyleTreatment({ analysis: result.analysis, metrics }), "normalized production analysis reaches server delta and canonical treatment");
  assert.ok(result.treatment.recipe.contrast > 0, "mocked ordinary photo path reaches canonical treatment");
  assert.equal(uploaded.length, 2, "reference and target frame are reused only as Gemini scratch files");
  assert.equal(modelRequests.length, 3, "safety, reference, and target classification are distinct calls");
  assert.ok(modelRequests[1].contents.includes("REFERENCE IMAGE") && !modelRequests[1].contents.some((part) => typeof part === "string" && part.startsWith("TARGET FRAME")), "reference classification cannot receive target frames");
  assert.ok(modelRequests[2].contents.some((part) => typeof part === "string" && part.startsWith("TARGET FRAME")) && !modelRequests[2].contents.includes("REFERENCE IMAGE"), "target classification cannot receive the reference");

  const failureDiagnostic = createReferenceStyleFailureDiagnostic({
    jobId: "job-safe",
    error: new ReferenceStyleError("REFERENCE_INVALID_MODEL_RESPONSE", "raw response gemini://private signed-url token", "reference context")
  });
  assert.deepEqual(failureDiagnostic, { jobId: "job-safe", stage: "reference_style_analysis", reason: "REFERENCE_INVALID_MODEL_RESPONSE", field: "reference context" });
  assert.doesNotMatch(JSON.stringify(failureDiagnostic), /private|uri|url|token|secret|path/i);
  const failedAiClient = { files: aiClient.files, models: { generateContent: async () => { throw new Error("model request failed with gemini://private-response"); } } };
  await assert.rejects(
    analyzeReferenceStyle({ referencePath: "/private/reference.jpg", referenceMimeType: "image/jpeg", targetFrames: [], metrics, aiClient: failedAiClient }),
    (error) => error instanceof ReferenceStyleError && error.reason === "REFERENCE_MODEL_REQUEST_FAILED"
  );
});

test("B2A reference classification is structurally invariant across target contexts", async () => {
  const warmReference = { context: "architecture", peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange", highlightCharacter: "soft", blackCharacter: "deep", saturationCharacter: "rich", colorSeparation: "editorial" };
  const coolReference = { ...warmReference, warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint" };
  const baseTarget = { coherent: true, peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", compatible: true };
  const metrics = { lumaP05: 0.1, lumaP50: 0.48, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0.01, nearWhiteFraction: 0, saturationIndex: 0.2 };
  const run = async ({ reference, target }) => {
    let call = 0;
    const requests = [];
    const aiClient = {
      files: { upload: async (_, index = 0) => ({ name: `file-${Math.random()}`, uri: `gemini://private-${index}`, mimeType: "image/jpeg" }), delete: async () => {} },
      models: { generateContent: async (request) => {
        requests.push(request);
        call += 1;
        return { text: JSON.stringify(call === 1 ? { safe: true } : call === 2 ? reference : target) };
      } }
    };
    const result = await analyzeReferenceStyle({ referencePath: "/private/reference.jpg", referenceMimeType: "image/jpeg", targetFrames: [{ imagePath: "/private/frame.jpg" }], metrics, aiClient });
    return { result, requests };
  };
  const human = await run({ reference: warmReference, target: { ...baseTarget, context: "portrait", peopleOrSkin: true } });
  const landscape = await run({ reference: warmReference, target: { ...baseTarget, context: "landscape" } });
  const food = await run({ reference: warmReference, target: { ...baseTarget, context: "food" } });
  assert.deepEqual(human.result.analysis.reference, landscape.result.analysis.reference);
  assert.deepEqual(human.result.analysis.reference, food.result.analysis.reference);
  assert.notDeepEqual(human.result.analysis.target, landscape.result.analysis.target, "human and landscape retain independently observed target signatures");
  assert.ok(human.result.treatment.recipe.temperature > 0 && landscape.result.treatment.recipe.temperature > 0, "same warm signature remains warm for human and landscape targets");
  const coolHuman = await run({ reference: coolReference, target: { ...baseTarget, context: "portrait", peopleOrSkin: true } });
  const coolLandscape = await run({ reference: coolReference, target: { ...baseTarget, context: "landscape" } });
  assert.deepEqual(coolHuman.result.analysis.reference, coolLandscape.result.analysis.reference);
  assert.ok(coolHuman.result.treatment.recipe.temperature < 0 && coolLandscape.result.treatment.recipe.temperature < 0, "same cool/mint signature remains cool for human and landscape targets");
  for (const { requests } of [human, landscape, food, coolHuman, coolLandscape]) {
    assert.equal(requests[1].config.temperature, 0, "reference classification uses deterministic structured generation");
    assert.equal(requests[2].config.temperature, 0, "target classification uses deterministic structured generation");
    assert.ok(!requests[1].contents.some((part) => typeof part === "string" && part.startsWith("TARGET FRAME")), "reference request has no target input");
    assert.ok(!requests[2].contents.includes("REFERENCE IMAGE"), "target request has no reference input");
  }
  assert.equal(referenceStyleReferenceAnalysisSchema().required.includes("ambientColorCharacter"), true);
  assert.equal(referenceStyleTargetAnalysisSchema().required.includes("coherent"), true);
});

test("B2A normalized analysis omits absent legacy treatment and remains validator-idempotent", () => {
  const productionAnalysis = {
    safe: true,
    reference: { peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint", highlightCharacter: "soft", blackCharacter: "deep", saturationCharacter: "rich", colorSeparation: "editorial" },
    target: { coherent: true, peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", compatible: true }
  };
  const normalized = validateReferenceStyleAnalysis(productionAnalysis);
  assert.equal(Object.hasOwn(normalized, "treatment"), false, "absence remains absent after normalization");
  assert.deepEqual(validateReferenceStyleAnalysis(normalized), normalized, "normalization is idempotent");
  const treatment = deriveReferenceStyleTreatment({ analysis: normalized, metrics: { lumaP05: 0.1, lumaP50: 0.48, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0.01, nearWhiteFraction: 0, saturationIndex: 0.2 } });
  assert.ok(treatment.recipe.temperature < 0, "server derives cool direction from observations without legacy treatment");

  const legacy = structuredClone(productionAnalysis);
  legacy.treatment = { exposure: "lower", contrast: "lower", blacks: "raise", highlights: "lower", color: "lower", warmth: "warm" };
  const normalizedLegacy = validateReferenceStyleAnalysis(legacy);
  assert.deepEqual(validateReferenceStyleAnalysis(normalizedLegacy), normalizedLegacy, "valid legacy treatment remains revalidatable");
  assert.ok(deriveReferenceStyleTreatment({ analysis: normalizedLegacy, metrics: { lumaP05: 0.1, lumaP50: 0.48, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0.01, nearWhiteFraction: 0, saturationIndex: 0.2 } }).recipe.temperature < 0, "legacy treatment remains non-authoritative");

  assert.throws(() => validateReferenceStyleAnalysis({ ...productionAnalysis, treatment: null }), (error) => error instanceof ReferenceStyleError && error.field === "treatment");
  assert.throws(() => validateReferenceStyleAnalysis({ ...productionAnalysis, treatment: { exposure: "raise" } }), (error) => error instanceof ReferenceStyleError && error.field === "treatment contrast");
  assert.throws(() => validateReferenceStyleAnalysis({ ...productionAnalysis, treatment: { exposure: "raise", contrast: "preserve", blacks: "preserve", highlights: "preserve", color: "preserve", warmth: "hot" } }), (error) => error instanceof ReferenceStyleError && error.field === "treatment warmth");
});

test("B2A retains bounded split-tone reference relationships without changing B1 recipes", () => {
  assert.deepEqual(TONAL_COLOR_BIASES, ["neutral", "warm_yellow", "warm_orange", "cool_blue", "cool_cyan", "green_mint"]);
  const base = {
    safe: true,
    reference: { context: "architecture", peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "mixed", shadowColorBias: "cool_blue", midtoneColorBias: "neutral", highlightColorBias: "warm_yellow", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "editorial" },
    target: { context: "landscape", coherent: true, peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", shadowColorBias: "neutral", midtoneColorBias: "neutral", highlightColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", compatible: true }
  };
  const metrics = { lumaP05: 0.1, lumaP50: 0.48, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0.01, nearWhiteFraction: 0, saturationIndex: 0.2 };
  const normalized = validateReferenceStyleAnalysis(base);
  assert.equal(normalized.reference.shadowColorBias, "cool_blue");
  assert.equal(normalized.reference.highlightColorBias, "warm_yellow");
  const treatment = deriveReferenceStyleTreatment({ analysis: normalized, metrics });
  assert.equal(treatment.version, 2);
  assert.ok(treatment.recipe.shadowTemperature < 0);
  assert.ok(treatment.recipe.highlightTemperature > 0);
  assert.equal(treatment.recipe.midtoneTemperature, 0);
  const filters = buildReferenceStyleTreatmentFilters(treatment.recipe);
  assert.match(filters.find((filter) => filter.startsWith("colorbalance=")), /rs=-.*rh=0\./, "split tone reaches independent shadow/highlight colorbalance channels");
  assert.ok(filters.at(-1).startsWith("curves=master="), "B2 still protects highlights after color balance");
  const human = deriveReferenceStyleTreatment({ analysis: { ...base, target: { ...base.target, peopleOrSkin: true } }, metrics });
  assert.ok(Math.abs(human.recipe.shadowTemperature) <= 0.1 && Math.abs(human.recipe.highlightTemperature) <= 0.1, "skin caps band hue authority without erasing the relationship");
  assert.equal(resolveCurrentStyleProfile("cinematic").recipe.shadowTemperature, undefined, "B1 profile recipes never acquire B2 band controls");
});

test("B2A tonal bands follow reference direction and complementary palettes suppress global temperature", () => {
  const metrics = { lumaP05: 0.1, lumaP50: 0.48, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0.01, nearWhiteFraction: 0, saturationIndex: 0.2 };
  const target = { context: "landscape", coherent: true, peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", shadowColorBias: "neutral", midtoneColorBias: "neutral", highlightColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", compatible: true };
  const recipeFor = (reference, targetOverride = {}) => deriveReferenceStyleTreatment({ analysis: { safe: true, reference: { context: "architecture", peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", shadowColorBias: "neutral", midtoneColorBias: "neutral", highlightColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", ...reference }, target: { ...target, ...targetOverride } }, metrics }).recipe;
  assert.equal(recipeFor({ highlightColorBias: "neutral" }, { highlightColorBias: "warm_yellow" }).highlightTemperature, 0, "neutral reference highlights do not cool a warm target");
  assert.equal(recipeFor({ highlightColorBias: "neutral" }, { highlightColorBias: "cool_blue" }).highlightTemperature, 0, "neutral reference highlights do not warm a cool target");
  assert.ok(recipeFor({ midtoneColorBias: "warm_yellow" }).midtoneTemperature > 0);
  assert.ok(recipeFor({ midtoneColorBias: "warm_yellow" }, { midtoneColorBias: "warm_yellow" }).midtoneTemperature >= 0);
  assert.ok(recipeFor({ shadowColorBias: "cool_blue" }).shadowTemperature < 0);
  assert.ok(recipeFor({ shadowColorBias: "cool_blue" }, { shadowColorBias: "cool_blue" }).shadowTemperature <= 0);

  const complementary = recipeFor({ dominantColorBias: "mixed", shadowColorBias: "cool_blue", midtoneColorBias: "warm_yellow", highlightColorBias: "neutral" });
  assert.equal(complementary.temperature, 0, "mixed complementary palette does not receive a global white-balance shift");
  assert.ok(complementary.shadowTemperature < 0);
  assert.ok(complementary.midtoneTemperature > 0);
  assert.equal(complementary.highlightTemperature, 0);
  const complementaryFilters = buildReferenceStyleTreatmentFilters(complementary);
  assert.match(complementaryFilters.find((filter) => filter.startsWith("colorbalance=")), /rs=-.*rm=0\..*:rh=0\.0000.*pl=0/);
  assert.ok(complementaryFilters.at(-1).startsWith("curves=master="));

  assert.ok(recipeFor({ warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" }).temperature > 0, "globally warm reference preserves global warmth");
  assert.ok(recipeFor({ warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint" }).temperature < 0, "globally cool reference preserves global coolness");

  const coolMintAccents = recipeFor({ warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "mixed", shadowColorBias: "green_mint", midtoneColorBias: "warm_yellow", highlightColorBias: "warm_yellow" });
  assert.ok(coolMintAccents.temperature < 0, "cool/mint ambient remains globally cool despite warm accents");
  assert.ok(coolMintAccents.shadowTemperature <= 0 && coolMintAccents.midtoneTemperature >= 0);
  const coolCleanAccents = recipeFor({ warmth: "cool", ambientColorCharacter: "cool_clean", dominantColorBias: "mixed", shadowColorBias: "cool_blue", midtoneColorBias: "warm_yellow" });
  assert.ok(coolCleanAccents.temperature < 0, "cool-clean ambient remains globally cool despite warm accents");
  const warmGoldenAccents = recipeFor({ warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "mixed", shadowColorBias: "cool_blue", midtoneColorBias: "warm_yellow" });
  assert.ok(warmGoldenAccents.temperature > 0, "warm-golden ambient remains globally warm despite cool accents");

  const warmOnWarm = recipeFor(
    { warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" },
    { warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" }
  );
  assert.equal(warmOnWarm.temperature, 0.07, "warm reference retains a conservative ambient floor on an already-warm target");
  const coolOnCool = recipeFor(
    { warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint" },
    { warmth: "cool", ambientColorCharacter: "cool_clean", dominantColorBias: "cyan_blue" }
  );
  assert.equal(coolOnCool.temperature, -0.07, "cool reference retains a conservative ambient floor on an already-cool target");
});

test("B2A one-pass proxy refinement is bounded, directional, and safe to skip", async () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " yes"]) {
    assert.equal(isB2aProxyRefinementEnabled(value), false, `only exact true enables proxy refinement (${String(value)})`);
  }
  assert.equal(isB2aProxyRefinementEnabled("true"), true);
  const metrics = { lumaP05: 0.08, lumaP50: 0.45, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0.01, nearWhiteFraction: 0, saturationIndex: 0.2 };
  const signature = (overrides = {}) => ({ context: "lifestyle", peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", shadowColorBias: "neutral", midtoneColorBias: "neutral", highlightColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", ...overrides });
  const target = signature({ coherent: true, compatible: true });
  const analysisFor = (reference, targetOverride = {}) => validateReferenceStyleAnalysis({ safe: true, reference: signature(reference), target: { ...target, ...targetOverride } });
  const residual = (overrides = {}) => ({ available: true, evaluation: { confidence: "high", decision: "refine", residual: { exposure: "preserve", contrast: "preserve", saturation: "preserve", shadows: "preserve", highlights: "preserve", ambient: "matched", ...overrides } } });

  const warmAnalysis = analysisFor({ warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" });
  const warmInitial = deriveReferenceStyleTreatment({ analysis: warmAnalysis, metrics });
  const unchanged = refineReferenceStyleTreatment({ initialTreatment: warmInitial, analysis: warmAnalysis, metrics, evaluation: { available: true, evaluation: { confidence: "low", decision: "matched", residual: residual().evaluation.residual } } });
  assert.equal(unchanged.applied, false, "already-good or uncertain proxy keeps the approved initial recipe");
  assert.deepEqual(unchanged.treatment, warmInitial);
  const warmer = refineReferenceStyleTreatment({ initialTreatment: warmInitial, analysis: warmAnalysis, metrics, evaluation: residual({ ambient: "stronger" }) });
  assert.equal(warmer.applied, true);
  assert.ok(warmer.treatment.recipe.temperature > 0 && warmer.treatment.recipe.temperature <= 0.2, "warm refinement cannot reverse or exceed B2 ambient bounds");

  const coolAnalysis = analysisFor({ warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint" });
  const cool = refineReferenceStyleTreatment({ initialTreatment: deriveReferenceStyleTreatment({ analysis: coolAnalysis, metrics }), analysis: coolAnalysis, metrics, evaluation: residual({ ambient: "stronger" }) });
  assert.ok(cool.treatment.recipe.temperature < 0, "cool refinement cannot reverse ambient direction");

  const warmComplementary = analysisFor({ warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange", shadowColorBias: "cool_cyan", midtoneColorBias: "warm_orange", highlightColorBias: "warm_yellow" });
  const warmComplementaryInitial = deriveReferenceStyleTreatment({ analysis: warmComplementary, metrics });
  const warmComplementaryAmbient = refineReferenceStyleTreatment({ initialTreatment: warmComplementaryInitial, analysis: warmComplementary, metrics, evaluation: residual({ ambient: "stronger" }) });
  assert.equal(warmComplementaryAmbient.treatment.recipe.temperature, warmComplementaryInitial.recipe.temperature, "warm ambient with opposing tonal bands does not receive extra blanket warming");
  assert.equal(warmComplementaryAmbient.applied, false, "an ambient-only complementary request is correctly a no-op");
  const warmComplementaryShadows = refineReferenceStyleTreatment({ initialTreatment: warmComplementaryInitial, analysis: warmComplementary, metrics, evaluation: residual({ ambient: "stronger", shadows: "raise" }) });
  assert.equal(warmComplementaryShadows.treatment.recipe.temperature, warmComplementaryInitial.recipe.temperature, "safe independent refinement preserves complementary global temperature");
  assert.equal(warmComplementaryShadows.treatment.recipe.shadows, warmComplementaryInitial.recipe.shadows + 0.035);

  const coolComplementary = analysisFor({ warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint", shadowColorBias: "cool_blue", midtoneColorBias: "warm_yellow", highlightColorBias: "warm_orange" });
  const coolComplementaryInitial = deriveReferenceStyleTreatment({ analysis: coolComplementary, metrics });
  const coolComplementaryAmbient = refineReferenceStyleTreatment({ initialTreatment: coolComplementaryInitial, analysis: coolComplementary, metrics, evaluation: residual({ ambient: "stronger" }) });
  assert.equal(coolComplementaryAmbient.treatment.recipe.temperature, coolComplementaryInitial.recipe.temperature, "cool ambient with warm accents does not receive extra blanket cooling");

  const neutralAnalysis = analysisFor({ dominantColorBias: "mixed", shadowColorBias: "cool_blue", midtoneColorBias: "warm_yellow" });
  const neutral = refineReferenceStyleTreatment({ initialTreatment: deriveReferenceStyleTreatment({ analysis: neutralAnalysis, metrics }), analysis: neutralAnalysis, metrics, evaluation: residual({ ambient: "stronger" }) });
  assert.equal(neutral.treatment.recipe.temperature, 0, "neutral complementary architecture never receives a blanket cast");

  const faceAnalysis = analysisFor({ peopleOrSkin: true, warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" }, { peopleOrSkin: true });
  const face = refineReferenceStyleTreatment({ initialTreatment: deriveReferenceStyleTreatment({ analysis: faceAnalysis, metrics }), analysis: faceAnalysis, metrics, evaluation: residual({ ambient: "stronger" }) });
  assert.ok(Math.abs(face.treatment.recipe.temperature) <= 0.12, "human proxy refinement keeps the skin hue cap");
  const protectedHighlights = refineReferenceStyleTreatment({ initialTreatment: warmInitial, analysis: warmAnalysis, metrics: { ...metrics, lumaP99: 0.98 }, evaluation: residual({ exposure: "raise", highlights: "raise" }) });
  assert.equal(protectedHighlights.treatment.recipe.highlights, warmInitial.recipe.highlights, "P99 risk blocks extra highlight lift");
  assert.ok(protectedHighlights.treatment.recipe.brightness <= warmInitial.recipe.brightness, "P99 risk blocks extra brightness lift");
  assert.throws(() => refineReferenceStyleTreatment({ initialTreatment: { version: 2, recipe: { unsupported: 1 } }, analysis: warmAnalysis, metrics, evaluation: residual() }), /unsupported recipe field/);

  const calls = { generate: 0, deletes: 0 };
  const fakeAi = {
    files: { upload: async ({ file }) => ({ name: `file-${file}`, uri: `gemini://${file}`, mimeType: "image/jpeg" }), delete: async () => { calls.deletes += 1; } },
    models: { generateContent: async () => { calls.generate += 1; return { text: JSON.stringify(residual({ contrast: "raise" }).evaluation) }; } }
  };
  const evaluated = await evaluateReferenceStyleProxy({ referencePath: "/private/reference.jpg", referenceMimeType: "image/jpeg", proxyFrames: [{ imagePath: "/private/proxy.jpg" }], metrics, aiClient: fakeAi });
  assert.equal(calls.generate, 1, "one optional structured comparison is the entire proxy evaluator budget");
  assert.equal(calls.deletes, 2, "reference and scratch proxy Gemini files are cleaned");
  assert.equal(evaluated.evaluation.residual.contrast, "raise");
  assert.equal(referenceStyleProxyEvaluationSchema().additionalProperties, false);
  const invalid = await evaluateReferenceStyleProxy({ referencePath: "/private/reference.jpg", referenceMimeType: "image/jpeg", proxyFrames: [{ imagePath: "/private/proxy.jpg" }], metrics, aiClient: { ...fakeAi, models: { generateContent: async () => ({ text: "{}" }) } } });
  assert.deepEqual(invalid, { available: false, reason: "proxy_evaluation_unavailable" }, "invalid evaluator output safely preserves the initial recipe");
});

test("B2A reference authority suppresses accidental visual operations but retains ordinary edits", () => {
  const accidental = reconcileReferenceStylePlan({ version: "1", operations: [
    { type: "style_profile", profileId: "cinematic" },
    { type: "color_grade", style: "warm" },
    { type: "visual_adjustment", brightness: 0.2 },
    { type: "title", text: "Kerala", start: 1, end: 3, position: "top-center", size: "medium", color: "white", weight: "regular", font: "inter" },
    { type: "trim", start: 1, end: 5 }
  ] }, { prompt: "Make my video look like this." });
  assert.deepEqual(accidental.operations.map((operation) => operation.type), ["title", "trim"]);
  assert.deepEqual(accidental.referenceStyleReconciliation.suppressedVisualOperationTypes, ["style_profile", "color_grade", "visual_adjustment"]);
  assert.throws(
    () => reconcileReferenceStylePlan({ version: "1", operations: [] }, { prompt: "Match this reference and also make it Dark Moody." }),
    (error) => error instanceof UnsupportedEditRequestError && error.message === "Choose either the reference style or a named visual style."
  );
});

test("B2A derives photographic direction from bounded signatures, not model treatment advice", () => {
  const metrics = { lumaP05: 0.12, lumaP50: 0.48, lumaP95: 0.78, lumaP99: 0.84, nearBlackFraction: 0.01, nearWhiteFraction: 0, saturationIndex: 0.24 };
  const analysis = ({ reference = {}, target = {}, advisory = {} } = {}) => ({
    safe: true,
    reference: { context: "portrait", peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", ...reference },
    target: { context: "landscape", coherent: true, peopleOrSkin: false, exposure: "medium", saturation: "medium", warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral", highlightCharacter: "natural", blackCharacter: "neutral", saturationCharacter: "natural", colorSeparation: "neutral", compatible: true, ...target },
    // This deliberately contradictory advisory mirrors the production failure:
    // server derivation must ignore it in favor of observed signatures.
    treatment: { exposure: "lower", contrast: "lower", blacks: "raise", highlights: "lower", color: "lower", warmth: "warm", ambientColorCharacter: "warm_golden", highlightCharacter: "soft", colorSeparation: "neutral", mood: "natural", ...advisory }
  });
  const recipeFor = (value) => deriveReferenceStyleTreatment({ analysis: value, metrics }).recipe;

  const coolHuman = recipeFor(analysis({ reference: { peopleOrSkin: true, warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint", colorSeparation: "editorial" }, target: { peopleOrSkin: true } }));
  assert.ok(coolHuman.temperature < 0 && coolHuman.tint < 0, "cool/mint reference never becomes a warm human grade");

  const warmLandscape = recipeFor(analysis({ reference: { context: "architecture", warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" } }));
  assert.ok(warmLandscape.temperature > 0 && warmLandscape.tint > 0, "warm/golden reference never becomes a cool landscape grade");

  const warmSkinCoolAmbient = recipeFor(analysis({ reference: { peopleOrSkin: true, warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint" }, target: { peopleOrSkin: true } }));
  assert.ok(warmSkinCoolAmbient.temperature < 0 && Math.abs(warmSkinCoolAmbient.temperature) <= 0.12, "skin caps cool ambient magnitude without reversing it");
  assert.ok(recipeFor(analysis({ reference: { warmth: "cool", ambientColorCharacter: "cool_clean", dominantColorBias: "cyan_blue" }, target: { warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" } })).temperature < 0, "cool-clean reference pulls a warm target toward cool");

  assert.ok(recipeFor(analysis({ reference: { saturationCharacter: "rich", colorSeparation: "rich_controlled" }, target: { saturationCharacter: "muted" } })).saturation > 0, "rich reference raises restrained target color");
  assert.ok(recipeFor(analysis({ reference: { saturationCharacter: "muted" }, target: { saturationCharacter: "rich" } })).saturation < 0, "muted reference reduces an over-rich target");
  const deepBlacks = recipeFor(analysis({ reference: { blackCharacter: "deep" } }));
  assert.ok(deepBlacks.shadows < 0 && deepBlacks.blackLift < 0, "deep-black reference lowers neutral blacks only with shadow headroom");
  const liftedBlacks = recipeFor(analysis({ reference: { blackCharacter: "lifted" }, target: { blackCharacter: "deep" } }));
  assert.ok(liftedBlacks.shadows > 0 && liftedBlacks.blackLift > 0, "lifted-black reference opens a dark target");

  assert.doesNotThrow(() => recipeFor(analysis({ reference: { context: "portrait" }, target: { context: "landscape", compatible: false } })), "portrait-to-landscape color treatment is not rejected as content-incompatible");
  assert.doesNotThrow(() => recipeFor(analysis({ reference: { context: "architecture" }, target: { context: "portrait", peopleOrSkin: true, compatible: false } })), "architecture-to-human color treatment is not rejected as content-incompatible");

  const sameTarget = { peopleOrSkin: false, warmth: "neutral", ambientColorCharacter: "neutral", dominantColorBias: "neutral" };
  const cool = recipeFor(analysis({ reference: { warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint" }, target: sameTarget }));
  const warm = recipeFor(analysis({ reference: { warmth: "warm", ambientColorCharacter: "warm_golden", dominantColorBias: "yellow_orange" }, target: sameTarget }));
  assert.ok(cool.temperature < 0 && warm.temperature > 0, "same target receives opposite reference-directed temperature intent");
  assert.notDeepEqual(cool, warm, "clearly distinct reference signatures cannot collapse to one recipe");

  const diagnostic = createReferenceStyleDiagnostic({ jobId: "job-safe", analysis: analysis({ reference: { warmth: "cool", ambientColorCharacter: "cool_mint", dominantColorBias: "green_mint" } }), metrics, treatment: { version: 2, recipe: cool } });
  assert.deepEqual(Object.keys(diagnostic).sort(), ["derivedDelta", "filters", "finalTreatmentIntent", "jobId", "metrics", "recipe", "referenceAnalysisVersion", "referenceSignature", "targetAnalysisVersion", "targetSignature"]);
  assert.equal(diagnostic.derivedDelta.warmth, "lower");
  assert.doesNotMatch(JSON.stringify(diagnostic), /uri|path|secret|token|https?:/i);
});

test("B1 style diagnostics contain only validated server-owned planning and execution facts", () => {
  const planning = createStylePlanningDiagnostics({
    styleIntent: { mode: "delegated_taste" },
    delegatedDecision: { decision: "selected_style", profileId: "cinematic", strength: "strong", constraints: ["avoid_darkening"] },
    resolvedStyle: { profileId: "cinematic", strength: "strong", constraints: ["avoid_darkening"], sourceId: "source-2" },
    planningPath: "delegated_style_direct"
  });
  assert.deepEqual(planning, {
    styleIntentMode: "delegated_taste",
    planningPath: "delegated_style_direct",
    delegatedDecision: { decision: "selected_style", profileId: "cinematic", strength: "strong", constraints: ["avoid_darkening"] },
    resolvedStyle: { profileId: "cinematic", strength: "strong", constraints: ["avoid_darkening"], sourceId: "source-2" }
  });
  assert.deepEqual(createStylePlanningDiagnostics({
    styleIntent: { mode: "delegated_taste" }, delegatedDecision: { decision: "no_safe_choice" }, planningPath: "delegated_style_rejected"
  }), {
    styleIntentMode: "delegated_taste", planningPath: "delegated_style_rejected", delegatedDecision: { decision: "no_safe_choice" }
  });

  const plan = { version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-2", start: 0, end: 2 }] },
    { type: "style_profile", profileId: "cinematic", strength: "strong", constraints: ["avoid_darkening"], sourceId: "source-2" },
    { type: "visual_adjustment", brightness: 0.2 },
    { type: "color_grade", style: "warm" }
  ] };
  const summary = summarizeStylePlanDiagnostic({ source: "gemini", styleDiagnostics: planning }, plan);
  assert.deepEqual(summary.styleProfiles, [{ profileId: "cinematic", strength: "strong", constraints: ["avoid_darkening"], sourceId: "source-2" }]);
  assert.equal(summary.hasVisualAdjustment, true);
  assert.equal(summary.hasLegacyColorGrade, true);
  const execution = createStyleProfileExecutionDiagnostic(plan.operations[1], { jobId: "job-safe", scope: "source-2" });
  assert.ok(Object.values(execution.recipe).some((value) => value !== 0));
  assert.deepEqual(execution.filters, buildStyleProfileFilters(plan.operations[1]));
  assert.deepEqual(compileStyleProfileForExecution(plan.operations[1]).filters, execution.filters);
  const text = JSON.stringify({ planning, summary, execution });
  assert.doesNotMatch(text, /https?:\/\/|accessToken|apiKey|secret|credential|signedUrl|localPath|geminiUri/i);
});

test("B1 style_profile remains planner-dormant while validating and rendering through server-owned recipes", () => {
  assert.deepEqual(CAPABILITY_REGISTRY.style_profile.requiredFields, ["profileId"]);
  assert.deepEqual(CAPABILITY_REGISTRY.style_profile.profileIds, STYLE_PROFILE_IDS);
  assert.deepEqual(VISUAL_OPERATION_ORDER, ["color_grade", "style_profile", "reference_style_treatment", "visual_adjustment"]);
  const unorderedVisualOperations = [
    { type: "visual_adjustment", brightness: 0.2 },
    { type: "style_profile", profileId: "cinematic" },
    { type: "color_grade", style: "warm" },
    { type: "visual_adjustment", sourceId: "source-1", brightness: 0.2 },
    { type: "style_profile", sourceId: "source-1", profileId: "cinematic" },
    { type: "color_grade", sourceId: "source-1", style: "warm" }
  ];
  assert.deepEqual(orderedVisualOperations(unorderedVisualOperations).map(({ type }) => type), ["color_grade", "style_profile", "visual_adjustment"]);
  assert.deepEqual(orderedVisualOperations(unorderedVisualOperations, { sourceId: "source-1" }).map(({ type }) => type), ["color_grade", "style_profile", "visual_adjustment"]);

  const defaultSchema = JSON.stringify(createEditPlanJsonSchema());
  assert.doesNotMatch(defaultSchema, /style_profile/);
  const enabledSchema = createEditPlanJsonSchema({
    sourceIds: ["source-1", "source-2"],
    supportsStyleProfiles: true
  });
  const enabledSchemaText = JSON.stringify(enabledSchema);
  assert.match(enabledSchemaText, /style_profile/);
  assert.match(enabledSchemaText, /cinematic/);
  assert.match(enabledSchemaText, /avoid_darkening/);
  assert.doesNotMatch(enabledSchemaText, /profileVersion/);
  assert.doesNotMatch(enabledSchemaText, /lutPath/);
  assert.doesNotMatch(enabledSchemaText, /filters/);

  const global = { version: "1", operations: [{ type: "style_profile", profileId: "cinematic" }] };
  assert.doesNotThrow(() => validateEditPlan(global));
  assert.doesNotThrow(() => validateEditPlan({
    version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 2 }] },
      { type: "style_profile", sourceId: "source-1", profileId: "warm_travel", strength: "subtle", constraints: ["conservative_color"] }
    ]
  }, { sourceCatalog }));
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "style_profile", profileId: "unknown" }] }), /unknown profile/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "style_profile", profileId: "cinematic", strength: "maximum" }] }), /unsupported strength/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "style_profile", profileId: "cinematic", constraints: ["unbounded"] }] }), /unsupported constraint/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "style_profile", profileId: "cinematic", constraints: ["avoid_darkening", "avoid_darkening"] }] }), /constraints must not contain duplicates/);
  for (const field of ["profileVersion", "recipe", "filters", "filter", "lutPath", "arbitrary"]) {
    assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "style_profile", profileId: "cinematic", [field]: field === "profileVersion" ? 1 : "unsafe" }] }), new RegExp(`does not support ${field}`));
  }
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "style_profile", sourceId: "source-1", profileId: "cinematic" }] }), /sourceId is supported only/);
  assert.throws(() => validateEditPlan({
    version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 2 }] },
      { type: "style_profile", sourceId: "source-4", profileId: "cinematic" }
    ]
  }, { sourceCatalog }), /unknown source/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [
    { type: "style_profile", profileId: "cinematic" }, { type: "style_profile", profileId: "warm_travel" }
  ] }), /only one style_profile/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [
    { type: "style_profile", profileId: "cinematic" }, { type: "color_grade", style: "warm" }
  ] }), /conflicts with color_grade/);
  assert.throws(() => validateEditPlan({
    version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 2 }] },
      { type: "style_profile", sourceId: "source-1", profileId: "cinematic" },
      { type: "color_grade", sourceId: "source-1", style: "warm" }
    ]
  }, { sourceCatalog }), /conflicts with color_grade/);
  assert.doesNotThrow(() => validateEditPlan({
    version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 2 }, { sourceId: "source-2", start: 0, end: 2 }] },
      { type: "style_profile", sourceId: "source-1", profileId: "cinematic" },
      { type: "color_grade", sourceId: "source-2", style: "warm" },
      { type: "visual_adjustment", brightness: 0.2 }
    ]
  }, { sourceCatalog }));

  const standard = compileStyleProfile({ profileId: "warm_travel", strength: "standard", constraints: ["conservative_color"] });
  assert.deepEqual(
    buildStyleProfileFilters({ type: "style_profile", profileId: "warm_travel", strength: "standard", constraints: ["conservative_color"], sourceId: "source-1" }),
    buildVisualAdjustmentFilters(standard.recipe)
  );
  assert.deepEqual(
    buildStyleProfileFilters({ profileId: "cinematic", filters: ["eq=contrast=2"], lutPath: "/private.cube" }),
    buildStyleProfileFilters({ profileId: "cinematic" }),
    "executor compiler arguments are explicit; raw renderer fields never reach FFmpeg"
  );
  const recipeMagnitude = (strength) => Object.values(compileStyleProfile({ profileId: "cinematic", strength }).recipe)
    .reduce((total, value) => total + Math.abs(value), 0);
  assert.ok(recipeMagnitude("subtle") < recipeMagnitude("standard"));
  assert.ok(recipeMagnitude("standard") < recipeMagnitude("strong"));
});

test("B1 deterministic style intent preserves legacy and adjustment precedence", async () => {
  const styleCases = [
    ["Make this cinematic.", "cinematic"], ["Make this look like a movie.", "cinematic"],
    ["Make it filmic.", "cinematic"], ["Make it dramatic.", "cinematic"],
    ["Make this warm and inviting.", "warm_travel"], ["Make this feel like a travel reel.", "warm_travel"],
    ["Make this premium.", "clean_commercial"], ["Make this look expensive.", "clean_commercial"],
    ["Make it more professional.", "clean_commercial"], ["Make it look like an ad.", "clean_commercial"],
    ["Make it look like a luxury brand video.", "clean_commercial"], ["Make it soft.", "soft_nostalgic"],
    ["Make it nostalgic.", "soft_nostalgic"], ["Make it look old.", "soft_nostalgic"],
    ["Give it a vintage look.", "soft_nostalgic"], ["Make it faded.", "soft_nostalgic"],
    ["Make it colourful.", "vibrant_social"], ["Make this good for Instagram.", "vibrant_social"],
    ["Make it feel social-media ready.", "vibrant_social"], ["Make it less dull.", "vibrant_social"],
    ["Make it dark and moody.", "dark_moody"], ["Make it moodier.", "dark_moody"],
    ["Make it natural.", "natural_documentary"], ["Make it documentary-like.", "natural_documentary"]
  ];
  for (const [prompt, profileId] of styleCases) {
    assert.equal(extractStyleProfileIntent(prompt)?.profileId, profileId, prompt);
    assert.deepEqual(createEditPlan({ prompt }).operations.find((operation) => operation.type === "style_profile"), { type: "style_profile", profileId }, prompt);
  }
  assert.equal(extractStyleProfileIntent("Make it warmer."), null);
  assert.equal(extractStyleProfileIntent("Increase contrast by 20%."), null);
  assert.equal(extractStyleProfileIntent("Add a slight magenta tint."), null);
  assert.equal(extractStyleProfileIntent("Apply the cinematic filter."), null);
  assert.equal(extractStyleProfileIntent("Use the warm filter."), null);
  assert.equal(extractStyleProfileIntent("Make it black and white."), null);
  assert.deepEqual(createEditPlan({ prompt: "Apply the cinematic filter." }).operations, [{ type: "color_grade", style: "cinematic" }]);
  assert.deepEqual(createEditPlan({ prompt: "Make it warmer." }).operations, [{ type: "visual_adjustment", temperature: 0.2 }]);
  assert.deepEqual(createEditPlan({ prompt: "Make it black and white." }).operations, [{ type: "color_grade", style: "bw" }]);
  assert.deepEqual(extractStyleProfileIntent("Make it slightly cinematic."), { profileId: "cinematic", strength: "subtle" });
  assert.deepEqual(extractStyleProfileIntent("Make it cinematic."), { profileId: "cinematic" });
  assert.deepEqual(extractStyleProfileIntent("Make it very cinematic."), { profileId: "cinematic", strength: "strong" });
  assert.deepEqual(extractStyleProfileIntent("Make this warm, soft and a little nostalgic."), { profileId: "soft_nostalgic", strength: "subtle" });
  assert.deepEqual(createEditPlan({ prompt: "Make it cinematic and a little warmer." }).operations, [
    { type: "style_profile", profileId: "cinematic" }, { type: "visual_adjustment", temperature: 0.12 }
  ]);
  assert.deepEqual(extractStyleProfileIntent("Make it premium but not too dark."), { profileId: "clean_commercial", constraints: ["avoid_darkening"] });
  assert.deepEqual(extractStyleProfileIntent("Make it cinematic, but keep the skin tones natural."), { profileId: "cinematic", constraints: ["skin_tone_conservative"] });
  assert.deepEqual(extractStyleProfileIntent("Make this colourful but don't oversaturate it."), { profileId: "vibrant_social", constraints: ["avoid_oversaturation"] });
  assert.equal(extractStyleProfileIntent("Keep the colours natural."), null, "constraints alone do not invent a style");
  assert.equal(requiresDelegatedStyleJudgment("Make this look good."), true);
  assert.equal(extractStyleProfileIntent("Make this look good."), null);

  const catalog = sourceCatalog.slice(0, 2);
  const strengthCases = [
    ["Make it slightly cinematic.", "subtle"], ["Make it a little cinematic.", "subtle"],
    ["Make it a bit cinematic.", "subtle"], ["Make it subtly cinematic.", "subtle"],
    ["Make it gently cinematic.", "subtle"], ["Make it very cinematic.", "strong"],
    ["Make it strongly cinematic.", "strong"], ["Make it intensely cinematic.", "strong"],
    ["Make it heavily cinematic.", "strong"]
  ];
  for (const [prompt, strength] of strengthCases) {
    const client = createMockGemini();
    assert.deepEqual(extractStyleProfileIntent(prompt), { profileId: "cinematic", strength }, prompt);
    assert.equal(isDeterministicallySafeStyleRequest(prompt, { sourceCatalog: [catalog[0]] }), true, prompt);
    const result = await withGeminiKey(() => createAiEditPlan({
      prompt, sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: client
    }));
    assert.equal(result.source, "deterministic", prompt);
    assert.equal(client.uploads.length, 0, prompt);
    assert.equal(client.requests.length, 0, prompt);
  }
  for (const prompt of [
    "Make it cinematic, but keep the skin tones natural.",
    "Make it premium but not too dark.",
    "Make this colourful but don't oversaturate it.",
    "Keep the colours natural and make it cinematic."
  ]) {
    const client = createMockGemini();
    const result = await withGeminiKey(() => createAiEditPlan({
      prompt, sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: client
    }));
    assert.equal(isDeterministicallySafeStyleRequest(prompt, { sourceCatalog: [catalog[0]] }), true, prompt);
    assert.equal(result.source, "deterministic", prompt);
    assert.equal(client.uploads.length, 0, prompt);
    assert.equal(client.requests.length, 0, prompt);
  }
  for (const prompt of [
    "Make it cinematic and remove the background.",
    "Make it cinematic and add my logo."
  ]) {
    const client = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "cinematic" }] }) });
    assert.equal(isDeterministicallySafeStyleRequest(prompt, { sourceCatalog: [catalog[0]] }), false, prompt);
    const result = await withGeminiKey(() => createAiEditPlan({
      prompt, sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: client
    }));
    assert.equal(result.source, "gemini", prompt);
    assert.equal(client.uploads.length, 1, prompt);
    assert.equal(client.requests.length, 1, prompt);
  }

  const scoped = createEditPlan({ prompt: "Make the second video cinematic.", hasMultipleVideos: true, sourceCatalog: catalog });
  assert.deepEqual(scoped.operations, [
    { type: "sequence", clips: catalog.map(({ sourceId, duration }) => ({ sourceId, start: 0, end: duration })) },
    { type: "style_profile", profileId: "cinematic", sourceId: "source-2" }
  ]);
  const reordered = createEditPlan({ prompt: "Use video 2 then video 1 and make video 2 cinematic.", hasMultipleVideos: true, sourceCatalog: catalog });
  assert.deepEqual(reordered.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.deepEqual(reordered.operations.at(-1), { type: "style_profile", profileId: "cinematic", sourceId: "source-2" });
  assert.equal(isDeterministicallySafeStyleRequest("Make video 9 cinematic.", { sourceCatalog: catalog }), false);
  assert.equal(isDeterministicallySafeStyleRequest("The fifth video should look cinematic.", { sourceCatalog: catalog }), false);
  for (const prompt of ["Make video 9 cinematic.", "The fifth video should look cinematic."]) {
    const invalid = createEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog: catalog });
    assert.equal(invalid.operations.at(-1).sourceId, prompt.includes("9") ? "source-9" : "source-5");
    assert.throws(() => validateEditPlan(invalid, { sourceCatalog: catalog }), /unknown source/);
  }

  assert.deepEqual(createEditPlan({ prompt: "Make it warm and inviting and slightly brighter." }).operations, [
    { type: "style_profile", profileId: "warm_travel" }, { type: "visual_adjustment", brightness: 0.12 }
  ]);
  assert.deepEqual(createEditPlan({ prompt: "Make it warm and inviting and increase contrast slightly." }).operations, [
    { type: "style_profile", profileId: "warm_travel" }, { type: "visual_adjustment", contrast: 0.12 }
  ]);
  assert.deepEqual(createEditPlan({ prompt: "Make it cinematic and slightly warmer." }).operations, [
    { type: "style_profile", profileId: "cinematic" }, { type: "visual_adjustment", temperature: 0.12 }
  ]);
  assert.deepEqual(createEditPlan({ prompt: "Make it very cinematic and slightly warmer." }).operations, [
    { type: "style_profile", profileId: "cinematic", strength: "strong" }, { type: "visual_adjustment", temperature: 0.12 }
  ]);
  assert.deepEqual(extractStyleProfileIntent("Make it soft and very cinematic."), { profileId: "soft_nostalgic" });

  const deterministicClient = createMockGemini();
  const deterministic = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make this cinematic.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: deterministicClient
  }));
  assert.equal(deterministic.source, "deterministic");
  assert.equal(deterministicClient.uploads.length, 0);
  assert.equal(deterministicClient.requests.length, 0);

  const visualClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 1, end: 3 }]),
    JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "cinematic" }] })
  ] });
  const visual = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the person enters and make it cinematic.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: visualClient
  }));
  assert.equal(visual.source, "gemini");
  assert.deepEqual(visual.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 3 }] }, { type: "style_profile", profileId: "cinematic" }
  ]);

  const semanticClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: catalog.map(({ sourceId, duration }) => ({ sourceId, start: 0, end: duration })) }] })
  ] });
  const semantic = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make the temple video cinematic.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: semanticClient
  }));
  assert.deepEqual(semantic.plan.operations.at(-1), { type: "style_profile", profileId: "cinematic", sourceId: "source-2" });
});

test("B1 text-only fuzzy style interpretation is server-validated, scoped, and media-safe", async () => {
  const styleSchema = createStyleIntentJsonSchema();
  assert.deepEqual(styleSchema.properties.profileId.enum, ["none", ...STYLE_PROFILE_IDS]);
  assert.deepEqual(styleSchema.properties.strength.enum, Object.keys(STYLE_PROFILE_STRENGTHS));
  assert.deepEqual(styleSchema.properties.constraints.items.enum, STYLE_PROFILE_CONSTRAINTS);
  assert.equal(styleSchema.properties.styleText.type, "string");
  assert.doesNotMatch(JSON.stringify(createEditPlanJsonSchema()), /style_profile/);
  assert.match(buildStyleIntentPrompt({ prompt: "Make it elegant." }), /text-only/i);
  assert.doesNotMatch(buildStyleIntentPrompt({ prompt: "Make it elegant." }), /SOURCE source-|fileData|Authoritative source catalog/i);

  assert.deepEqual(normalizeTextStyleIntent({ mode: "semantic_style", profileId: "clean_commercial", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only" }, "Make it elegant."), {
    mode: "semantic_style", coverage: "style_only", profileId: "clean_commercial", styleText: "elegant"
  });
  for (const invalid of [
    { mode: "semantic_style", profileId: "unknown", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only" },
    { mode: "semantic_style", profileId: "cinematic", strength: "maximum", styleText: "elegant", constraints: [], coverage: "style_only" },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: "elegant", constraints: ["avoid_darkening", "avoid_darkening"], coverage: "style_only" },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only", recipe: { brightness: 1 } },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only", profileVersion: "1" },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only", filters: ["eq=contrast=2"] },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only", lutPath: "private.cube" },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: "not in the request", constraints: [], coverage: "style_only" },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: "", constraints: [], coverage: "style_only" },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", styleText: 7, constraints: [], coverage: "style_only" },
    { mode: "semantic_style", profileId: "cinematic", strength: "standard", constraints: [] },
    { mode: "delegated_taste", profileId: "cinematic", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only" },
    { mode: "not_style", profileId: "cinematic", strength: "standard", styleText: "elegant", constraints: [], coverage: "style_only" }
  ]) assert.throws(() => normalizeTextStyleIntent(invalid, "Make it elegant."), /style interpretation|style requires|must not select/);
  assert.deepEqual(reconcileResolvedStyleProfile({ version: "1", operations: [{ type: "color_grade", style: "cinematic" }] }, { profileId: "clean_commercial" }).operations, [
    { type: "style_profile", profileId: "clean_commercial" }
  ]);
  assert.deepEqual(reconcileResolvedStyleProfile({ version: "2", operations: [{ type: "color_grade", sourceId: "source-1", style: "warm" }] }, { profileId: "clean_commercial", sourceId: "source-2" }).operations, [
    { type: "color_grade", sourceId: "source-1", style: "warm" }, { type: "style_profile", profileId: "clean_commercial", sourceId: "source-2" }
  ]);

  const catalog = sourceCatalog.slice(0, 2);
  const textStyle = (profileId, styleText, coverage = "style_only", strength = "standard", constraints = []) => JSON.stringify({ mode: "semantic_style", profileId, strength, styleText, constraints, coverage });
  for (const [prompt, profileId] of [
    ["Make it elegant.", "clean_commercial"], ["Give it cozy holiday vibes.", "warm_travel"],
    ["Make it punchier.", "vibrant_social"], ["Make it understated and realistic.", "natural_documentary"]
  ]) {
    const styleText = prompt.match(/(?:elegant|cozy holiday vibes|punchier|understated and realistic)/i)[0];
    const client = createMockGemini({ responseText: textStyle(profileId, styleText) });
    const result = await withGeminiKey(() => createAiEditPlan({ prompt, sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: client }));
    assert.deepEqual(result.plan.operations, [{ type: "style_profile", profileId }], prompt);
    assert.equal(client.uploads.length, 0, prompt);
    assert.equal(client.requests.length, 1, prompt);
    assert.equal(typeof client.requests[0].contents, "string", prompt);
  }

  const fuzzyAdjustmentClient = createMockGemini({ responseText: textStyle("clean_commercial", "elegant") });
  const fuzzyAdjustment = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make it elegant and slightly warmer.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: fuzzyAdjustmentClient
  }));
  assert.deepEqual(fuzzyAdjustment.plan.operations, [
    { type: "style_profile", profileId: "clean_commercial" },
    { type: "visual_adjustment", temperature: 0.12 }
  ]);
  assert.equal(fuzzyAdjustmentClient.uploads.length, 0);
  assert.equal(fuzzyAdjustmentClient.requests.length, 1);
  const fuzzyContrastClient = createMockGemini({ responseText: textStyle("clean_commercial", "polished feel") });
  const fuzzyContrast = await withGeminiKey(() => createAiEditPlan({
    prompt: "Give it a polished feel and increase contrast slightly.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: fuzzyContrastClient
  }));
  assert.deepEqual(fuzzyContrast.plan.operations, [
    { type: "style_profile", profileId: "clean_commercial" },
    { type: "visual_adjustment", contrast: 0.12 }
  ]);
  assert.equal(fuzzyContrastClient.uploads.length, 0);
  assert.equal(fuzzyContrastClient.requests.length, 1);
  for (const prompt of ["Make it warmer.", "Make it slightly warmer.", "Increase contrast by 20%.", "Add a slight magenta tint."]) {
    const client = createMockGemini();
    const result = await withGeminiKey(() => createAiEditPlan({ prompt, sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: client }));
    assert.equal(result.source, "deterministic", prompt);
    assert.equal(client.requests.length, 1, prompt);
    assert.equal(client.requests[0].config.responseJsonSchema.properties.styleText, undefined, prompt);
  }

  const incorrectCoverage = normalizeTextStyleIntent(JSON.parse(textStyle("clean_commercial", "elegant")), "Make it elegant and remove the background.");
  assert.equal(isServerSafeTextStyleOnlyRequest("Make it elegant and remove the background.", incorrectCoverage, { sourceCatalog: [catalog[0]] }), false);
  assert.equal(isServerSafeTextStyleOnlyRequest("Make it elegant and add my logo.", normalizeTextStyleIntent(JSON.parse(textStyle("clean_commercial", "elegant")), "Make it elegant and add my logo."), { sourceCatalog: [catalog[0]] }), false);
  const unsafeClient = createMockGemini({ responses: [
    textStyle("clean_commercial", "elegant"),
    JSON.stringify({ version: "1", operations: [] })
  ] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: "Make it elegant and remove the background.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: unsafeClient
  }), UnsupportedEditRequestError));
  assert.equal(unsafeClient.uploads.length, 1);
  assert.equal(unsafeClient.requests.length, 2);

  const scopedClient = createMockGemini({ responseText: textStyle("clean_commercial", "elegant") });
  const scoped = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make video 2 elegant.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: scopedClient
  }));
  assert.deepEqual(scoped.plan.operations, [
    { type: "sequence", clips: catalog.map(({ sourceId, duration }) => ({ sourceId, start: 0, end: duration })) },
    { type: "style_profile", profileId: "clean_commercial", sourceId: "source-2" }
  ]);
  assert.equal(scopedClient.uploads.length, 0);
  const invalidScoped = createEditPlan({ prompt: "Make video 9 elegant.", hasMultipleVideos: true, sourceCatalog: catalog });
  assert.throws(() => validateEditPlan(invalidScoped, { sourceCatalog: catalog }), /unknown source/);

  const title = { type: "title", text: "Kerala", start: 1, end: 3, position: "bottom-center", size: "medium", color: "white", weight: "regular", font: "inter" };
  const mixedClient = createMockGemini({ responses: [
    textStyle("clean_commercial", "elegant", "style_plus_other_edits"),
    JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "cinematic" }, title] })
  ] });
  const mixed = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make it elegant and add a title.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: mixedClient
  }));
  assert.deepEqual(mixed.plan.operations, [title, { type: "style_profile", profileId: "clean_commercial" }]);
  assert.equal(mixedClient.uploads.length, 1);
  assert.equal(mixedClient.requests.length, 2);

  const momentClient = createMockGemini({ responses: [
    textStyle("clean_commercial", "polished feel", "style_plus_other_edits"),
    momentLocalizationResponse("source-1", [{ start: 1, end: 3 }]),
    JSON.stringify({ version: "1", operations: [] })
  ] });
  const moment = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the person enters and give it a polished feel.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: momentClient
  }));
  assert.deepEqual(moment.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 3 }] },
    { type: "style_profile", profileId: "clean_commercial" }
  ]);
  assert.equal(momentClient.uploads.length, 1, "moment understanding, not style interpretation, uploads the video");

  const semanticClient = createMockGemini({ responses: [
    textStyle("clean_commercial", "elegant", "style_plus_other_edits"),
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: catalog.map(({ sourceId, duration }) => ({ sourceId, start: 0, end: duration })) }] })
  ] });
  const semantic = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make the temple video elegant.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: semanticClient
  }));
  assert.deepEqual(semantic.plan.operations.at(-1), { type: "style_profile", profileId: "clean_commercial", sourceId: "source-2" });

});

test("B1 delegated content-aware taste reuses active media and preserves server authority", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const delegatedSchema = createDelegatedStyleDecisionJsonSchema();
  assert.deepEqual(delegatedSchema.properties.profileId.enum, ["none", ...STYLE_PROFILE_IDS]);
  assert.match(buildDelegatedStyleDecisionPrompt(), /tasteful/i);
  assert.doesNotMatch(buildDelegatedStyleDecisionPrompt(), /SOURCE source-|fileData|Authoritative source catalog/i);
  assert.equal(buildDelegatedStyleContents([{ source: catalog[0], file: { uri: "gemini://one", mimeType: "video/mp4" } }], "prompt").some((part) => typeof part === "string" && /SOURCE /.test(part)), false);

  const delegatedText = (styleText, coverage = "style_only") => JSON.stringify({
    mode: "delegated_taste", profileId: "none", strength: "standard", styleText, constraints: [], coverage
  });
  const decision = (profileId, strength = "standard", constraints = []) => JSON.stringify({
    decision: "selected_style", profileId, strength, constraints
  });
  assert.deepEqual(normalizeTextStyleIntent(JSON.parse(delegatedText("Make this look good")), "Make this look good."), {
    mode: "delegated_taste", coverage: "style_only", styleText: "Make this look good"
  });
  assert.equal(isServerSafeTextStyleOnlyRequest("Make this look good.", normalizeTextStyleIntent(JSON.parse(delegatedText("Make this look good")), "Make this look good."), { sourceCatalog: [catalog[0]] }), true);
  assert.equal(isServerSafeTextStyleOnlyRequest("Make this look good and add a title.", normalizeTextStyleIntent(JSON.parse(delegatedText("Make this look good")), "Make this look good and add a title."), { sourceCatalog: [catalog[0]] }), false);
  assert.equal(requiresDelegatedStyleJudgment("Choose whatever style suits this footage."), true);
  assert.equal(requiresDelegatedStyleJudgment("Make video 2 look good."), true);
  assert.deepEqual(normalizeDelegatedStyleDecision(JSON.parse(decision("cinematic", "subtle", ["skin_tone_conservative"]))), {
    decision: "selected_style", profileId: "cinematic", strength: "subtle", constraints: ["skin_tone_conservative"]
  });
  for (const invalid of [
    { decision: "no_safe_choice", profileId: "cinematic", strength: "standard", constraints: [] },
    { decision: "no_safe_choice", profileId: "none", strength: "strong", constraints: [] },
    { decision: "selected_style", profileId: "unknown", strength: "standard", constraints: [] },
    { decision: "selected_style", profileId: "cinematic", strength: "standard", constraints: ["avoid_darkening", "avoid_darkening"] },
    { decision: "selected_style", profileId: "cinematic", strength: "standard", constraints: [], sourceId: "source-2" },
    { decision: "selected_style", profileId: "cinematic", strength: "standard", constraints: [], profileVersion: "1" },
    { decision: "selected_style", profileId: "cinematic", strength: "standard", constraints: [], recipe: { brightness: 1 } },
    { decision: "selected_style", profileId: "cinematic", strength: "standard", constraints: [], filters: ["eq=contrast=2"] },
    { decision: "selected_style", profileId: "cinematic", strength: "standard", constraints: [], lutPath: "private.cube" }
  ]) assert.throws(() => normalizeDelegatedStyleDecision(invalid), /delegated style|no_safe_choice|selected_style/);

  const globalClient = createMockGemini({ responses: [
    delegatedText("Make this look good"), decision("clean_commercial")
  ] });
  const global = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make this look good.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: globalClient
  }));
  assert.deepEqual(global.plan.operations, [{ type: "style_profile", profileId: "clean_commercial" }]);
  assert.deepEqual(global.styleDiagnostics, {
    styleIntentMode: "delegated_taste",
    planningPath: "delegated_style_direct",
    delegatedDecision: { decision: "selected_style", profileId: "clean_commercial" },
    resolvedStyle: { profileId: "clean_commercial" }
  });
  assert.equal(globalClient.uploads.length, 1);
  assert.equal(globalClient.deletes.length, 1);
  assert.equal(globalClient.requests.length, 2, "text interpretation plus one visual taste decision only");
  assert.equal(globalClient.requests[1].contents.filter((part) => part?.fileData).length, 1);
  assert.equal(globalClient.requests[1].contents.some((part) => typeof part === "string" && /SOURCE /.test(part)), false);

  const warmClient = createMockGemini({ responses: [
    delegatedText("Choose whatever style suits this footage"), decision("warm_travel", "standard", ["avoid_oversaturation"])
  ] });
  const warm = await withGeminiKey(() => createAiEditPlan({
    prompt: "Choose whatever style suits this footage.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: warmClient
  }));
  assert.deepEqual(warm.plan.operations, [{ type: "style_profile", profileId: "warm_travel", constraints: ["avoid_oversaturation"] }]);

  const explicitClient = createMockGemini({ responses: [
    delegatedText("look good"), decision("cinematic", "subtle", ["skin_tone_conservative"])
  ] });
  const explicit = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make video 2 look good.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: explicitClient
  }));
  assert.deepEqual(explicit.plan.operations, [
    { type: "sequence", clips: catalog.map(({ sourceId, duration }) => ({ sourceId, start: 0, end: duration })) },
    { type: "style_profile", profileId: "cinematic", strength: "subtle", constraints: ["skin_tone_conservative"], sourceId: "source-2" }
  ]);
  assert.equal(explicitClient.requests[1].contents.filter((part) => part?.fileData).length, 1, "only the explicit source reaches visual taste selection");
  assert.equal(explicitClient.requests[1].contents.find((part) => part?.fileData)?.fileData.fileUri, explicitClient.uploads[1].uri);
  const invalidExplicitClient = createMockGemini();
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: "Make video 9 look good.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: invalidExplicitClient
  }), UnsupportedEditRequestError));
  assert.equal(invalidExplicitClient.uploads.length, 0, "an invalid explicit source cannot become an unrelated global taste decision");

  const semanticClient = createMockGemini({ responses: [
    delegatedText("look good"),
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    decision("natural_documentary"),
    JSON.stringify(fullSequence(catalog))
  ] });
  const semantic = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make the temple video look good.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: semanticClient
  }));
  assert.deepEqual(semantic.plan.operations.at(-1), { type: "style_profile", profileId: "natural_documentary", sourceId: "source-2" });
  assert.equal(semanticClient.requests[3].contents.filter((part) => part?.fileData).length, 1);
  assert.equal(semanticClient.requests[3].contents.find((part) => part?.fileData)?.fileData.fileUri, semanticClient.uploads[1].uri);

  const multiClient = createMockGemini({ responses: [
    delegatedText("Make these videos look good"), decision("vibrant_social", "standard", ["avoid_oversaturation"])
  ] });
  const multi = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make these videos look good.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: multiClient
  }));
  assert.equal(multiClient.requests[1].contents.filter((part) => part?.fileData).length, 2);
  assert.deepEqual(multi.plan.operations.filter((operation) => operation.type === "style_profile"), [{ type: "style_profile", profileId: "vibrant_social", constraints: ["avoid_oversaturation"] }]);

  const title = { type: "title", text: "Kerala", start: 1, end: 3, position: "bottom-center", size: "medium", color: "white", weight: "regular", font: "inter" };
  const mixedClient = createMockGemini({ responses: [
    delegatedText("Make this look good", "style_plus_other_edits"), decision("clean_commercial"),
    JSON.stringify({ version: "1", operations: [title] })
  ] });
  const mixed = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make this look good and add the title 'Kerala'.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: mixedClient
  }));
  assert.deepEqual(mixed.plan.operations, [title, { type: "style_profile", profileId: "clean_commercial" }]);
  assert.equal(mixedClient.requests.length, 3);
  const emptyMixedClient = createMockGemini({ responses: [
    delegatedText("Make this look good", "style_plus_other_edits"), decision("clean_commercial"),
    JSON.stringify({ version: "1", operations: [] })
  ] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: "Make this look good and remove the background.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: emptyMixedClient
  }), UnsupportedEditRequestError));

  const momentClient = createMockGemini({ responses: [
    delegatedText("make it look good", "style_plus_other_edits"),
    momentLocalizationResponse("source-1", [{ start: 1, end: 3 }]),
    decision("cinematic"),
    JSON.stringify({ version: "1", operations: [] })
  ] });
  const moment = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the person enters and make it look good.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: momentClient
  }));
  assert.deepEqual(moment.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 3 }] },
    { type: "style_profile", profileId: "cinematic" }
  ]);
  assert.equal(momentClient.uploads.length, 1);

  for (const response of [
    JSON.stringify({ decision: "no_safe_choice", profileId: "none", strength: "standard", constraints: [] }),
    JSON.stringify({ decision: "selected_style", profileId: "unknown", strength: "standard", constraints: [] }),
    "{malformed"
  ]) {
    const client = createMockGemini({ responses: [delegatedText("Make this look good"), response] });
    await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
      prompt: "Make this look good.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: client
    }), UnsupportedEditRequestError));
    assert.equal(client.deletes.length, 1);
  }
  const retryError = Object.assign(new Error("high demand"), { status: 503 });
  const exhaustedDecisionClient = createMockGemini({
    failures: [null, retryError, retryError, retryError],
    responses: [delegatedText("Make this look good")]
  });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: "Make this look good.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: exhaustedDecisionClient,
    retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }), UnsupportedEditRequestError));
  assert.equal(exhaustedDecisionClient.requests.length, 4, "the delegated visual decision uses bounded existing planning retries");
  assert.equal(exhaustedDecisionClient.uploads.length, 1);
  assert.equal(exhaustedDecisionClient.deletes.length, 1);

  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(() => createAiEditPlan({ prompt: "Make this look good.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: createMockGemini() }), UnsupportedEditRequestError);
    await assert.rejects(() => createAiEditPlan({ prompt: "Choose whatever style suits this footage.", sourceCatalog: [catalog[0]], sourceInputs: plannerSources([catalog[0]]), aiClient: createMockGemini() }), UnsupportedEditRequestError);
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  }
});

test("B1 delegated taste failures preserve the safe refusal while logging bounded diagnostic reasons", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const delegatedText = JSON.stringify({
    mode: "delegated_taste", profileId: "none", strength: "standard", styleText: "Make this look good", constraints: [], coverage: "style_only"
  });
  const cases = [
    {
      expectedReason: "DELEGATED_NO_SAFE_CHOICE",
      client: createMockGemini({ responses: [delegatedText, JSON.stringify({ decision: "no_safe_choice", profileId: "none", strength: "standard", constraints: [] })] })
    },
    {
      expectedReason: "DELEGATED_EMPTY_RESPONSE",
      client: createMockGemini({ responses: [delegatedText, ""] })
    },
    {
      expectedReason: "DELEGATED_INVALID_RESPONSE",
      client: createMockGemini({ responses: [delegatedText, "{malformed"] })
    },
    {
      expectedReason: "DELEGATED_MODEL_REQUEST_FAILED",
      client: createMockGemini({
        responses: [delegatedText],
        failures: [null, Object.assign(new Error("request https://private.example/file?access_token=secret"), { status: 503 }), Object.assign(new Error("request https://private.example/file?access_token=secret"), { status: 503 }), Object.assign(new Error("request https://private.example/file?access_token=secret"), { status: 503 })]
      }),
      retryOptions: { sleepFn: async () => {}, random: () => 0 }
    }
  ];

  for (const { expectedReason, client, retryOptions } of cases) {
    const originalError = console.error;
    const diagnostics = [];
    console.error = (message, details) => {
      if (message === "Gemini delegated style decision rejected:") diagnostics.push(details);
    };
    try {
      await withGeminiKey(() => assert.rejects(
        () => createAiEditPlan({
          prompt: "Make this look good.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: client, retryOptions
        }),
        (error) => error instanceof UnsupportedEditRequestError && error.message === "This style request needs visual understanding"
      ));
    } finally {
      console.error = originalError;
    }
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].reason, expectedReason);
    if (expectedReason === "DELEGATED_MODEL_REQUEST_FAILED") {
      assert.equal(diagnostics[0].status, 503);
      assert.equal(diagnostics[0].transient, true);
      assert.doesNotMatch(diagnostics[0].message || "", /private\.example|secret/i);
    }
    assert.equal(client.deletes.length, 1, "uploaded Gemini media is still cleaned once after each safe rejection");
  }
});

test("B1 delegated cinematic highlight protection composes with an authoritative visual moment", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const client = createMockGemini({ responses: [
    JSON.stringify({
      mode: "delegated_taste", profileId: "none", strength: "standard", styleText: "make this look good", constraints: [], coverage: "style_plus_other_edits"
    }),
    momentLocalizationResponse("source-1", [{ start: 2, end: 6 }]),
    JSON.stringify({ decision: "selected_style", profileId: "cinematic", strength: "standard", constraints: ["avoid_oversaturation"] }),
    JSON.stringify({ version: "1", operations: [] })
  ] });

  const planning = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the person walks through the temple and make this look good.",
    sourceCatalog: catalog,
    sourceInputs: plannerSources(catalog),
    aiClient: client
  }));
  assert.deepEqual(planning.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 2, end: 6 }] },
    { type: "style_profile", profileId: "cinematic", constraints: ["avoid_oversaturation"] }
  ]);
  assert.deepEqual(buildStyleProfileFilters(planning.plan.operations[1]), [
    "curves=master='0/0 0.25/0.2500 0.75/0.7286 1/1'",
    "eq=brightness=0.0000:contrast=1.2222:saturation=0.8669",
    "colorbalance=rs=0.0166:gs=0.0108:bs=-0.0166:rm=0.0221:gm=0.0108:bm=-0.0221:rh=0.0166:gh=0.0108:bh=-0.0166:pl=1"
  ]);
});

const execFileAsync = promisify(execFile);

test("3C-A visual adjustment intent, validation, source scope, and filters remain bounded", () => {
  assert.deepEqual(extractVisualAdjustmentIntent("Increase the brightness by 20%."), { type: "visual_adjustment", brightness: 0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("Reduce the brightness by 20%."), { type: "visual_adjustment", brightness: -0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("Increase the brightness by 150%."), { type: "visual_adjustment", brightness: 1.5 });
  assert.deepEqual(extractVisualAdjustmentIntent("Reduce the brightness by 150%."), { type: "visual_adjustment", brightness: -1.5 });
  assert.deepEqual(extractVisualAdjustmentIntent("Reduce the saturation a little."), { type: "visual_adjustment", saturation: -0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Increase contrast slightly."), { type: "visual_adjustment", contrast: 0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Increase the contrast a little."), { type: "visual_adjustment", contrast: 0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Increase contrast."), { type: "visual_adjustment", contrast: 0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("More contrast."), { type: "visual_adjustment", contrast: 0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("Increase contrast by 20%."), { type: "visual_adjustment", contrast: 0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("Add a slight magenta tint."), { type: "visual_adjustment", tint: 0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Add a slightly magenta tint."), { type: "visual_adjustment", tint: 0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Add a magenta tint."), { type: "visual_adjustment", tint: 0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("Add a little green tint."), { type: "visual_adjustment", tint: -0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Add a green tint."), { type: "visual_adjustment", tint: -0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("Make it slightly brighter, warmer, and more contrasty."), { type: "visual_adjustment", brightness: 0.12, temperature: 0.2, contrast: 0.2 });
  assert.deepEqual(extractVisualAdjustmentIntent("Make it brighter and slightly warmer."), { type: "visual_adjustment", brightness: 0.2, temperature: 0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Make it a little warmer."), { type: "visual_adjustment", temperature: 0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Make it a little cooler."), { type: "visual_adjustment", temperature: -0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Cool the footage down slightly."), { type: "visual_adjustment", temperature: -0.12 });
  assert.deepEqual(extractVisualAdjustmentIntent("Add a slight green tint."), { type: "visual_adjustment", tint: -0.12 });
  const scoped = reconcileVisualAdjustments({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 2 }] }] }, "Make video 2 warmer.", { sourceCatalog });
  assert.deepEqual(scoped.operations.at(-1), { type: "visual_adjustment", temperature: 0.2, sourceId: "source-2" });
  assert.doesNotThrow(() => validateEditPlan({ version: "1", operations: [{ type: "visual_adjustment", brightness: 0.2, contrast: -0.2, saturation: 0, temperature: 0.1, tint: -0.1 }] }));
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "visual_adjustment" }] }), /at least one/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "visual_adjustment", brightness: 1.1 }] }), /between -1 and 1/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "visual_adjustment", brightness: 1.5 }] }), /between -1 and 1/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "visual_adjustment", brightness: -1.5 }] }), /between -1 and 1/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "visual_adjustment", brightness: Number.NaN }] }), /between -1 and 1/);
  assert.deepEqual(buildVisualAdjustmentFilters({ brightness: 0.2, contrast: 0.2, saturation: -0.2, temperature: 0.2, tint: -0.2 }), [
    "eq=brightness=0.1298:contrast=1.2662:saturation=0.6754",
    "colorbalance=rs=0.0584:gs=0.0685:bs=-0.0584:rm=0.0779:gm=0.0685:bm=-0.0779:rh=0.0584:gh=0.0685:bh=-0.0584:pl=1"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ brightness: -1, contrast: -1, saturation: -1, temperature: -1, tint: 1 }), [
    "eq=brightness=-0.4500:contrast=0.1000:saturation=0.1000",
    "colorbalance=rs=-0.1800:gs=-0.1900:bs=0.1800:rm=-0.2400:gm=-0.1900:bm=0.2400:rh=-0.1800:gh=-0.1900:bh=0.1800:pl=1"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ brightness: 1, contrast: 1, saturation: 1, temperature: 1, tint: -1 }), [
    "eq=brightness=0.3600:contrast=1.7380:saturation=1.9000",
    "colorbalance=rs=0.1620:gs=0.1900:bs=-0.1620:rm=0.2160:gm=0.1900:bm=-0.2160:rh=0.1620:gh=0.1900:bh=-0.1620:pl=1"
  ]);
  assert.equal(perceptualAdjustmentMagnitude(0), 0);
  assert.equal(perceptualAdjustmentMagnitude(1), 1);
  assert.equal(perceptualAdjustmentMagnitude(-1), -1);
  assert.ok(perceptualAdjustmentMagnitude(0.12) > 0.12, "slight adjustments receive a perceptual lift");
  assert.ok(perceptualAdjustmentMagnitude(0.2) > 0.2, "normal adjustments receive a perceptual lift");
  assert.ok(perceptualAdjustmentMagnitude(0.2) < perceptualAdjustmentMagnitude(1), "the curve remains bounded and monotonic");
  assert.deepEqual(buildVisualAdjustmentFilters({ brightness: 0.12, contrast: 0.12, saturation: -0.12, temperature: 0.12, tint: -0.12 }), [
    "eq=brightness=0.0962:contrast=1.1972:saturation=0.7596",
    "colorbalance=rs=0.0433:gs=0.0508:bs=-0.0433:rm=0.0577:gm=0.0508:bm=-0.0577:rh=0.0433:gh=0.0508:bh=-0.0433:pl=1"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ brightness: -0.2, contrast: -0.2, saturation: 0.2 }), [
    "eq=brightness=-0.1623:contrast=0.6754:saturation=1.3246"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ temperature: 0.2 }), [
    "colorbalance=rs=0.0649:gs=0.0000:bs=-0.0649:rm=0.0866:gm=0.0000:bm=-0.0866:rh=0.0649:gh=0.0000:bh=-0.0649:pl=1"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ temperature: -0.2 }), [
    "colorbalance=rs=-0.0649:gs=0.0000:bs=0.0649:rm=-0.0866:gm=0.0000:bm=0.0866:rh=-0.0649:gh=0.0000:bh=0.0649:pl=1"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ tint: 0.12 }), [
    "colorbalance=rs=0.0000:gs=-0.0508:bs=0.0000:rm=0.0000:gm=-0.0508:bm=0.0000:rh=0.0000:gh=-0.0508:bh=0.0000:pl=1"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ tint: -0.12 }), [
    "colorbalance=rs=0.0000:gs=0.0508:bs=0.0000:rm=0.0000:gm=0.0508:bm=0.0000:rh=0.0000:gh=0.0508:bh=0.0000:pl=1"
  ]);
  assert.deepEqual(buildVisualAdjustmentFilters({ temperature: 1, tint: 1 }), [
    "colorbalance=rs=0.1800:gs=-0.1900:bs=-0.1800:rm=0.2400:gm=-0.1900:bm=-0.2400:rh=0.1800:gh=-0.1900:bh=-0.1800:pl=1"
  ], "temperature and tint remain independently bounded without pink red boosting");
  const standaloneBrightness = buildVisualAdjustmentFilters({ brightness: 0.2 });
  const standaloneContrast = buildVisualAdjustmentFilters({ contrast: 0.2 });
  const riskyCombination = { brightness: 0.2, contrast: 0.2, temperature: 0.2 };
  assert.deepEqual(standaloneBrightness, ["eq=brightness=0.1623"]);
  assert.deepEqual(standaloneContrast, ["eq=contrast=1.3246"]);
  assert.deepEqual(buildVisualAdjustmentFilters(riskyCombination), [
    "eq=brightness=0.1298:contrast=1.2662",
    "colorbalance=rs=0.0584:gs=0.0000:bs=-0.0584:rm=0.0779:gm=0.0000:bm=-0.0779:rh=0.0584:gh=0.0000:bh=-0.0584:pl=1"
  ]);
  assert.deepEqual(riskyCombination, { brightness: 0.2, contrast: 0.2, temperature: 0.2 }, "headroom changes only rendered filter strength, never the normalized plan");
  assert.equal(createEditPlan({ prompt: "Make it warmer." }).operations.some((operation) => operation.type === "color_grade"), false);
  assert.deepEqual(createEditPlan({ prompt: "Make it warmer." }).operations, [{ type: "visual_adjustment", temperature: 0.2 }]);
  assert.deepEqual(createEditPlan({ prompt: "Apply the warm filter." }).operations, [{ type: "color_grade", style: "warm" }]);
  assert.deepEqual(createEditPlan({ prompt: "Use the cool look." }).operations, [{ type: "color_grade", style: "blue" }]);
  assert.deepEqual(createEditPlan({ prompt: "Make this video black and white." }).operations, [{ type: "color_grade", style: "bw" }]);
  const preserveSequence = createEditPlan({ prompt: "Use video 1, then video 2, and make video 2 warmer.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(preserveSequence.operations[0].clips.map((clip) => clip.sourceId), ["source-1", "source-2"]);
  assert.deepEqual(preserveSequence.operations.at(-1), { type: "visual_adjustment", temperature: 0.2, sourceId: "source-2" });
  const reverseSequence = createEditPlan({ prompt: "Use video 2, then video 1, and make video 2 warmer.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(reverseSequence.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.deepEqual(reverseSequence.operations.at(-1), { type: "visual_adjustment", temperature: 0.2, sourceId: "source-2" });
  const combinedScoped = createEditPlan({ prompt: "Make video 2 slightly brighter, warmer, and more contrasty.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(combinedScoped.operations[0].clips.map((clip) => clip.sourceId), ["source-1", "source-2"]);
  assert.deepEqual(combinedScoped.operations.at(-1), { type: "visual_adjustment", brightness: 0.12, temperature: 0.2, contrast: 0.2, sourceId: "source-2" });
  assert.deepEqual(createEditPlan({ prompt: "Make the second video brighter and slightly warmer.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) }).operations.at(-1), { type: "visual_adjustment", brightness: 0.2, temperature: 0.12, sourceId: "source-2" });
  const reorderedCombined = createEditPlan({ prompt: "Make a sequence with video 2 then video 1, and make video 1 brighter and warmer.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(reorderedCombined.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.deepEqual(reorderedCombined.operations.at(-1), { type: "visual_adjustment", brightness: 0.2, temperature: 0.2, sourceId: "source-1" });
  const contrastScoped = createEditPlan({ prompt: "Make video 2 brighter and increase contrast.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(contrastScoped.operations[0].clips.map((clip) => clip.sourceId), ["source-1", "source-2"]);
  assert.deepEqual(contrastScoped.operations.at(-1), { type: "visual_adjustment", brightness: 0.2, contrast: 0.2, sourceId: "source-2" });
  assert.deepEqual(createEditPlan({ prompt: "Make video 2 warmer and reduce saturation a little.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) }).operations.at(-1), { type: "visual_adjustment", temperature: 0.2, saturation: -0.12, sourceId: "source-2" });
  const sequenceAndContrast = createEditPlan({ prompt: "Make a sequence with video 2 then video 1, and make video 1 brighter and increase contrast.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(sequenceAndContrast.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.deepEqual(sequenceAndContrast.operations.at(-1), { type: "visual_adjustment", brightness: 0.2, contrast: 0.2, sourceId: "source-1" });
  assert.deepEqual(createEditPlan({ prompt: "Make video 2 brighter, then add a title.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) }).operations.at(-1), { type: "visual_adjustment", brightness: 0.2, sourceId: "source-2" });
  const captionedVisual = createEditPlan({ prompt: "Make video 2 brighter and increase contrast, then add subtitles.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(captionedVisual.operations.at(-1), { type: "visual_adjustment", brightness: 0.2, contrast: 0.2, sourceId: "source-2" });
  assert.equal(captionedVisual.operations.some((operation) => operation.type === "captions"), true);
  const scopedAudioVisual = createEditPlan({ prompt: "Make the second video warmer, then reduce the audio volume.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(scopedAudioVisual.operations.find((operation) => operation.type === "visual_adjustment"), { type: "visual_adjustment", temperature: 0.2, sourceId: "source-2" });
  assert.deepEqual(scopedAudioVisual.operations.find((operation) => operation.type === "audio_volume"), { type: "audio_volume", factor: 0.5 });
  const audioVisual = createEditPlan({ prompt: "Use video 2, then video 1, make video 1 warmer, then reduce the audio volume.", hasMultipleVideos: true, sourceCatalog: sourceCatalog.slice(0, 2) });
  assert.deepEqual(audioVisual.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.deepEqual(audioVisual.operations.find((operation) => operation.type === "visual_adjustment"), { type: "visual_adjustment", temperature: 0.2, sourceId: "source-1" });
  assert.deepEqual(audioVisual.operations.find((operation) => operation.type === "audio_volume"), { type: "audio_volume", factor: 0.5 });
  assert.deepEqual(reconcileVisualAdjustments({ version: "2", operations: [] }, "Make the temple video warmer.", { sourceCatalog, resolvedSemanticSources: [{ description: "temple video", sourceId: "source-3" }] }).operations, [{ type: "visual_adjustment", temperature: 0.2, sourceId: "source-3" }]);
  assert.deepEqual(reconcileVisualAdjustments({ version: "2", operations: [] }, "Use the temple video, then make it brighter.", { sourceCatalog, resolvedSemanticSources: [{ description: "temple video", sourceId: "source-3" }] }).operations, [{ type: "visual_adjustment", brightness: 0.2 }]);
});

const video = { name: "source.mp4", type: "video/mp4", size: 1024 };
const sourceCatalog = createSourceCatalog(
  [
    { ...video, index: 0, name: "A.mp4" },
    { ...video, index: 1, name: "B.mp4" },
    { ...video, index: 2, name: "C.mp4" }
  ],
  [
    { duration: 20, width: 1920, height: 1080 },
    { duration: 30, width: 1280, height: 720 },
    { duration: 40, width: 1080, height: 1920 }
  ]
);

function plannerSources(catalog = sourceCatalog) {
  return catalog.map((source) => ({ inputPath: `/tmp/${source.sourceId}.mp4`, inputMimeType: "video/mp4", source }));
}

function createMockGemini({ responseText, responses = [], failures = [], transcriptionInteractions = [] } = {}) {
  const uploads = [];
  const deletes = [];
  const requests = [];
  let generateCalls = 0;
  const interactionRequests = [];
  return {
    uploads, deletes, requests, interactionRequests,
    files: {
      upload: async ({ file }) => {
        const uploaded = { name: `files/${uploads.length + 1}`, uri: `gemini://${file}`, mimeType: "video/mp4", state: "ACTIVE" };
        uploads.push(uploaded);
        return uploaded;
      },
      get: async ({ name }) => uploads.find((file) => file.name === name),
      delete: async ({ name }) => { deletes.push(name); }
    },
    models: {
      generateContent: async (request) => {
        requests.push(request);
        const responseIndex = generateCalls++;
        const failure = failures[responseIndex];
        if (failure) throw failure;
        return { text: responses[responseIndex] ?? responseText };
      }
    },
    interactions: {
      create: async (request) => { interactionRequests.push(request); return transcriptionInteractions.shift() || { steps: [] }; }
    }
  };
}

function classificationResponse(sourceId, matches) {
  return JSON.stringify({ sourceId, matches });
}

function momentLocalizationResponse(sourceId, candidates, momentId = "moment-1") {
  return JSON.stringify({ sourceId, moments: [{ momentId, candidates }] });
}
function semanticTranscriptResponse(sourceId, candidates, momentId = "moment-1") {
  return JSON.stringify({ sourceId, momentId, candidates });
}

function fullSequence(catalog = sourceCatalog, sourceIds = catalog.map((source) => source.sourceId)) {
  return {
    version: "2",
    operations: [{ type: "sequence", clips: sourceIds.map((sourceId) => {
      const source = catalog.find((entry) => entry.sourceId === sourceId);
      return { sourceId, start: 0, end: source.duration };
    }) }]
  };
}

async function withGeminiKey(callback) {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try { return await callback(); } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
}

async function assertSpokenRejection(promiseFactory, expectedReason) {
  const originalError = console.error;
  const reasons = [];
  console.error = (message, details) => {
    if (message === "Spoken moment localization rejected:") reasons.push(details?.reason);
  };
  try {
    await assert.rejects(promiseFactory, UnsupportedEditRequestError);
  } finally {
    console.error = originalError;
  }
  assert.ok(reasons.includes(expectedReason), `expected ${expectedReason}, received ${reasons.join(", ")}`);
}

function createMockChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function successfulSpawn(calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    const child = createMockChild(); child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
}
function transcriptionMock({ interactions = [], uploadError, deleteError } = {}) {
  const calls = { uploads: [], interactions: [], deletes: [] };
  return { calls, files: {
    upload: async (request) => { calls.uploads.push(request); if (uploadError) throw uploadError; return { name: "audio-file", uri: "private-uri", mimeType: "audio/m4a" }; },
    delete: async (request) => { calls.deletes.push(request); if (deleteError) throw deleteError; }
  }, interactions: { create: async (request) => { calls.interactions.push(request); const value = interactions.shift(); if (value instanceof Error) throw value; return value || { steps: [] }; } } };
}
function interaction(words = [{ text: "Hello", start_offset: "1s", end_offset: "1.4s" }]) { return { steps: [{ content: [{ annotations: words.map((word) => ({ type: "word_info", ...word })) }] }] }; }

const transcriptWords = [
  { text: "Welcome", start: 1, end: 1.3 }, { text: "to", start: 1.3, end: 1.4 }, { text: "Kerala!", start: 1.4, end: 1.9 },
  { text: "The", start: 2.8, end: 3 }, { text: "Pro", start: 3, end: 3.2 }, { text: "plan", start: 3.2, end: 3.5 }, { text: "costs", start: 3.5, end: 3.8 }, { text: "twelve", start: 3.8, end: 4.1 }, { text: "dollars.", start: 4.1, end: 4.5 },
  { text: "Clip", start: 5.5, end: 5.8 }, { text: "or", start: 5.8, end: 5.9 }, { text: "Not.", start: 5.9, end: 6.3 }
];
function transcript(words = transcriptWords) { return createCanonicalTranscript({ sourceId: "source-1", duration: 10, words }); }
function speechCatalog(catalog = sourceCatalog) { return catalog.map((source) => ({ ...source, hasAudio: true })); }

test("spoken transcript validation rejects malformed and non-monotonic words", () => {
  assert.deepEqual(validateTranscriptWords({ sourceId: "source-1", duration: 2, words: [{ text: "Hi", start: 0, end: 1 }] }), [{ text: "Hi", start: 0, end: 1 }]);
  for (const words of [[{ text: "x", start: -1, end: 0 }], [{ text: "x", start: 0, end: Infinity }], [{ text: "x", start: 1, end: 0 }], [{ text: "x", start: 0, end: 3 }], [{ text: "a", start: 1, end: 2 }, { text: "b", start: 1.5, end: 2.1 }]]) {
    assert.throws(() => validateTranscriptWords({ sourceId: "source-1", duration: 2, words }), TranscriptValidationError);
  }
});

test("spoken transcript segmentation is stable and uses sentence/pause boundaries", () => {
  const first = transcript(); const second = transcript();
  assert.deepEqual(first, second);
  assert.deepEqual(first.segments.map(({ segmentId, start, end }) => ({ segmentId, start, end })), [
    { segmentId: "source-1-seg-1", start: 1, end: 1.9 }, { segmentId: "source-1-seg-2", start: 2.8, end: 4.5 }, { segmentId: "source-1-seg-3", start: 5.5, end: 6.3 }
  ]);
});

test("spoken phrase normalization covers punctuation, contractions, numbers, and currency", () => {
  assert.equal(normalizePhrase(" Welcome   to Kerala! "), "welcome to kerala");
  assert.equal(normalizePhrase("I'm here"), "i am here");
  assert.equal(normalizePhrase("$12"), normalizePhrase("twelve dollars"));
});

test("spoken phrase occurrences are exact/near-exact, contiguous, and preserve ambiguity", () => {
  assert.equal(findPhraseOccurrences(transcript(), "WELCOME to Kerala").length, 1);
  assert.equal(findPhraseOccurrences(transcript(), "The Pro plan costs $12").length, 1);
  assert.equal(findPhraseOccurrences(transcript(), "Cliponaut").length, 1);
  assert.equal(findPhraseOccurrences(transcript(), "unrelated vaguely similar idea").length, 0);
  const repeated = transcript([...transcriptWords, { text: "Welcome", start: 7, end: 7.3 }, { text: "to", start: 7.3, end: 7.4 }, { text: "Kerala.", start: 7.4, end: 7.9 }]);
  assert.equal(findPhraseOccurrences(repeated, "welcome to kerala").length, 2);
});

test("spoken phrase matching prefers exact windows before near-exact fallback", () => {
  const productionTranscript = transcript([
    { text: "Hello", start: 0.2, end: 0.5 }, { text: "team", start: 0.5, end: 0.8 }, { text: "TechStars", start: 0.8, end: 1.3 },
    { text: "I", start: 1.3, end: 1.4 }, { text: "am", start: 1.4, end: 1.6 }, { text: "Mohammed.", start: 1.6, end: 2.1 }
  ]);
  const productionMatches = findPhraseOccurrences(productionTranscript, "Hello, team TechStars");
  assert.deepEqual(productionMatches.map(({ start, end }) => ({ start, end })), [{ start: 0.2, end: 1.3 }]);

  const exactAndNear = transcript([
    { text: "Welcome", start: 0, end: 0.3 }, { text: "everyone.", start: 0.3, end: 0.8 },
    { text: "Welcome", start: 2, end: 2.3 }, { text: "everyon.", start: 2.3, end: 2.8 }
  ]);
  assert.deepEqual(findPhraseOccurrences(exactAndNear, "Welcome everyone").map(({ start, end }) => ({ start, end })), [{ start: 0, end: 0.8 }]);

  const nearOnly = transcript([
    { text: "Clip", start: 0, end: 0.3 }, { text: "or", start: 0.3, end: 0.4 }, { text: "Not.", start: 0.4, end: 0.8 }
  ]);
  assert.deepEqual(findPhraseOccurrences(nearOnly, "Cliponaut").map(({ start, end }) => ({ start, end })), [{ start: 0, end: 0.8 }]);
});

test("whole-window normalization matches contractions without annotation-count assumptions", () => {
  const founderWords = [
    { text: "I'm", start: 0, end: 0.3 }, { text: "a", start: 0.3, end: 0.4 }, { text: "solo", start: 0.4, end: 0.8 }, { text: "founder", start: 0.8, end: 1.2 },
    { text: "of", start: 1.2, end: 1.4 }, { text: "Clip", start: 1.4, end: 1.7 }, { text: "or", start: 1.7, end: 1.8 }, { text: "Not.", start: 1.8, end: 2.1 }
  ];
  const founderPhrase = "I'm a solo founder";
  assert.equal(normalizePhrase(founderPhrase).split(" ").length, 5);
  assert.equal(founderWords.slice(0, 4).length, 4);
  assert.deepEqual(findPhraseOccurrences(transcript(founderWords), founderPhrase).map(({ start, end }) => ({ start, end })), [{ start: 0, end: 1.2 }]);
  assert.deepEqual(findPhraseOccurrences(transcript(founderWords), "Cliponaut").map(({ start, end }) => ({ start, end })), [{ start: 1.4, end: 2.1 }]);

  const multipleContractions = transcript([
    { text: "I'm", start: 0, end: 0.3 }, { text: "sure", start: 0.3, end: 0.6 }, { text: "you're", start: 0.6, end: 1 }, { text: "ready.", start: 1, end: 1.4 }
  ]);
  assert.deepEqual(findPhraseOccurrences(multipleContractions, "I am sure you are ready").map(({ start, end }) => ({ start, end })), [{ start: 0, end: 1.4 }]);

  const repeated = transcript([
    ...founderWords.slice(0, 4),
    { text: "Later.", start: 3, end: 3.4 },
    { text: "I'm", start: 4, end: 4.3 }, { text: "a", start: 4.3, end: 4.4 }, { text: "solo", start: 4.4, end: 4.8 }, { text: "founder.", start: 4.8, end: 5.2 }
  ]);
  assert.equal(findPhraseOccurrences(repeated, founderPhrase).length, 2);

  const exactAndNear = transcript([
    ...founderWords.slice(0, 4),
    { text: "I'm", start: 3, end: 3.3 }, { text: "a", start: 3.3, end: 3.4 }, { text: "solo", start: 3.4, end: 3.8 }, { text: "foundr.", start: 3.8, end: 4.2 }
  ]);
  assert.deepEqual(findPhraseOccurrences(exactAndNear, founderPhrase).map(({ start, end }) => ({ start, end })), [{ start: 0, end: 1.2 }]);
});

test("spoken phrase ranges and ordered pairs remain deterministic", () => {
  const value = transcript();
  const start = findPhraseOccurrences(value, "welcome to kerala", "START_BOUNDARY");
  const end = findPhraseOccurrences(value, "cliponaut", "END_BOUNDARY");
  assert.deepEqual(start[0].start, 1); assert.deepEqual(start[0].end, 1.9);
  assert.deepEqual(pairPhraseOccurrences(start, end).map(({ start: left, end: right }) => ({ start: left, end: right })), [{ start: 1, end: 6.3 }]);
  assert.deepEqual(pairPhraseOccurrences(end, start), []);
});

test("spoken routing takes exact and semantic speech out of visual localization", () => {
  const one = speechCatalog([sourceCatalog[0]]);
  const exact = extractSpokenMomentRequest('Use the part where she says "Welcome".', one);
  assert.deepEqual(exact, { momentId: "moment-1", type: "exact", mode: "EVENT_SEGMENT", startPhrase: "Welcome", sourceScope: { type: "single", sourceId: "source-1" } });
  assert.equal(extractVisualMomentRequest('Use the part where she says "Welcome".', one), null);
  const semantic = extractSpokenMomentRequest("Start when I begin talking about Cliponaut.", one);
  assert.equal(semantic.type, "semantic");
  assert.equal(requiresSpokenMomentUnderstanding("Start when I begin talking about Cliponaut.", one), true);
  assert.equal(extractVisualMomentRequest("Start when I begin talking about Cliponaut.", one), null);
  assert.ok(extractVisualMomentRequest("Use the part where the car enters the frame.", one));
});

test("semantic spoken parsing preserves modes and excludes visual routing", () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const event = extractSpokenMomentRequest("Use the part where I explain pricing.", catalog);
  const start = extractSpokenMomentRequest("Start when I begin talking about Cliponaut.", catalog);
  const end = extractSpokenMomentRequest("End when I start talking about integrations.", catalog);
  const paired = extractSpokenMomentRequest("Start when I begin talking about pricing and end when I begin talking about integrations.", catalog);
  assert.deepEqual(event, { momentId: "moment-1", type: "semantic", mode: "EVENT_SEGMENT", startTopicDescription: "pricing", sourceScope: { type: "single", sourceId: "source-1" } });
  assert.equal(start.mode, "START_BOUNDARY"); assert.equal(start.startTopicDescription, "Cliponaut");
  assert.equal(end.mode, "END_BOUNDARY"); assert.equal(end.endTopicDescription, "integrations");
  assert.equal(paired.mode, "START_END_BOUNDARY"); assert.equal(paired.startTopicDescription, "pricing"); assert.equal(paired.endTopicDescription, "integrations");
  assert.equal(extractVisualMomentRequest("Use the part where I explain pricing.", catalog), null);
});

test("semantic transcript schema and prompt use segment IDs rather than timestamps", () => {
  const schema = createSemanticTranscriptMatchJsonSchema({ sourceId: "source-1", momentId: "moment-1" });
  assert.deepEqual(Object.keys(schema.properties.candidates.items.properties).sort(), ["endSegmentId", "startSegmentId"]);
  const text = buildSemanticTranscriptMatchPrompt({ source: speechCatalog([sourceCatalog[0]])[0], moment: { momentId: "moment-1", mode: "EVENT_SEGMENT", startTopicDescription: "pricing" }, transcript: transcript() });
  assert.match(text, /segmentId/); assert.doesNotMatch(text, /"start"\s*:/);
});

test("semantic spoken matching derives coherent ranges and validates segment IDs", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const pricingWords = [
    { text: "Now", start_offset: "1s", end_offset: "1.2s" }, { text: "plans.", start_offset: "1.2s", end_offset: "1.6s" },
    { text: "Pricing", start_offset: "2.5s", end_offset: "2.9s" }, { text: "is", start_offset: "2.9s", end_offset: "3s" }, { text: "twelve.", start_offset: "3s", end_offset: "3.4s" },
    { text: "Unlimited", start_offset: "4.4s", end_offset: "4.8s" }, { text: "exports.", start_offset: "4.8s", end_offset: "5.3s" },
    { text: "Integrations.", start_offset: "6.3s", end_offset: "6.9s" }
  ];
  const aiClient = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-3" }]),
    JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })
  ], transcriptionInteractions: [interaction(pricingWords)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where I explain pricing and make it black and white.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 5.3 }] }, { type: "color_grade", style: "bw" }]);
  assert.equal(aiClient.requests.length, 2);
});

test("semantic spoken ranges override final timestamps and reject conflicting source operations", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const words = [{ text: "Pricing.", start_offset: "2s", end_offset: "2.5s" }];
  const override = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    JSON.stringify({ version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 9, end: 19 }] },
      { type: "color_grade", style: "bw" }
    ] })
  ], transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 1, use the part where I explain pricing and make it black and white.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: override,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 2, end: 2.5 }] },
    { type: "color_grade", style: "bw" }
  ]);

  const conflict = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    JSON.stringify({ version: "2", operations: [{ type: "color_grade", sourceId: "source-2", style: "bw" }] })
  ], transcriptionInteractions: [interaction(words)] });
  await withGeminiKey(() => assertSpokenRejection(() => createAiEditPlan({
    prompt: "From video 1, use the part where I explain pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: conflict,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), "SPEECH_SOURCE_MISMATCH"));
});

test("semantic spoken response rejects malformed, unknown, and reversed segment references", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [
    { text: "Pricing.", start_offset: "1s", end_offset: "1.5s" },
    { text: "Integrations.", start_offset: "2.5s", end_offset: "3s" }
  ];
  const invalid = [
    { responseText: semanticTranscriptResponse("source-2", []), reason: "SPEECH_SOURCE_MISMATCH" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "missing", endSegmentId: "source-1-seg-1" }]), reason: "SPEECH_UNKNOWN_SEGMENT" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "missing" }]), reason: "SPEECH_UNKNOWN_SEGMENT" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-2", endSegmentId: "source-1-seg-1" }]), reason: "SPEECH_INVALID_SEGMENT_RANGE" },
    { responseText: JSON.stringify({ sourceId: "source-1", momentId: "moment-1", candidates: [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1", start: 999, end: 120 }] }), reason: "SPEECH_MALFORMED_SEMANTIC_RESPONSE" },
    { responseText: semanticTranscriptResponse("source-1", [{ endSegmentId: "source-1-seg-1" }]), reason: "SPEECH_MISSING_SEGMENT" },
    { responseText: semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1" }]), reason: "SPEECH_MISSING_SEGMENT" },
    { responseText: JSON.stringify({ sourceId: "source-1", momentId: "moment-1", candidates: null }), reason: "SPEECH_MALFORMED_SEMANTIC_RESPONSE" },
    { responseText: JSON.stringify({ sourceId: "source-1", momentId: "wrong", candidates: [] }), reason: "SPEECH_MALFORMED_SEMANTIC_RESPONSE" }
  ];
  for (const { responseText, reason } of invalid) {
    await withGeminiKey(() => assertSpokenRejection(() => createAiEditPlan({
      prompt: "Use the part where I explain pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
      aiClient: createMockGemini({ responses: [responseText], transcriptionInteractions: [interaction(words)] }), scratchDirectory: "/scratch",
      transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
    }), reason));
  }
});

test("semantic matching retries transient calls without retranscribing and derives boundary modes", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [
    { text: "Pricing.", start_offset: "2s", end_offset: "2.5s" },
    { text: "Integrations.", start_offset: "5s", end_offset: "5.5s" }
  ];
  const busy = Object.assign(new Error("busy"), { status: 429 });
  const retrying = createMockGemini({ failures: [busy, busy], responses: [undefined, undefined,
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] }] })
  ], transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Start when I begin talking about pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: retrying,
    retryOptions: { sleepFn: async () => {} }, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", start: 2, end: 20 }]);
  assert.equal(retrying.interactionRequests.length, 1);
  const ending = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-2", endSegmentId: "source-1-seg-2" }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] }] })
  ], transcriptionInteractions: [interaction(words)] });
  const endResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "End when I start talking about integrations.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: ending,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(endResult.plan.operations[0].clips, [{ sourceId: "source-1", start: 0, end: 5.5 }]);
});

test("semantic matcher retry and failure matrix preserves its one canonical transcript", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [{ text: "Pricing.", start_offset: "1s", end_offset: "1.5s" }];
  const run = ({ failures = [], responses = [] }) => {
    const aiClient = createMockGemini({ failures, responses, transcriptionInteractions: [interaction(words)] });
    return { aiClient, promise: withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, retryOptions: { sleepFn: async () => {} }, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } })) };
  };
  for (const transient of [429, 503]) {
    const error = Object.assign(new Error("busy"), { status: transient });
    const { aiClient, promise } = run({ failures: [error], responses: [undefined, semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]), JSON.stringify(fullSequence(catalog))] });
    await promise;
    assert.equal(aiClient.interactionRequests.length, 1);
    assert.equal(aiClient.requests.length, 3);
  }
  const exhausted = run({ failures: [503, 503, 503].map((status) => Object.assign(new Error("busy"), { status })) });
  await assert.rejects(exhausted.promise, UnsupportedEditRequestError);
  assert.equal(exhausted.aiClient.interactionRequests.length, 1); assert.equal(exhausted.aiClient.requests.length, 3);
  const nonTransient = run({ failures: [Object.assign(new Error("bad"), { status: 400 })] });
  await assert.rejects(nonTransient.promise, UnsupportedEditRequestError);
  assert.equal(nonTransient.aiClient.interactionRequests.length, 1); assert.equal(nonTransient.aiClient.requests.length, 1);
  const malformed = run({ responses: ["not-json"] });
  await assert.rejects(malformed.promise, UnsupportedEditRequestError);
  assert.equal(malformed.aiClient.interactionRequests.length, 1); assert.equal(malformed.aiClient.requests.length, 1);
});

test("ordinary visual moments remain on the visual path without speech transcription", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 3, end: 7 }]),
    JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 3, end: 7 }] }] })
  ] });
  assert.equal(requiresSpokenMomentUnderstanding("Use the part where the car enters the frame.", catalog), false);
  assert.ok(requiresVisualMomentUnderstanding("Use the part where the car enters the frame.", catalog));
  await withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where the car enters the frame.", sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }));
  assert.equal(aiClient.interactionRequests.length, 0);
});

test("exact spoken modes create server-authoritative V2 ranges without visual localization", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const cases = [
    ['Use the part where she says "Welcome to Kerala".', { start: 1, end: 1.9 }],
    ['Start when I say "Welcome to Kerala".', { start: 1, end: 20 }],
    ['End after he says "Cliponaut".', { start: 0, end: 6.3 }],
    ['Start when I say "Welcome to Kerala" and end when I say "Cliponaut".', { start: 1, end: 6.3 }]
  ];
  for (const [prompt, range] of cases) {
    const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] }), transcriptionInteractions: [interaction(transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` })))] });
    const result = await withGeminiKey(() => createAiEditPlan({ prompt, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
    assert.deepEqual(result.plan.operations[0], { type: "sequence", clips: [{ sourceId: "source-1", ...range }] });
    assert.deepEqual(result.plan.operations[1], { type: "color_grade", style: "bw" });
    assert.equal(aiClient.requests.length, 1);
  }
});

test("exact spoken orchestration keeps a unique phrase boundary when later words continue", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const words = [
    { text: "Hello", start_offset: "0.2s", end_offset: "0.5s" }, { text: "team", start_offset: "0.5s", end_offset: "0.8s" }, { text: "TechStars", start_offset: "0.8s", end_offset: "1.3s" },
    { text: "I", start_offset: "1.3s", end_offset: "1.4s" }, { text: "am", start_offset: "1.4s", end_offset: "1.6s" }, { text: "Mohammed.", start_offset: "1.6s", end_offset: "2.1s" }
  ];
  const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [] }), transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Hello, team TechStars".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0.2, end: 1.3 }] }]);
});

test("exact spoken START boundary handles contraction-expanded phrases once", async () => {
  const catalog = speechCatalog([{ ...sourceCatalog[0], duration: 10.625 }]);
  const words = [
    { text: "I'm", start_offset: "1.1s", end_offset: "1.4s" }, { text: "a", start_offset: "1.4s", end_offset: "1.5s" }, { text: "solo", start_offset: "1.5s", end_offset: "1.9s" }, { text: "founder", start_offset: "1.9s", end_offset: "2.4s" },
    { text: "building", start_offset: "2.4s", end_offset: "2.8s" }, { text: "Cliponaut.", start_offset: "2.8s", end_offset: "3.4s" }
  ];
  const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [] }), transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Start when I say "I\'m a solo founder".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 1.1, end: 10.625 }] }]);
});

test("Stage 3 preserves Cliponaut normalization and global B&W beside the authoritative spoken range", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({
    responseText: JSON.stringify({ version: "2", operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 20 }] },
      { type: "color_grade", style: "bw" }
    ] }),
    transcriptionInteractions: [interaction(transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` })))]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Cliponaut" and make it black and white.', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 5.5, end: 6.3 }] },
    { type: "color_grade", style: "bw" }
  ]);
});

test("spoken exact matching preserves normalization, ambiguity, source scoping, and final-plan protection", async () => {
  const catalog = speechCatalog(sourceCatalog);
  const words = transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` }));
  const explicit = createMockGemini({ responseText: JSON.stringify(fullSequence(catalog)), transcriptionInteractions: [interaction(words)] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: 'From video 2, use the part where I say "$12".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: explicit, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(explicit.uploads.filter((file) => file.uri.includes("speech.m4a")).map((file) => file.uri), ["gemini:///scratch/source-2-speech.m4a"]);
  assert.equal(result.plan.operations[0].clips[0].sourceId, "source-2");
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: createMockGemini(), scratchDirectory: "/scratch" }),
    UnsupportedEditRequestError
  ));
  const repeated = [...words, { text: "Welcome", start_offset: "7s", end_offset: "7.3s" }];
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', sourceCatalog: speechCatalog([sourceCatalog[0]]), sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: createMockGemini({ transcriptionInteractions: [interaction(repeated)] }), scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }),
    UnsupportedEditRequestError
  ));
});

test("final planner timestamps never replace a resolved spoken range", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({
    responseText: JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 9, end: 15 }] }] }),
    transcriptionInteractions: [interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.4s" }])]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [{ type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 1.4 }] }]);
});

test("semantic video scope resolves before transcribing only the resolved spoken source", async () => {
  const catalog = speechCatalog(sourceCatalog);
  const words = transcriptWords.map((word) => ({ text: word.text, start_offset: `${word.start}s`, end_offset: `${word.end}s` }));
  const aiClient = createMockGemini({
    responses: [
      classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
      classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
      classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: false }]),
      JSON.stringify(fullSequence(catalog))
    ],
    transcriptionInteractions: [interaction(words)]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'From the talking clip, use the part where I say "Welcome to Kerala".', hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.equal(aiClient.uploads.filter((file) => file.uri.includes("speech.m4a")).length, 1);
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 1, end: 1.9 }]);
});

test("unscoped exact speech aggregates every source without upload-order selection", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const onlySecond = createMockGemini({
    responseText: JSON.stringify(fullSequence(catalog)),
    transcriptionInteractions: [
      interaction([{ text: "Other.", start_offset: "1s", end_offset: "1.2s" }]),
      interaction([{ text: "Welcome", start_offset: "2s", end_offset: "2.4s" }])
    ]
  });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: onlySecond, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 2, end: 2.4 }]);
  assert.equal(onlySecond.interactionRequests.length, 2);
  const ambiguous = createMockGemini({ transcriptionInteractions: [
    interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.2s" }]),
    interaction([{ text: "Welcome", start_offset: "2s", end_offset: "2.2s" }])
  ] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: ambiguous, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }), UnsupportedEditRequestError));
});

test("unscoped semantic speech matches one transcript per source and aggregates safely", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const pricing = [{ text: "Pricing.", start_offset: "2s", end_offset: "2.5s" }];
  const unique = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", []),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }]),
    JSON.stringify(fullSequence(catalog))
  ], transcriptionInteractions: [interaction([{ text: "Other.", start_offset: "1s", end_offset: "1.2s" }]), interaction(pricing)] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: unique, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 2, end: 2.5 }]);
  assert.equal(unique.interactionRequests.length, 2);
  const matcherPrompts = unique.requests.slice(0, 2).map((request) => request.contents);
  assert.match(matcherPrompts[0], /source-1-seg-1/); assert.doesNotMatch(matcherPrompts[0], /source-2-seg-1/);
  assert.match(matcherPrompts[1], /source-2-seg-1/); assert.doesNotMatch(matcherPrompts[1], /source-1-seg-1/);
  const ambiguous = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-1", endSegmentId: "source-1-seg-1" }]),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }])
  ], transcriptionInteractions: [interaction(pricing), interaction(pricing)] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: ambiguous, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }), UnsupportedEditRequestError));
  const noMatch = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", []),
    semanticTranscriptResponse("source-2", [])
  ], transcriptionInteractions: [interaction(pricing), interaction(pricing)] });
  await withGeminiKey(() => assertSpokenRejection(() => createAiEditPlan({
    prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: noMatch,
    scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), "SPEECH_NO_CANDIDATE"));
});

test("unscoped speech no-match and silent sources contribute zero candidates", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const noneExact = createMockGemini({ transcriptionInteractions: [
    interaction([{ text: "Other.", start_offset: "1s", end_offset: "1.2s" }]),
    interaction([{ text: "Else.", start_offset: "2s", end_offset: "2.2s" }])
  ] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt: 'Use the part where I say "Welcome".', hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: noneExact, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }), UnsupportedEditRequestError));
  const emptyThenUnique = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", []),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }]),
    JSON.stringify(fullSequence(catalog))
  ], transcriptionInteractions: [{ steps: [] }, interaction([{ text: "Pricing.", start_offset: "3s", end_offset: "3.5s" }])] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt: "Use the part where I explain pricing.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: emptyThenUnique, scratchDirectory: "/scratch", transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} } }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 3, end: 3.5 }]);
});

test("spoken no-match, paired ambiguity, and final source mismatch reject safely", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const make = (words, responseText = JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })) => createAiEditPlan({
    prompt: 'Use the part where I say "Missing".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
    aiClient: createMockGemini({ responseText, transcriptionInteractions: [interaction(words)] }), scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  });
  await withGeminiKey(() => assert.rejects(() => make([{ text: "Other", start_offset: "1s", end_offset: "1.2s" }]), UnsupportedEditRequestError));
  const repeatedPairs = [
    { text: "Welcome", start_offset: "1s", end_offset: "1.2s" }, { text: "Thanks", start_offset: "2s", end_offset: "2.2s" },
    { text: "Welcome", start_offset: "3s", end_offset: "3.2s" }, { text: "Thanks", start_offset: "4s", end_offset: "4.2s" }
  ];
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: 'Start when I say "Welcome" and end when I say "Thanks".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
    aiClient: createMockGemini({ transcriptionInteractions: [interaction(repeatedPairs)] }), scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), UnsupportedEditRequestError));
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog), scratchDirectory: "/scratch",
    aiClient: createMockGemini({ responseText: JSON.stringify({ version: "2", operations: [{ type: "color_grade", sourceId: "source-2", style: "bw" }] }), transcriptionInteractions: [interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.2s" }])] }),
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }), UnsupportedEditRequestError));
});

test("a source without an audio stream rejects speech selection without transcription", async () => {
  const catalog = [{ ...sourceCatalog[0], hasAudio: false }];
  const aiClient = createMockGemini();
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome".', sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
    aiClient, scratchDirectory: "/scratch"
  }), UnsupportedEditRequestError));
  assert.equal(aiClient.uploads.filter((file) => file.uri.includes("speech.m4a")).length, 0);
});

test("spoken transcription annotations parse Gemini word_info offsets without assigning IDs", () => {
  assert.deepEqual(wordAnnotations({ steps: [{ content: [{ annotations: [{ type: "word_info", text: "Welcome", start_offset: "0.8s", end_offset: "1.2s" }, { type: "other", text: "ignored" }] }] }] }), [{ text: "Welcome", start: 0.8, end: 1.2 }]);
});

test("speech extraction uses only a caller scratch M4A with exact-child ownership", async () => {
  const calls = []; const child = createMockChild(); child.stderr = new EventEmitter();
  const controller = createExecutionController();
  const pending = extractSpeechAudio({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", executionController: controller, spawn: (command, args) => { calls.push({ command, args }); return child; } });
  assert.equal(calls[0].command, "ffmpeg"); assert.deepEqual(calls[0].args.slice(6, 15), ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k"]);
  controller.cancel(); assert.deepEqual(child.signals, ["SIGTERM"]); child.emit("close", null, "SIGTERM");
  await assert.rejects(pending, EditExecutionCancelledError);
});

test("isolated transcription creates canonical server segments and cleans local/Gemini files", async () => {
  const spawns = []; const ai = transcriptionMock({ interactions: [interaction()] }); const removed = [];
  const result = await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn(spawns), remove: async (file) => removed.push(file) });
  assert.equal(spawns.length, 1); assert.equal(ai.calls.uploads.length, 1); assert.equal(ai.calls.interactions.length, 1); assert.equal(ai.calls.interactions[0].model, "gemini-3.5-transcribe");
  assert.equal(result.segments[0].segmentId, "source-1-seg-1"); assert.deepEqual(result.segments[0].words[0], { text: "Hello", start: 1, end: 1.4 });
  assert.equal(ai.calls.deletes.length, 1); assert.deepEqual(removed, ["/scratch/source-1-speech.m4a"]);
});

test("transcription retries only interactions and maps validation/request failures without masking cleanup", async () => {
  const transient = Object.assign(new Error("busy"), { status: 503 }); const ai = transcriptionMock({ interactions: [transient, transient, interaction()] }); const spawns = []; const removed = [];
  await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn(spawns), sleep: async () => {}, remove: async (file) => removed.push(file) });
  assert.equal(spawns.length, 1); assert.equal(ai.calls.uploads.length, 1); assert.equal(ai.calls.interactions.length, 3); assert.equal(ai.calls.deletes.length, 1); assert.equal(removed.length, 1);
  const badAi = transcriptionMock({ interactions: [interaction([{ text: "Bad", start_offset: "wat", end_offset: "2s" }])], deleteError: new Error("cleanup") });
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: badAi, spawn: successfulSpawn(), remove: async () => { throw new Error("cleanup"); } }), (error) => error.reason === "SPEECH_INVALID_WORD_TIMESTAMPS");
  const nonTransient = transcriptionMock({ interactions: [Object.assign(new Error("bad"), { status: 400 })] });
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: nonTransient, spawn: successfulSpawn() }), (error) => error.reason === "SPEECH_TRANSCRIPTION_REQUEST_FAILED");
  assert.equal(nonTransient.calls.interactions.length, 1);
});

test("Stage 2 retries 429s once per interaction and exhausts without re-uploading", async () => {
  const busy = Object.assign(new Error("busy"), { status: 429 }); const ai = transcriptionMock({ interactions: [busy, interaction()] }); const spawns = [];
  await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn(spawns), sleep: async () => {} });
  assert.equal(spawns.length, 1); assert.equal(ai.calls.uploads.length, 1); assert.equal(ai.calls.interactions.length, 2);
  const exhausted = transcriptionMock({ interactions: [busy, busy, busy] }); const exhaustedSpawns = [];
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: exhausted, spawn: successfulSpawn(exhaustedSpawns), sleep: async () => {} }), (error) => error.reason === "SPEECH_TRANSCRIPTION_RETRIES_EXHAUSTED");
  assert.equal(exhaustedSpawns.length, 1); assert.equal(exhausted.calls.uploads.length, 1); assert.equal(exhausted.calls.interactions.length, 3); assert.equal(exhausted.calls.deletes.length, 1);
});

test("Stage 2 cleans extraction/upload/request paths and preserves empty transcripts", async () => {
  const removed = []; const uploadFailure = transcriptionMock({ uploadError: new Error("upload") });
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: uploadFailure, spawn: successfulSpawn(), remove: async (file) => removed.push(file) }));
  assert.equal(uploadFailure.calls.deletes.length, 0); assert.equal(removed.length, 1);
  const requestFailure = transcriptionMock({ interactions: [Object.assign(new Error("bad"), { status: 400 })] }); const requestRemoved = [];
  await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: requestFailure, spawn: successfulSpawn(), remove: async (file) => requestRemoved.push(file) }));
  assert.equal(requestFailure.calls.deletes.length, 1); assert.equal(requestRemoved.length, 1);
  const silent = transcriptionMock({ interactions: [{ steps: [] }], deleteError: new Error("cleanup") }); const result = await transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: silent, spawn: successfulSpawn(), remove: async () => { throw new Error("cleanup"); } });
  assert.deepEqual(result, { sourceId: "source-1", segments: [] });
});

test("Stage 2 maps every malformed word shape without retrying", async () => {
  const invalid = [
    [{ text: "", start_offset: "1s", end_offset: "2s" }], [{ text: "x", start_offset: "NaNs", end_offset: "2s" }],
    [{ text: "x", start_offset: "-1s", end_offset: "2s" }], [{ text: "x", start_offset: "3s", end_offset: "2s" }],
    [{ text: "x", start_offset: "1s", end_offset: "9s" }], [{ text: "a", start_offset: "2s", end_offset: "3s" }, { text: "b", start_offset: "1s", end_offset: "2s" }]
  ];
  for (const words of invalid) {
    const ai = transcriptionMock({ interactions: [interaction(words)] });
    await assert.rejects(() => transcribeSource({ inputPath: "/source.mp4", scratchDirectory: "/scratch", sourceId: "source-1", duration: 5, aiClient: ai, spawn: successfulSpawn() }), (error) => error.reason === "SPEECH_INVALID_WORD_TIMESTAMPS");
    assert.equal(ai.calls.interactions.length, 1); assert.equal(ai.calls.deletes.length, 1);
  }
});

test("direct-upload manifest accepts five bounded video files", () => {
  assert.equal(validateUploadManifest(Array.from({ length: 5 }, (_, index) => ({ ...video, name: `${index}.mp4` }))), 5120);
});

test("direct-upload manifest rejects over-limit source files", () => {
  assert.throws(() => validateUploadManifest([{ ...video, size: MAX_DIRECT_UPLOAD_FILE_BYTES + 1 }]), /5 GB/);
});

test("job request needs a prompt and a supported export quality", () => {
  assert.throws(() => validateJobRequest({ prompt: "", exportQuality: "standard", sources: [video] }), /Describe/);
  assert.throws(() => validateJobRequest({ prompt: "Black and white", exportQuality: "8k", sources: [video] }), /exportQuality/);
});

test("same-orientation mixed sources fill the common canvas", () => {
  const profile = createMediaProfile({ media: [{ width: 3840, height: 2160 }, { width: 1280, height: 720 }], exportQuality: "standard" });
  assert.match(buildNormalizationFilter(profile, { width: 1280, height: 720 }), /force_original_aspect_ratio=increase,crop=/);
});

test("direct upload CORS permits only Cliponaut and local development", () => {
  const [rule] = DIRECT_UPLOAD_CORS.CORSRules;
  assert.deepEqual(rule.AllowedOrigins, ["https://cliponaut.com", "http://localhost:3000"]);
  assert.deepEqual(rule.AllowedMethods, ["GET", "HEAD", "PUT"]);
  assert.deepEqual(rule.ExposeHeaders, ["ETag"]);
});

test("direct multipart part uploads retry only transient failures", async () => {
  const delays = [];
  const outcomes = [new TypeError("network unavailable"), new Response(null, { status: 503 }), new Response(null, { status: 200, headers: { etag: '"part-1"' } })];
  const eTag = await uploadPartWithRetry({
    url: "https://storage.example/signed-part", chunk: new Blob(["part"]),
    fetchFn: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    sleepFn: async (delay) => { delays.push(delay); }
  });
  assert.equal(eTag, '"part-1"');
  assert.deepEqual(delays, [500, 1_000]);

  let calls = 0;
  await assert.rejects(() => uploadPartWithRetry({
    url: "https://storage.example/signed-part", chunk: new Blob(["part"]),
    fetchFn: async () => { calls += 1; return new Response(null, { status: 503 }); }, sleepFn: async () => {}
  }), (error) => error instanceof PartUploadError && error.kind === "http" && error.status === 503);
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(() => uploadPartWithRetry({
    url: "https://storage.example/signed-part", chunk: new Blob(["part"]),
    fetchFn: async () => { calls += 1; return new Response(null, { status: 403 }); }, sleepFn: async () => {}
  }), (error) => error instanceof PartUploadError && error.status === 403);
  assert.equal(calls, 1);
});

test("direct multipart retry observes cancellation and counts progress only after one successful part", async () => {
  const controller = new AbortController();
  let calls = 0;
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => uploadPartWithRetry({
    url: "https://storage.example/signed-part", chunk: new Blob(["part"]), signal: controller.signal,
    fetchFn: async () => { calls += 1; return new Response(null, { status: 429 }); }
  }), (error) => error.name === "AbortError");
  assert.ok(Date.now() - startedAt < 200, "cancellation must interrupt the 500ms retry wait");
  assert.equal(calls, 1);

  const progress = [];
  let signedAttempts = 0;
  const file = {
    name: "source.mp4", size: 4, type: "video/mp4",
    slice: () => new Blob([new Uint8Array([1, 2, 3, 4])])
  };
  const result = await uploadAndQueueJob({
    videos: [file], prompt: "Mute the video.", exportQuality: "standard",
    onProgress: (value) => progress.push(value),
    sleepFn: async () => {},
    fetchFn: async (url) => {
      if (url === "/api/uploads") return Response.json({ id: "job-1", accessToken: "opaque-token", partSize: 5, uploads: [{ index: 0, key: "private-key", uploadId: "upload-1" }] });
      if (url === "/api/uploads/job-1/parts") return Response.json({ parts: [{ partNumber: 1, url: "https://storage.example/signed-part" }] });
      if (url === "https://storage.example/signed-part") {
        signedAttempts += 1;
        return signedAttempts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 200, headers: { etag: '"part-1"' } });
      }
      if (url === "/api/uploads/job-1/complete") return Response.json({ id: "job-1", status: "queued" });
      throw new Error(`Unexpected request: ${url}`);
    }
  });
  assert.equal(result.status, "queued");
  assert.equal(signedAttempts, 2);
  assert.deepEqual(progress, [{ uploadedBytes: 4, totalBytes: 4 }]);
});

test("RV-0 client upload keeps explicit video reference routing separate and aborts interrupted attachments", async () => {
  const source = { name: "creator.mp4", size: 4, type: "video/mp4", slice: () => new Blob([new Uint8Array([1, 2, 3, 4])]) };
  const reference = { name: "inspiration.mp4", size: 3, type: "video/mp4", slice: () => new Blob([new Uint8Array([5, 6, 7])]) };
  await assert.rejects(() => uploadAndQueueJob({ videos: [source], referenceImage: { ...reference, type: "image/jpeg" }, referenceAttachment: { kind: "video", file: reference }, prompt: "Match this reference.", exportQuality: "standard", fetchFn: async () => { throw new Error("must not upload"); } }), /one style reference/);

  const requests = [];
  const queued = await uploadAndQueueJob({
    videos: [source], referenceAttachment: { kind: "video", file: reference }, prompt: "Match this reference.", exportQuality: "standard", sleepFn: async () => {},
    fetchFn: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/uploads") return Response.json({ id: "job-rv0", accessToken: "token", partSize: 8, uploads: [{ index: 0, key: "jobs/job-rv0/sources/0", uploadId: "source-upload" }], referenceUpload: { key: "jobs/job-rv0/reference/video", uploadId: "reference-upload" } });
      if (url === "/api/uploads/job-rv0/parts") {
        const body = JSON.parse(options.body);
        return Response.json({ parts: [{ partNumber: 1, url: body.kind === "reference" ? "https://storage.example/reference" : "https://storage.example/source" }] });
      }
      if (url.startsWith("https://storage.example/")) return new Response(null, { status: 200, headers: { etag: '"part"' } });
      if (url === "/api/uploads/job-rv0/complete") return Response.json({ id: "job-rv0", status: "queued" });
      throw new Error(`Unexpected ${url}`);
    }
  });
  assert.equal(queued.status, "queued");
  assert.deepEqual(JSON.parse(requests[0].options.body).reference, { kind: "video", name: "inspiration.mp4", size: 3, type: "video/mp4" });
  assert.ok(requests.some(({ url, options }) => url.endsWith("/parts") && JSON.parse(options.body).kind === "reference"), "reference parts use the isolated server route");

  const aborted = [];
  await assert.rejects(() => uploadAndQueueJob({
    videos: [source], referenceAttachment: { kind: "video", file: reference }, prompt: "Match this reference.", exportQuality: "standard", sleepFn: async () => {},
    fetchFn: async (url, options = {}) => {
      if (url === "/api/uploads") return Response.json({ id: "job-abort", accessToken: "token", partSize: 8, uploads: [{ index: 0, key: "source", uploadId: "source-upload" }], referenceUpload: { key: "reference", uploadId: "reference-upload" } });
      if (url === "/api/uploads/job-abort/parts") {
        const body = JSON.parse(options.body);
        return Response.json({ parts: [{ partNumber: 1, url: body.kind === "reference" ? "https://storage.example/fail-reference" : "https://storage.example/source-ok" }] });
      }
      if (url === "https://storage.example/source-ok") return new Response(null, { status: 200, headers: { etag: '"part"' } });
      if (url === "https://storage.example/fail-reference") return new Response(null, { status: 403 });
      if (url === "/api/uploads/job-abort/abort") { aborted.push(options); return Response.json({ status: "failed" }); }
      throw new Error(`Unexpected ${url}`);
    }
  }), PartUploadError);
  assert.equal(aborted.length, 1, "an interrupted reference upload invokes existing job abort cleanup");
});

test("single-step Undo state migrates legacy sessions and retains only current and previous successful states", () => {
  const values = new Map([["cliponaut-active-job", JSON.stringify({ id: "legacy-job", accessToken: "legacy-token" })]]);
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const sources = [{ index: 1, name: "second.mp4", type: "video/mp4", size: 20 }, { index: 0, name: "first.mp4", type: "video/mp4", size: 10, key: "must-not-persist" }];
  const legacy = loadUndoState(storage);
  assert.deepEqual(legacy, { version: UNDO_STATE_VERSION, active: { id: "legacy-job", accessToken: "legacy-token" }, current: null, previous: null, terminal: null });
  assert.deepEqual(JSON.parse(values.get("cliponaut-active-job")), legacy);
  values.set("cliponaut-active-job", JSON.stringify({ version: UNDO_STATE_VERSION, active: null, current: { kind: "job", session: { id: "job-without-token" }, sources }, previous: null }));
  assert.equal(loadUndoState(storage).current, null, "historical results require the matching access token");

  const sessionA = { id: "job-a", accessToken: "token-a" };
  const sessionB = { id: "job-b", accessToken: "token-b" };
  const sessionC = { id: "job-c", accessToken: "token-c" };
  const sessionD = { id: "job-d", accessToken: "token-d" };
  let state = promoteSuccessfulJob(setUndoActiveJob(emptyUndoState(), sessionA, "Make it brighter."), sessionA, sources);
  assert.deepEqual(state.current.session, sessionA);
  assert.equal(state.current.prompt, "Make it brighter.");
  assert.deepEqual(state.previous, { kind: "original", sources: [{ index: 0, name: "first.mp4", type: "video/mp4", size: 10 }, { index: 1, name: "second.mp4", type: "video/mp4", size: 20 }] });

  state = promoteSuccessfulJob(setUndoActiveJob(state, sessionB, "Make it warmer."), sessionB, sources);
  assert.deepEqual(state.current.session, sessionB);
  assert.deepEqual(state.previous.session, sessionA);
  assert.equal(state.previous.prompt, "Make it brighter.");
  state = promoteSuccessfulJob(setUndoActiveJob(state, sessionC, "Make it black and white."), sessionC, sources);
  assert.deepEqual(state.current.session, sessionC);
  assert.deepEqual(state.previous.session, sessionB);
  assert.equal(Object.hasOwn(state, "history"), false);
  assert.equal(Array.isArray(state.current), false);
  assert.equal(Array.isArray(state.previous), false);

  const afterUndo = consumeUndo(state);
  assert.deepEqual(afterUndo.current.session, sessionB);
  assert.equal(afterUndo.previous, null);
  const afterNewSuccess = promoteSuccessfulJob(setUndoActiveJob(afterUndo, sessionD), sessionD, sources);
  assert.deepEqual(afterNewSuccess.current.session, sessionD);
  assert.deepEqual(afterNewSuccess.previous.session, sessionB);
  assert.deepEqual(discardUndoActiveJob(setUndoActiveJob(afterNewSuccess, { id: "failed", accessToken: "failed-token" })), { ...afterNewSuccess, active: null }, "failed active jobs preserve current and previous");
  assert.deepEqual(discardUndoActiveJob(setUndoActiveJob(afterNewSuccess, { id: "cancelled", accessToken: "cancelled-token" })), { ...afterNewSuccess, active: null }, "cancelled active jobs preserve current and previous");
  assert.deepEqual(invalidateUndoPrevious(afterNewSuccess), { ...afterNewSuccess, previous: null });

  const originalUndo = consumeUndo(state = { ...emptyUndoState(), current: { kind: "job", session: sessionA, sources: [] }, previous: { kind: "original", sources } });
  assert.equal(originalUndo.current.kind, "original");
  assert.equal(originalUndo.previous, null);
  assert.deepEqual(saveUndoState(afterNewSuccess, storage), afterNewSuccess);
});

test("single-step Undo only invalidates a previous job after a confirmed unavailable completed response", () => {
  const current = { kind: "job", session: { id: "job-b", accessToken: "token-b" }, sources: [] };
  const previous = { kind: "job", session: { id: "job-a", accessToken: "token-a" }, sources: [] };
  const state = { ...emptyUndoState(), current, previous };

  const restored = resolveUndoRestoration(state, { status: "completed", outputUrl: "https://signed.example/output.mp4" });
  assert.equal(restored.outcome, "restored");
  assert.deepEqual(restored.state.current, previous);
  assert.equal(restored.state.previous, null);

  const unavailable = resolveUndoRestoration(state, { status: "completed", outputUrl: null });
  assert.equal(unavailable.outcome, "unavailable");
  assert.deepEqual(unavailable.state.current, current);
  assert.equal(unavailable.state.previous, null);

  const retry = resolveUndoRestoration(state, { status: "rendering" });
  assert.equal(retry.outcome, "retry");
  assert.deepEqual(retry.state, state, "temporary or unexpected retrieval results retain the previous undo target");
});

test("terminal attempts clear stale output presentation without consuming Undo history", () => {
  const sessionA = { id: "job-a", accessToken: "token-a" };
  const sessionB = { id: "job-b", accessToken: "token-b" };
  const sources = [{ index: 0, name: "source.mp4", type: "video/mp4", size: 10 }];
  const successfulA = promoteSuccessfulJob(setUndoActiveJob(emptyUndoState(), sessionA, "Make it warmer."), sessionA, sources);
  const duringB = setUndoActiveJob(successfulA, sessionB, "Make it brighter.");
  const afterBFailure = discardUndoActiveJob(duringB);

  assert.deepEqual(afterBFailure.current, successfulA.current, "the prior result remains an explicit recovery target");
  assert.deepEqual(afterBFailure.previous, successfulA.previous, "failure does not consume a valid Undo target");
  assert.deepEqual(terminalAttemptPresentation({ status: "failed", error: "Rendering failed." }), {
    status: "error", resultUrl: null, error: "Rendering failed."
  }, "a failed current job cannot present an old MP4 as Ready");
  assert.deepEqual(terminalAttemptPresentation({ status: "cancelled" }), {
    status: "error", resultUrl: null, error: "This edit was cancelled."
  }, "a cancelled current job cannot present an old MP4 as Ready");

  const terminal = recordTerminalJob(duringB, sessionB, { status: "failed", error: "Rendering failed.", sources });
  assert.deepEqual(terminal.terminal, {
    session: sessionB, status: "failed", error: "Rendering failed.", sources
  }, "an authoritative terminal job survives refresh without altering successful history");
  assert.equal(clearTerminalJob(terminal).terminal, null, "explicitly restoring the previous result clears only terminal presentation state");
});

test("client presentation generation rejects late polling and restoration responses", () => {
  assert.equal(isCurrentPresentationAttempt(7, 7), true);
  assert.equal(isCurrentPresentationAttempt(6, 7), false, "a late A/B response cannot overwrite generation C");
  assert.equal(isCurrentPresentationAttempt(null, 7), false);
});

test("single-step Undo remains visible for a restored Original workspace without showing result actions", () => {
  assert.equal(shouldShowUndoControl({ current: { kind: "job" } }), true, "completed workspaces keep one stable Undo location");
  assert.equal(shouldShowUndoControl({ current: { kind: "original" } }), true, "restored Original keeps its disabled Undo visible");
  assert.equal(shouldShowUndoControl({ current: null }), false, "the fresh empty editor does not gain an Undo control");
  assert.equal(undoPreviewMode({ isRestoring: true, current: { kind: "job" }, localVideoCount: 1 }), "restoring", "authorized restoration masks the current result immediately");
  assert.equal(undoPreviewMode({ isRestoring: false, current: { kind: "original" }, localVideoCount: 1 }), "original-source", "one restored local source previews directly");
  assert.equal(undoPreviewMode({ isRestoring: false, current: { kind: "original" }, localVideoCount: 2 }), "normal", "multiple originals do not fabricate a merged preview");
});

test("Undo waits for two browser paint frames before beginning restoration work", async () => {
  const frames = [];
  let restorationStarted = false;
  const paint = waitForBrowserPaint((callback) => frames.push(callback));
  const afterPaint = paint.then(() => { restorationStarted = true; });

  assert.equal(restorationStarted, false);
  assert.equal(frames.length, 1, "the first RAF is scheduled immediately after the restoring commit");
  frames.shift()();
  assert.equal(restorationStarted, false);
  assert.equal(frames.length, 1, "a second RAF gives the browser a paint opportunity before restoration starts");
  frames.shift()();
  await afterPaint;
  assert.equal(restorationStarted, true);
});

test("Undo original restoration requires both paint barriers and ignores duplicate media-ready events", () => {
  const beforeMount = { isRestoring: true, restoringOriginal: true, originalPreviewArmed: false };
  const mediaReady = { isRestoring: true, restoringOriginal: true, originalPreviewArmed: true };
  const revealReady = { ...mediaReady, originalReadyForReveal: true };
  assert.equal(undoMediaReadyAction(beforeMount), "ignore", "an immediate local Blob event is ignored before the pre-mount cover paint");
  assert.equal(undoMediaReadyAction(mediaReady), "wait-for-reveal-paint", "media-ready alone keeps the original beneath the cover");
  assert.equal(canCompleteUndoMediaRestoration(mediaReady), false);
  assert.equal(shouldScheduleUndoOriginalReveal(mediaReady), true, "the first media-ready event schedules exactly one reveal barrier");
  assert.equal(shouldScheduleUndoOriginalReveal(mediaReady, true), false, "duplicate media-ready events cannot schedule a second completion");
  assert.equal(undoMediaReadyAction(revealReady), "complete", "only the post-ready paint barrier allows reveal");
  assert.equal(canCompleteUndoMediaRestoration(revealReady), true);
  assert.equal(undoMediaReadyAction({ isRestoring: true, restoringOriginal: false, originalPreviewArmed: false }), "complete", "previous-job restoration remains media-ready driven");
  assert.equal(undoMediaReadyAction({ isRestoring: false, restoringOriginal: true, originalPreviewArmed: true }), "ignore");
});

test("single-step Undo records concise prompt context without altering restoration state", () => {
  const original = { kind: "original", sources: [{ index: 0, name: "source.mp4", type: "video/mp4", size: 10 }] };
  const current = { kind: "job", prompt: "Make it 20% brighter.", sources: [] };
  const previous = { kind: "job", prompt: "Make it warmer", sources: [] };
  assert.equal(describeUndoRestoration({ current, previous: original }), "Restored your original upload. Undid: “Make it 20% brighter.”");
  assert.equal(describeUndoRestoration({ current, previous }), "Restored previous edit: “Make it warmer.” Undid: “Make it 20% brighter.”");
  assert.equal(describeUndoRestoration({ current, previous: null }), "Restored your previous edit. Undid: “Make it 20% brighter.”");
});

test("single-step Undo anchors to its successful user turn rather than failed or duplicate prompts", () => {
  const messages = [
    { role: "user", text: "Make it warmer.", jobId: "job-a" },
    { role: "assistant", text: "Your edit is ready." },
    { role: "user", text: "Make it warmer.", jobId: "failed-job" },
    { role: "assistant", text: "We couldn’t complete that edit." },
    { role: "user", text: "Make it warmer.", jobId: "job-b" },
  ];
  assert.equal(findUndoTurnIndex(messages, { jobId: "job-a", prompt: "Make it warmer." }), 0, "a later failed duplicate cannot steal Undo from the successful job");
  assert.equal(findUndoTurnIndex(messages, { jobId: "job-b", prompt: "Make it warmer." }), 4, "duplicate successful prompts use their matching latest turn");
  assert.equal(findUndoTurnIndex(messages, { prompt: "Make it warmer." }), 4, "refresh fallback uses the latest prompt when no in-memory job ID exists");
  assert.equal(findUndoTurnIndex(messages, { jobId: "missing", prompt: "Make it warmer." }), -1, "a known job ID never falls through to a potentially failed prompt");
  assert.equal(findUndoTurnIndex(messages, null), -1, "a missing Undo anchor is safe");
});

test("single-step Undo hydration reconstructs an anchor only while a previous version is available", () => {
  const current = {
    kind: "job",
    session: { id: "job-current", accessToken: "token-current" },
    sources: [{ index: 0, name: "clip.mp4", type: "video/mp4", size: 100 }],
    prompt: "Make it warmer.",
  };
  const previous = {
    kind: "job",
    session: { id: "job-previous", accessToken: "token-previous" },
    sources: [{ index: 0, name: "clip.mp4", type: "video/mp4", size: 100 }],
    prompt: "Make it brighter.",
  };

  assert.deepEqual(getInitialUndoAnchor({ ...emptyUndoState(), current, previous }), {
    jobId: "job-current",
    prompt: "Make it warmer.",
    consumed: false,
  });
  assert.equal(getInitialUndoAnchor({ ...emptyUndoState(), current, previous: null }), null);
});

test("restored source metadata preserves order without storage keys", () => {
  const sources = safeSourceMetadata([
    { index: 4, name: "fifth.mp4", type: "video/mp4", size: 500, key: "private/fifth" },
    { index: 1, name: "second.mp4", type: "video/mp4", size: 200, key: "private/second" },
    { index: 0, name: "first.mp4", type: "video/mp4", size: 100, key: "private/first" },
    { index: 3, name: "fourth.mp4", type: "video/mp4", size: 400, key: "private/fourth" },
    { index: 2, name: "third.mp4", type: "video/mp4", size: 300, key: "private/third" }
  ]);
  assert.deepEqual(sources, [
    { index: 0, name: "first.mp4", type: "video/mp4", size: 100 },
    { index: 1, name: "second.mp4", type: "video/mp4", size: 200 },
    { index: 2, name: "third.mp4", type: "video/mp4", size: 300 },
    { index: 3, name: "fourth.mp4", type: "video/mp4", size: 400 },
    { index: 4, name: "fifth.mp4", type: "video/mp4", size: 500 }
  ]);
});

test("cancelled is a terminal durable-job status and is eligible for source cleanup", () => {
  assert.ok(JOB_STATUSES.includes("cancelled"));
  assert.match(EDIT_JOBS_SCHEMA, /'cancelled'/);
  assert.match(EDIT_JOBS_SCHEMA, /'completed','failed','cancelled'/);
  assert.ok(!ACTIVE_JOB_STATUSES.includes("cancelled"));
});

test("only active and completed jobs trigger recovery", () => {
  for (const status of ["uploading", "queued", "analyzing", "rendering"]) {
    assert.equal(isActiveJobStatus(status), true);
    assert.equal(isRecoverableJobStatus(status), true);
  }
  assert.equal(isRecoverableJobStatus("completed"), true);
  for (const status of ["failed", "cancelled"]) {
    assert.equal(isActiveJobStatus(status), false);
    assert.equal(isRecoverableJobStatus(status), false);
  }
});

test("normal execution controller leaves its active child unchanged", () => {
  const controller = createExecutionController();
  const child = createMockChild();
  controller.attach(child);
  assert.equal(controller.isCancelled(), false);
  assert.doesNotThrow(() => controller.throwIfCancelled());
  assert.deepEqual(child.signals, []);
  controller.detach(child);
});

test("cancelling an active execution gracefully terminates only its child", () => {
  const timers = [];
  const controller = createExecutionController({
    setTimeoutFn: (callback) => { timers.push(callback); return callback; },
    clearTimeoutFn: () => {}
  });
  const child = createMockChild();
  controller.attach(child);

  assert.equal(controller.cancel(), true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.throws(() => controller.throwIfCancelled(), EditExecutionCancelledError);

  child.exitCode = 0;
  controller.detach(child);
  timers[0]();
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("a non-exiting cancelled execution receives one bounded force kill", () => {
  const timers = [];
  const controller = createExecutionController({
    setTimeoutFn: (callback) => { timers.push(callback); return callback; },
    clearTimeoutFn: () => {}
  });
  const child = createMockChild();
  controller.attach(child);

  controller.cancel();
  controller.cancel();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  timers[0]();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("a cancellation observed before execution starts prevents the next child from running", () => {
  const controller = createExecutionController({ setTimeoutFn: () => null });
  const child = createMockChild();
  controller.cancel();
  controller.attach(child);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(controller.cancel(), false);
});

test("source catalog has stable human-facing IDs at one, two, and five source scale", () => {
  assert.deepEqual(sourceCatalog.map(({ sourceId, ordinal, filename }) => ({ sourceId, ordinal, filename })), [
    { sourceId: "source-1", ordinal: 1, filename: "A.mp4" },
    { sourceId: "source-2", ordinal: 2, filename: "B.mp4" },
    { sourceId: "source-3", ordinal: 3, filename: "C.mp4" }
  ]);
  const one = createSourceCatalog([{ ...video, index: 0, name: "one.mp4" }], [{ duration: 10, width: 1920, height: 1080 }]);
  const two = createSourceCatalog(
    [{ ...video, index: 0, name: "one.mp4" }, { ...video, index: 1, name: "two.mp4" }],
    [{ duration: 10, width: 1920, height: 1080 }, { duration: 10, width: 1920, height: 1080 }]
  );
  assert.deepEqual(one.map((source) => source.sourceId), ["source-1"]);
  assert.deepEqual(two.map((source) => source.sourceId), ["source-1", "source-2"]);
  const five = createSourceCatalog(
    Array.from({ length: 5 }, (_, index) => ({ ...video, index, name: `${index}.mp4` })),
    Array.from({ length: 5 }, () => ({ duration: 10, width: 1920, height: 1080 }))
  );
  assert.equal(five[0].sourceId, "source-1");
  assert.equal(five[4].sourceId, "source-5");
});

test("source-aware fallback preserves requested two-source order", () => {
  const plan = createEditPlan({ prompt: "Put the second video first, then the first.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("source-aware fallback creates source-local trim clips", () => {
  const plan = createEditPlan({ prompt: "Use the first 5 seconds of video 1, followed by seconds 10-15 of video 2.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0].clips, [
    { sourceId: "source-1", start: 0, end: 5 },
    { sourceId: "source-2", start: 10, end: 15 }
  ]);
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("source-specific color grade is scoped before sequence assembly", () => {
  const plan = createEditPlan({ prompt: "Make only video 2 black and white.", hasMultipleVideos: true, sourceCatalog });
  assert.deepEqual(plan.operations[0], {
    type: "sequence",
    clips: [
      { sourceId: "source-1", start: 0, end: 20 },
      { sourceId: "source-2", start: 0, end: 30 },
      { sourceId: "source-3", start: 0, end: 40 }
    ]
  });
  assert.deepEqual(plan.operations[1], { type: "color_grade", sourceId: "source-2", style: "bw" });
  assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
});

test("global multi-video color grades remain a single unscoped operation", () => {
  for (const prompt of ["Make both videos black and white.", "Make all videos black and white."]) {
    assert.equal(requiresVisualSourceUnderstanding(prompt, sourceCatalog), false);
    const plan = createEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog });
    const colorGrades = plan.operations.filter((operation) => operation.type === "color_grade");
    assert.deepEqual(colorGrades, [{ type: "color_grade", style: "bw" }]);
    assert.doesNotThrow(() => validateEditPlan(plan, { sourceCatalog }));
  }
});

test("Gemini prompt distinguishes global and source-scoped color grades", () => {
  const prompt = buildAiEditorPrompt({ prompt: "Make both videos black and white.", hasMultipleVideos: true, sourceCatalog });
  assert.match(prompt, /exactly one color_grade operation per plan/);
  assert.match(prompt, /both, all, or every video, use one unscoped color_grade without sourceId/);
  assert.match(prompt, /never emit one color_grade per source/);
  assert.match(prompt, /Use sourceId only when the request explicitly limits the grade to one source/);
});

test("single-video black and white keeps the version 1 global color grade", () => {
  const plan = createEditPlan({ prompt: "Make this video black and white." });
  assert.deepEqual(plan, { version: "1", operations: [{ type: "color_grade", style: "bw" }] });
  assert.doesNotThrow(() => validateEditPlan(plan));
});

test("validator still rejects duplicate source color grades", () => {
  const twoSourceCatalog = sourceCatalog.slice(0, 2);
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: twoSourceCatalog.map((source) => ({ sourceId: source.sourceId, start: 0, end: source.duration })) },
    { type: "color_grade", sourceId: "source-1", style: "bw" },
    { type: "color_grade", sourceId: "source-2", style: "bw" }
  ] }, { sourceCatalog: twoSourceCatalog }), /only one color_grade operation is allowed/);
});

test("source-aware validation allows repeats but rejects bad sources and ranges", () => {
  const repeated = {
    version: "2", operations: [{ type: "sequence", clips: [
      { sourceId: "source-1", start: 0, end: 2 },
      { sourceId: "source-2", start: 0, end: 2 },
      { sourceId: "source-1", start: 2, end: 4 }
    ] }]
  };
  assert.doesNotThrow(() => validateEditPlan(repeated, { sourceCatalog }));
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-4", start: 0, end: 1 }] }] }, { sourceCatalog }), /unknown source/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: -1, end: 1 }] }] }, { sourceCatalog }), /timestamps/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 5, end: 5 }] }] }, { sourceCatalog }), /timestamps/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 21 }] }] }, { sourceCatalog }), /exceeds/);
});

test("version 2 rejects merge and source IDs on global-only operations", () => {
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }] },
    { type: "merge" }
  ] }, { sourceCatalog }), /cannot include merge/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }] },
    { type: "trim", sourceId: "source-1", start: 0, end: 1 }
  ] }, { sourceCatalog }), /sourceId is supported only/);
});

test("source-aware JSON schema limits source IDs to the supplied catalog", () => {
  const schema = createEditPlanJsonSchema({ sourceIds: sourceCatalog.map((source) => source.sourceId) });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /source-1/);
  assert.doesNotMatch(serialized, /source-4/);
});

test("semantic source extraction preserves order and skips explicit ordinals", () => {
  assert.deepEqual(extractSemanticSourceReferences("Use the talking clip first, then the greenery footage.", sourceCatalog), [
    { referenceId: "semantic-1", description: "talking clip" },
    { referenceId: "semantic-2", description: "greenery footage" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use video 2 first, then the greenery clip.", sourceCatalog), [
    { referenceId: "semantic-1", description: "greenery clip" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use the video showing the road.", sourceCatalog), [
    { referenceId: "semantic-1", description: "video showing road" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use video 2, then video 1.", sourceCatalog), []);
});

test("semantic source extraction excludes explicit source-time phrases without losing semantic references", () => {
  const productionPrompt = 'Use the first 3 seconds of video 1, followed by the first 3 seconds of video 2, and add the title "SECOND HALF" at 0:04.';
  assert.deepEqual(extractSemanticSourceReferences(productionPrompt, sourceCatalog), []);
  assert.equal(requiresVisualSourceUnderstanding(productionPrompt, sourceCatalog), false);
  assert.deepEqual(createEditPlan({ prompt: productionPrompt, hasMultipleVideos: true, sourceCatalog }).operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 3 }, { sourceId: "source-2", start: 0, end: 3 }] }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use the first 3 seconds of video 1, followed by seconds 5 to 8 of video 2.", sourceCatalog), []);
  assert.deepEqual(extractSemanticSourceReferences("Use the first 3 seconds of source-1, then the first 3 seconds of source-2.", sourceCatalog), []);
  assert.deepEqual(extractSemanticSourceReferences("Use the greenery video, then the talking clip.", sourceCatalog), [
    { referenceId: "semantic-1", description: "greenery video" },
    { referenceId: "semantic-2", description: "talking clip" }
  ]);
  assert.deepEqual(extractSemanticSourceReferences("Use video 2 first, then the greenery clip.", sourceCatalog), [
    { referenceId: "semantic-1", description: "greenery clip" }
  ]);
});

test("semantic source classification schema constrains the assigned source and references", () => {
  const schema = createSemanticSourceClassificationJsonSchema({ sourceId: "source-1", referenceIds: ["semantic-1"] });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /plausibleMatch/);
  assert.match(serialized, /semantic-1/);
  assert.match(serialized, /source-1/);
  assert.doesNotMatch(serialized, /source-2/);
});

test("visual moment extraction recognizes structural event and boundary requests without timestamp parsing", () => {
  const oneSource = sourceCatalog.slice(0, 1);
  assert.deepEqual(extractVisualMomentRequest("Use the part where the car enters the driveway.", oneSource), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the car enters the driveway",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Keep the section where the cyclist reaches the bridge.", oneSource), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the cyclist reaches the bridge",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Start when the house appears.", oneSource), {
    momentId: "moment-1",
    mode: "START_BOUNDARY",
    startEventDescription: "the house appears",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Stop once she sits down.", oneSource), {
    momentId: "moment-1",
    mode: "END_BOUNDARY",
    endEventDescription: "she sits down",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Cut everything after she reaches the bridge.", oneSource), {
    momentId: "moment-1",
    mode: "END_BOUNDARY",
    endEventDescription: "she reaches the bridge",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.deepEqual(extractVisualMomentRequest("Start when the door opens and end when she leaves.", oneSource), {
    momentId: "moment-1",
    mode: "START_END_BOUNDARY",
    startEventDescription: "the door opens",
    endEventDescription: "she leaves",
    sourceScope: { type: "single", sourceId: "source-1" }
  });
  assert.equal(extractVisualMomentRequest("Trim from 0:05 to 0:10.", oneSource), null);
  assert.equal(requiresVisualMomentUnderstanding("Use the part where the car enters the driveway.", oneSource), true);
  assert.equal(requiresVisualMomentUnderstanding("Make this cinematic.", oneSource), false);
});

test("visual moment extraction scopes explicit and semantic source requests", () => {
  assert.deepEqual(extractVisualMomentRequest("From video 2, use the part where the person waves.", sourceCatalog), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the person waves",
    sourceScope: { type: "explicit", sourceId: "source-2" }
  });
  assert.deepEqual(extractVisualMomentRequest("From the greenery clip, use the part where the path appears.", sourceCatalog), {
    momentId: "moment-1",
    mode: "EVENT_SEGMENT",
    startEventDescription: "the path appears",
    sourceScope: { type: "semantic", referenceId: "semantic-1" }
  });
});

test("visual moment localization schema constrains the source, moment ID, and bounded candidates", () => {
  const schema = createVisualMomentLocalizationJsonSchema({ sourceId: "source-2", momentIds: ["moment-1"] });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /source-2/);
  assert.match(serialized, /moment-1/);
  assert.match(serialized, /candidates/);
  assert.doesNotMatch(serialized, /source-1/);
});

test("visual moment localization prompt requires the full visible event without ranking partial matches", () => {
  const prompt = buildVisualMomentLocalizationPrompt({
    source: sourceCatalog[0],
    moment: extractVisualMomentRequest("Use the part where the person walks through the temple.", sourceCatalog.slice(0, 1))
  });
  assert.match(prompt, /conjunction of all meaningful visible constraints/);
  assert.match(prompt, /every essential subject, object, action, setting, direction, relationship, and state/);
  assert.match(prompt, /Never return a partial semantic match/);
  assert.match(prompt, /Prefer a false negative/);
  assert.match(prompt, /do not choose a best occurrence/);
  assert.match(prompt, /forest or generic path/);
  assert.match(prompt, /Do not use filenames as visual evidence/);
});

test("visual moment localizations derive source-time ranges and reject ambiguous or malformed evidence", () => {
  const single = sourceCatalog.slice(0, 1);
  const eventRequest = extractVisualMomentRequest("Use the part where the car enters.", single);
  const startRequest = extractVisualMomentRequest("Start when the car enters.", single);
  const endRequest = extractVisualMomentRequest("End when the car leaves.", single);
  assert.deepEqual(resolveVisualMomentLocalizations([
    { expectedSourceId: "source-1", response: JSON.parse(momentLocalizationResponse("source-1", [{ start: 3, end: 7 }])) }
  ], eventRequest, single, ["source-1"]), { sourceId: "source-1", start: 3, end: 7 });
  assert.deepEqual(resolveVisualMomentLocalizations([
    { expectedSourceId: "source-1", response: JSON.parse(momentLocalizationResponse("source-1", [{ start: 3, end: 7 }])) }
  ], startRequest, single, ["source-1"]), { sourceId: "source-1", start: 3, end: 20 });
  assert.deepEqual(resolveVisualMomentLocalizations([
    { expectedSourceId: "source-1", response: JSON.parse(momentLocalizationResponse("source-1", [{ start: 3, end: 7 }])) }
  ], endRequest, single, ["source-1"]), { sourceId: "source-1", start: 0, end: 7 });

  const malformed = [
    [],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-2", moments: [] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "other", candidates: [] }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "moment-1", candidates: [{ start: -1, end: 1 }] }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "moment-1", candidates: [{ start: 3, end: 21 }] }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", moments: [{ momentId: "moment-1", candidates: [{ start: 3, end: 7 }, { start: 8, end: 9 }] }] } }]
  ];
  for (const localizations of malformed) {
    assert.throws(() => resolveVisualMomentLocalizations(localizations, eventRequest, single, ["source-1"]), /needs Gemini video understanding/);
  }
});

test("a unique single-source visual moment creates an authoritative V2 sequence", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const finalPlan = { version: "1", operations: [{ type: "color_grade", style: "bw" }] };
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 3, end: 7 }]),
    JSON.stringify(finalPlan)
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the car enters, and make it black and white.", hasMultipleVideos: false,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
  }));
  assert.deepEqual(result.plan, {
    version: "2",
    operations: [
      { type: "sequence", clips: [{ sourceId: "source-1", start: 3, end: 7 }] },
      { type: "color_grade", style: "bw" }
    ]
  });
  assert.equal(aiClient.requests.length, 2);
  assert.equal(aiClient.requests[0].contents.filter((part) => part?.fileData).length, 1);
  assert.equal(aiClient.requests[1].contents.filter((part) => part?.fileData).length, 1);
  assert.match(aiClient.requests[1].contents.at(-1), /Authoritative localized sequence/);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog: catalog }));
});

test("visual start, end, and paired boundaries derive exact V2 source ranges", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const cases = [
    ["Start when the house appears.", { start: 4, end: 20 }],
    ["End when the person sits down.", { start: 0, end: 8 }],
    ["Start when the door opens and end when she leaves.", { start: 4, end: 8 }]
  ];
  for (const [prompt, expectedRange] of cases) {
    const aiClient = createMockGemini({ responses: [
      momentLocalizationResponse("source-1", [{ start: 4, end: 8 }]),
      JSON.stringify({ version: "1", operations: [] })
    ] });
    const result = await withGeminiKey(() => createAiEditPlan({
      prompt, hasMultipleVideos: false, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
    }));
    assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", ...expectedRange }]);
  }
});

test("visual moment localization confines explicit source scope and resolves semantic source scope first", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const explicitAi = createMockGemini({ responses: [
    momentLocalizationResponse("source-2", [{ start: 5, end: 10 }]),
    JSON.stringify(fullSequence(catalog, ["source-1", "source-2"]))
  ] });
  const explicit = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 2, use the part where the person waves.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: explicitAi
  }));
  assert.deepEqual(explicit.plan.operations[0].clips, [{ sourceId: "source-2", start: 5, end: 10 }]);
  assert.equal(explicitAi.requests.length, 2);
  assert.equal(explicitAi.requests[0].contents[1].fileData.fileUri, explicitAi.uploads[1].uri);

  const semanticAi = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    momentLocalizationResponse("source-2", [{ start: 6, end: 11 }]),
    JSON.stringify(fullSequence(catalog, ["source-1", "source-2"]))
  ] });
  const semantic = await withGeminiKey(() => createAiEditPlan({
    prompt: "From the greenery clip, use the part where the path appears.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: semanticAi
  }));
  assert.deepEqual(semantic.plan.operations[0].clips, [{ sourceId: "source-2", start: 6, end: 11 }]);
  assert.equal(semanticAi.requests.length, 4);
  assert.equal(semanticAi.requests[2].contents[1].fileData.fileUri, semanticAi.uploads[1].uri);
});

test("unscoped visual moment requires exactly one candidate across all sources", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const uniqueAi = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", []),
    momentLocalizationResponse("source-2", [{ start: 2, end: 6 }]),
    JSON.stringify(fullSequence(catalog))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the bird takes off.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: uniqueAi
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-2", start: 2, end: 6 }]);
  assert.equal(uniqueAi.requests.length, 3);

  const templeAi = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", []),
    momentLocalizationResponse("source-2", [{ start: 2.1, end: 5.4 }]),
    JSON.stringify(fullSequence(catalog))
  ] });
  const templeResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the person walks through the temple.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: templeAi
  }));
  assert.deepEqual(templeResult.plan.operations[0].clips, [{ sourceId: "source-2", start: 2.1, end: 5.4 }]);
  assert.equal(templeAi.requests.length, 3);

  for (const responses of [
    [momentLocalizationResponse("source-1", []), momentLocalizationResponse("source-2", [])],
    [momentLocalizationResponse("source-1", [{ start: 1, end: 3 }]), momentLocalizationResponse("source-2", [{ start: 2, end: 4 }])],
    [momentLocalizationResponse("source-1", [{ start: 1, end: 3 }, { start: 4, end: 6 }]), momentLocalizationResponse("source-2", [])]
  ]) {
    const aiClient = createMockGemini({ responses });
    await withGeminiKey(() => assert.rejects(
      () => createAiEditPlan({ prompt: "Use the part where the bird takes off.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }),
      /needs Gemini video understanding/
    ));
    assert.equal(aiClient.requests.length, 2);
  }
});

test("visual localization retries reuse the existing Gemini file and always cleans uploads", async () => {
  const catalog = sourceCatalog.slice(0, 1);
  const transient = Object.assign(new Error("high demand"), { status: 503 });
  const aiClient = createMockGemini({
    failures: [transient, null, null],
    responses: [null, momentLocalizationResponse("source-1", [{ start: 2, end: 5 }]), JSON.stringify({ version: "1", operations: [] })]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the car enters.", hasMultipleVideos: false, sourceCatalog: catalog,
    sourceInputs: plannerSources(catalog), aiClient, retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(result.plan.version, "2");
  assert.equal(aiClient.uploads.length, 1);
  assert.equal(aiClient.requests.length, 3);
  assert.equal(aiClient.requests[0].contents[1].fileData.fileUri, aiClient.requests[1].contents[1].fileData.fileUri);
  assert.deepEqual(aiClient.deletes, ["files/1"]);
});

test("semantic multi-source planning classifies each Gemini video independently before planning", async () => {
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }, { referenceId: "semantic-2", plausibleMatch: false }]),
    classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: false }]),
    JSON.stringify(fullSequence(sourceCatalog, ["source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Put the homestay video first, then the greenery video.", hasMultipleVideos: true,
    sourceCatalog, sourceInputs: plannerSources(), aiClient, retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(result.source, "gemini");
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.equal(aiClient.uploads.length, 3);
  assert.equal(aiClient.deletes.length, 3);
  for (const [index, source] of sourceCatalog.entries()) {
    const request = aiClient.requests[index];
    assert.equal(request.contents.filter((part) => part?.fileData).length, 1);
    assert.match(request.contents[0], new RegExp(`SOURCE ${source.sourceId}`));
    assert.equal(request.contents[1].fileData.fileUri, aiClient.uploads[index].uri);
  }
  assert.equal(aiClient.requests[3].contents.filter((part) => part?.fileData).length, 3);
  assert.match(aiClient.requests[3].contents.at(-1), /Authoritative resolved semantic sources/);
});

test("semantic visual adjustment scope preserves ordinary sequences without broadening real selections", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const classifications = [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }])
  ];
  const planFor = async (prompt, finalPlan = fullSequence(catalog, ["source-2"])) => withGeminiKey(() => createAiEditPlan({
    prompt, hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog),
    aiClient: createMockGemini({ responses: [...classifications, JSON.stringify(finalPlan)] })
  }));

  const scoped = await planFor("Make the greenery video slightly brighter.");
  assert.deepEqual(scoped.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-1", "source-2"]);
  assert.deepEqual(scoped.plan.operations.at(-1), { type: "visual_adjustment", brightness: 0.12, sourceId: "source-2" });

  const withAudio = await planFor("Make the greenery video slightly brighter and reduce the volume.");
  assert.deepEqual(withAudio.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-1", "source-2"]);
  assert.deepEqual(withAudio.plan.operations.find((operation) => operation.type === "visual_adjustment"), { type: "visual_adjustment", brightness: 0.12, sourceId: "source-2" });
  assert.deepEqual(withAudio.plan.operations.find((operation) => operation.type === "audio_volume"), { type: "audio_volume", factor: 0.5 });

  const withCaptions = await planFor("Make the greenery video slightly brighter, then add subtitles.");
  assert.deepEqual(withCaptions.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-1", "source-2"]);
  assert.deepEqual(withCaptions.plan.operations.find((operation) => operation.type === "visual_adjustment"), { type: "visual_adjustment", brightness: 0.12, sourceId: "source-2" });
  assert.equal(withCaptions.plan.operations.some((operation) => operation.type === "captions"), true);

  const selection = await planFor("Use the greenery video.");
  assert.deepEqual(selection.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2"]);

  const selectionWithAdjustment = await planFor("Use the greenery video and make it slightly brighter.");
  assert.deepEqual(selectionWithAdjustment.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2"]);
  assert.deepEqual(selectionWithAdjustment.plan.operations.at(-1), { type: "visual_adjustment", brightness: 0.12, sourceId: "source-2" });

  const reordered = await planFor("Use video 2, then video 1, and make the greenery video slightly brighter.", fullSequence(catalog, ["source-2", "source-1"]));
  assert.deepEqual(reordered.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.deepEqual(reordered.plan.operations.at(-1), { type: "visual_adjustment", brightness: 0.12, sourceId: "source-2" });

  const explicit = createEditPlan({ prompt: "Make video 2 warmer.", hasMultipleVideos: true, sourceCatalog: catalog });
  assert.deepEqual(explicit.operations[0].clips.map((clip) => clip.sourceId), ["source-1", "source-2"]);
  assert.deepEqual(explicit.operations.at(-1), { type: "visual_adjustment", temperature: 0.2, sourceId: "source-2" });
});

test("ambiguous semantic sources reject safely without calling the final planner", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }])
  ] });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: "Use the greenery clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 2);
  assert.equal(aiClient.deletes.length, 2);
});

test("no-match semantic sources reject safely without calling the final planner", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }])
  ] });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({ prompt: "Use the beach clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 2);
  assert.equal(aiClient.deletes.length, 2);
});

test("semantic source classification rejects malformed evidence", () => {
  const references = [{ referenceId: "semantic-1", description: "greenery clip" }];
  const valid = { sourceId: "source-2", matches: [{ referenceId: "semantic-1", plausibleMatch: false }] };
  const cases = [
    [],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-2", matches: [] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }] } }, { expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }] } }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: true }, { referenceId: "semantic-1", plausibleMatch: false }] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-2", plausibleMatch: true }] } }, { expectedSourceId: "source-2", response: valid }],
    [{ expectedSourceId: "source-1", response: { sourceId: "source-1", matches: [{ referenceId: "semantic-1", plausibleMatch: "true" }] } }, { expectedSourceId: "source-2", response: valid }]
  ];
  for (const classifications of cases) {
    assert.throws(() => resolveSemanticSourceClassifications(classifications, references, sourceCatalog.slice(0, 2)), /needs Gemini video understanding/);
  }
});

test("mixed explicit and semantic references classify only the semantic reference and preserve V2 order", async () => {
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: false }]),
    JSON.stringify(fullSequence(sourceCatalog, ["source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use video 2 first, then the greenery clip.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.equal(aiClient.requests.length, 4);
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog }));
});

test("three-source semantic ordering remains valid after unique independent classification", async () => {
  const aiClient = createMockGemini({ responses: [
    classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: false }, { referenceId: "semantic-3", plausibleMatch: true }]),
    classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }, { referenceId: "semantic-2", plausibleMatch: true }, { referenceId: "semantic-3", plausibleMatch: false }]),
    classificationResponse("source-3", [{ referenceId: "semantic-1", plausibleMatch: true }, { referenceId: "semantic-2", plausibleMatch: false }, { referenceId: "semantic-3", plausibleMatch: false }]),
    JSON.stringify(fullSequence(sourceCatalog, ["source-3", "source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Start with the road footage, then the talking clip, then the greenery footage.", hasMultipleVideos: true,
    sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-3", "source-2", "source-1"]);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog }));
});

test("transient planning retries reuse uploaded Gemini files", async () => {
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({
    failures: [null, error, null, null],
    responses: [
      classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }]),
      null,
      classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: true }]),
      JSON.stringify(fullSequence(catalog, ["source-2"]))
    ]
  });
  await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the house video first.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
    retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(aiClient.uploads.length, 2);
  assert.equal(aiClient.requests.length, 4);
  assert.equal(aiClient.deletes.length, 2);
  assert.equal(aiClient.requests[1].contents[1].fileData.fileUri, aiClient.requests[2].contents[1].fileData.fileUri);
});

test("retry exhaustion still cleans every uploaded Gemini file", async () => {
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({
    failures: [null, error, error, error],
    responses: [classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: false }])]
  });
  await withGeminiKey(async () => {
    await assert.rejects(
      () => createAiEditPlan({
        prompt: "Use the house video first.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
        retryOptions: { sleepFn: async () => {}, random: () => 0 }
      }),
      /needs Gemini video understanding/
    );
  });
  assert.equal(aiClient.uploads.length, 2);
  assert.equal(aiClient.requests.length, 4);
  assert.equal(aiClient.deletes.length, 2);
});

test("malformed classification responses reject safely and clean uploaded Gemini files", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responseText: "not-json" });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({
      prompt: "Use the greenery clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
    }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 1);
  assert.equal(aiClient.deletes.length, 2);
});

test("final planner failure after classification still cleans uploaded Gemini files", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const error = Object.assign(new Error("high demand"), { status: 503 });
  const aiClient = createMockGemini({
    failures: [null, null, error, error, error],
    responses: [
      classificationResponse("source-1", [{ referenceId: "semantic-1", plausibleMatch: true }]),
      classificationResponse("source-2", [{ referenceId: "semantic-1", plausibleMatch: false }])
    ]
  });
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({
      prompt: "Use the greenery clip.", hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient,
      retryOptions: { sleepFn: async () => {}, random: () => 0 }
    }),
    /needs Gemini video understanding/
  ));
  assert.equal(aiClient.requests.length, 5);
  assert.equal(aiClient.deletes.length, 2);
});

test("explicit-only requests do not invoke semantic selection", async () => {
  const aiClient = createMockGemini({ responseText: JSON.stringify(fullSequence(sourceCatalog, ["source-2", "source-1"])) });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use video 2, then video 1.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.equal(aiClient.requests.length, 1);
  assert.deepEqual(result.plan.operations[0].clips.map((clip) => clip.sourceId), ["source-2", "source-1"]);
});

test("explicit source-only color grading does not invoke semantic selection", async () => {
  const plan = fullSequence(sourceCatalog);
  plan.operations.push({ type: "color_grade", sourceId: "source-2", style: "bw" });
  const aiClient = createMockGemini({ responseText: JSON.stringify(plan) });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make only video 2 black and white.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(), aiClient
  }));
  assert.equal(aiClient.requests.length, 1);
  assert.deepEqual(result.plan.operations[1], { type: "color_grade", sourceId: "source-2", style: "bw" });
});

test("explicit source-only color grading does not require visual understanding and falls back safely", async () => {
  const prompt = "Make only video 2 black and white.";
  assert.equal(requiresVisualSourceUnderstanding(prompt, sourceCatalog), false);

  const unavailable = await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    return createAiEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() });
  });
  assert.equal(unavailable.source, "deterministic");
  assert.deepEqual(unavailable.plan, createEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog }));
  assert.doesNotThrow(() => validateEditPlan(unavailable.plan, { sourceCatalog }));

  const transientFailure = Object.assign(new Error("high demand"), { status: 503 });
  const transient = await withGeminiKey(() => createAiEditPlan({
    prompt, hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources(),
    aiClient: createMockGemini({ failures: [transientFailure, transientFailure, transientFailure] }),
    retryOptions: { sleepFn: async () => {}, random: () => 0 }
  }));
  assert.equal(transient.source, "deterministic");
  assert.deepEqual(transient.plan, unavailable.plan);
});

test("Gemini-unavailable explicit source requests retain fallback while semantic requests fail safely", async () => {
  const explicit = await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    return createAiEditPlan({ prompt: "Use video 2 then video 1.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() });
  });
  assert.equal(explicit.source, "deterministic");
  await withGeminiKey(async () => {
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(
      () => createAiEditPlan({ prompt: "Use the beach clip first.", hasMultipleVideos: true, sourceCatalog, sourceInputs: plannerSources() }),
      /needs Gemini video understanding/
    );
  });
  assert.equal(requiresVisualSourceUnderstanding("Use the talking clip first, then the greenery footage.", sourceCatalog), true);
  assert.equal(requiresVisualSourceUnderstanding("Use video 2 first, then the greenery clip.", sourceCatalog), true);
});

test("multi-moment composition extraction is ordered, bounded, and preserves existing paired boundaries", () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  for (const { prompt, count } of [
    { prompt: "Use the part where the person enters, then the part where the person exits.", count: 2 },
    { prompt: "Use the part where the food is prepared and then the section where the food is served followed by the moment where the food is tasted.", count: 3 }
  ]) {
    const composition = extractMomentCompositionRequests(prompt, catalog);
    assert.equal(composition.requests.length, count);
    assert.deepEqual(composition.requests.map((request) => request.momentId), Array.from({ length: count }, (_, index) => `moment-${index + 1}`));
    assert.ok(composition.requests.every((request) => request.mode === "EVENT_SEGMENT"));
  }
  assert.equal(extractMomentCompositionRequests("Start when the door opens and end when she leaves.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Start when I begin talking about pricing and end when I begin talking about integrations.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Start when the door opens then end when she leaves.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Start when I begin talking about pricing then stop when I begin talking about integrations.", catalog), null);
  assert.equal(extractMomentCompositionRequests("Use the part where the person walks and then rides a bicycle.", catalog), null);
  assert.equal(requiresMomentCompositionUnderstanding("Use the part where the person enters, then the part where the person exits.", catalog), true);
  assert.equal(requiresMomentCompositionUnderstanding("Start when the door opens and end when she leaves.", catalog), false);
  assert.equal(extractMomentCompositionRequests("Use the part where the door opens, then the part where.", catalog).error, "COMPOSITION_UNSUPPORTED_MOMENT");
  assert.equal(extractMomentCompositionRequests("Use the part where one, then the part where two, then the part where three, then the part where four, then the part where five, then the part where six.", catalog).error, "COMPOSITION_TOO_MANY_MOMENTS");
  assert.equal(extractMomentCompositionRequests("From the indoor clip, use the part where the person waves, then the part where the person leaves.", catalog).error, "COMPOSITION_SEMANTIC_SOURCE_SCOPE_UNSUPPORTED");

  const five = extractMomentCompositionRequests("Use the part where one, then the part where two, then the part where three, then the part where four, then the part where five.", catalog);
  assert.deepEqual(five.requests.map((request) => request.momentId), ["moment-1", "moment-2", "moment-3", "moment-4", "moment-5"]);

  const quotedComposition = extractMomentCompositionRequests('Use the part where I say "one and make two", then the part where I say "done".', catalog);
  assert.deepEqual(quotedComposition.requests.map((request) => request.startPhrase), ["one and make two", "done"]);
  const quotedThen = extractMomentCompositionRequests('Use the part where I say "first then second", then the part where I say "done".', catalog);
  assert.deepEqual(quotedThen.requests.map((request) => request.startPhrase), ["first then second", "done"]);
  const curly = extractMomentCompositionRequests("Use the part where I say “one and make two”, then the part where I say “done”.", catalog);
  assert.deepEqual(curly.requests.map((request) => request.startPhrase), ["one and make two", "done"]);
  assert.equal(extractMomentCompositionRequests('Use the part where I say "first then the part where second".', catalog), null);
  assert.equal(extractSpokenMomentRequest('Use the part where I say "first then the part where second".', catalog).startPhrase, "first then the part where second");
  assert.equal(extractMomentCompositionRequests("Use the part where one,then the part where two.", catalog).requests.length, 2);
});

test("multi-moment visual composition preserves requested order and replaces final planner clips", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 8, end: 10 }], "moment-1"),
    momentLocalizationResponse("source-1", [{ start: 2, end: 4 }], "moment-2"),
    JSON.stringify(fullSequence(catalog, ["source-2", "source-1"]))
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 1, use the part where the person enters, then from video 1, use the part where the person exits.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
  }));
  assert.deepEqual(result.plan.operations[0], {
    type: "sequence",
    clips: [{ sourceId: "source-1", start: 8, end: 10 }, { sourceId: "source-1", start: 2, end: 4 }]
  });
  assert.equal(aiClient.requests.length, 3);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog: catalog }));
});

test("multi-moment composition searches each unscoped request independently and builds three clips", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 1, end: 2 }], "moment-1"),
    momentLocalizationResponse("source-2", [], "moment-1"),
    momentLocalizationResponse("source-1", [], "moment-2"),
    momentLocalizationResponse("source-2", [{ start: 4, end: 6 }], "moment-2"),
    momentLocalizationResponse("source-1", [{ start: 7, end: 9 }], "moment-3"),
    momentLocalizationResponse("source-2", [], "moment-3"),
    JSON.stringify({ version: "1", operations: [] })
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Use the part where the door opens, then the part where the person enters, followed by the part where the door closes.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
  }));
  assert.deepEqual(result.plan.operations[0].clips, [
    { sourceId: "source-1", start: 1, end: 2 },
    { sourceId: "source-2", start: 4, end: 6 },
    { sourceId: "source-1", start: 7, end: 9 }
  ]);
  assert.equal(aiClient.requests.length, 7);
});

test("multi-moment composition routes visual and exact spoken clauses independently and reuses transcripts", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 3, end: 5 }], "moment-1"),
    JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })
  ], transcriptionInteractions: [interaction([
    { text: "Welcome", start_offset: "7s", end_offset: "7.3s" },
    { text: "Back.", start_offset: "7.3s", end_offset: "7.7s" }
  ])] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'From video 1, use the part where the person waves, then from video 2, use the part where I say "Welcome Back" and make it black and white.',
    hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 3, end: 5 }, { sourceId: "source-2", start: 7, end: 7.7 }] },
    { type: "color_grade", style: "bw" }
  ]);
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.equal(aiClient.requests.length, 2);
  assert.match(aiClient.requests[0].contents.at(-1), /person waves/);
});

test("multi-moment exact and semantic speech reuse one source transcript", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({ responses: [
    semanticTranscriptResponse("source-1", [{ startSegmentId: "source-1-seg-2", endSegmentId: "source-1-seg-2" }], "moment-1"),
    JSON.stringify({ version: "1", operations: [] })
  ], transcriptionInteractions: [interaction([
    { text: "Welcome", start_offset: "1s", end_offset: "1.4s" },
    { text: "Pricing.", start_offset: "2.5s", end_offset: "3s" }
  ])] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I explain pricing, then the part where I say "Welcome".', sourceCatalog: catalog,
    sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", start: 2.5, end: 3 }, { sourceId: "source-1", start: 1, end: 1.4 }]);
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.equal(aiClient.requests.length, 2);
});

test("multi-moment composition rejects atomically when any clause has zero or ambiguous candidates", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  for (const responses of [
    [momentLocalizationResponse("source-1", [{ start: 1, end: 2 }], "moment-1"), momentLocalizationResponse("source-2", [], "moment-2")],
    [momentLocalizationResponse("source-1", [{ start: 1, end: 2 }], "moment-1"), momentLocalizationResponse("source-2", [{ start: 3, end: 4 }, { start: 5, end: 6 }], "moment-2")]
  ]) {
    const aiClient = createMockGemini({ responses });
    await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
      prompt: "From video 1, use the part where the person enters, then from video 2, use the part where the person exits.", hasMultipleVideos: true,
      sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
    }), UnsupportedEditRequestError));
    assert.equal(aiClient.requests.length, 2);
  }
});

test("multi-moment malformed composition rejects before any localization or final plan", async () => {
  const aiClient = createMockGemini();
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({
    prompt: "Use the part where the person enters, then the part where.", hasMultipleVideos: true,
    sourceCatalog: sourceCatalog.slice(0, 2), sourceInputs: plannerSources(sourceCatalog.slice(0, 2)), aiClient
  }), UnsupportedEditRequestError));
  assert.equal(aiClient.requests.length, 0);
  assert.equal(aiClient.uploads.length, 0);
});

test("multi-moment explicit scopes isolate visual and semantic speech work", async () => {
  const catalog = speechCatalog(sourceCatalog.slice(0, 2));
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 4, end: 6 }], "moment-1"),
    semanticTranscriptResponse("source-2", [{ startSegmentId: "source-2-seg-1", endSegmentId: "source-2-seg-1" }], "moment-2"),
    JSON.stringify({ version: "1", operations: [] })
  ], transcriptionInteractions: [interaction([{ text: "Pricing.", start_offset: "2s", end_offset: "2.5s" }])] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 1, use the part where the person waves, then from video 2, use the part where I explain pricing.", hasMultipleVideos: true,
    sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.deepEqual(result.plan.operations[0].clips, [{ sourceId: "source-1", start: 4, end: 6 }, { sourceId: "source-2", start: 2, end: 2.5 }]);
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.match(aiClient.requests[0].contents[0], /SOURCE source-1/);
  assert.match(aiClient.requests[1].contents, /source-2-seg-1/);
});

test("multi-source compositions reject final planner source-scoped operations but retain global operations", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const prompt = "From video 1, use the part where the person enters, then from video 2, use the part where the person exits and make it black and white.";
  const localizationResponses = [
    momentLocalizationResponse("source-1", [{ start: 1, end: 3 }], "moment-1"),
    momentLocalizationResponse("source-2", [{ start: 4, end: 6 }], "moment-2")
  ];
  const scoped = createMockGemini({ responses: [...localizationResponses, JSON.stringify({ version: "2", operations: [
    { type: "sequence", clips: [{ sourceId: "source-2", start: 0, end: 30 }] },
    { type: "color_grade", sourceId: "source-1", style: "bw" }
  ] })] });
  await withGeminiKey(() => assert.rejects(() => createAiEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: scoped }), UnsupportedEditRequestError));

  const global = createMockGemini({ responses: [...localizationResponses, JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] })] });
  const result = await withGeminiKey(() => createAiEditPlan({ prompt, hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient: global }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 3 }, { sourceId: "source-2", start: 4, end: 6 }] },
    { type: "color_grade", style: "bw" }
  ]);
});

test("multi-moment authoritative sequences retain server-owned global audio controls", async () => {
  const catalog = sourceCatalog.slice(0, 2);
  const aiClient = createMockGemini({ responses: [
    momentLocalizationResponse("source-1", [{ start: 1, end: 3 }], "moment-1"),
    momentLocalizationResponse("source-2", [{ start: 4, end: 6 }], "moment-2"),
    JSON.stringify({ version: "1", operations: [{ type: "audio_volume", factor: 1 }] })
  ] });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "From video 1, use the part where the person enters, then from video 2, use the part where the person exits and mute the video.",
    hasMultipleVideos: true, sourceCatalog: catalog, sourceInputs: plannerSources(catalog), aiClient
  }));
  assert.deepEqual(result.plan.operations, [
    { type: "sequence", clips: [{ sourceId: "source-1", start: 1, end: 3 }, { sourceId: "source-2", start: 4, end: 6 }] },
    { type: "audio_volume", factor: 0 }
  ]);
  assert.doesNotThrow(() => validateEditPlan(result.plan, { sourceCatalog: catalog }));
});

async function makeMixedFrameRateSource(output, frameRate, duration) {
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=160x90:rate=${frameRate}`,
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
    "-t", duration.toString(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", output
  ]);
}

async function makeSolidCaptionSource(output, duration, { width = 1280, height = 720, color = "black" } = {}) {
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:size=${width}x${height}:rate=30`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", duration.toString(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", output
  ]);
}

async function makeSolidSequenceSource(output, color, duration = 2) {
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:size=160x90:rate=30`,
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
    "-t", duration.toString(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", output
  ]);
}

async function captionRegionDifference(videoPath, firstTime, secondTime) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", firstTime.toString(), "-i", videoPath,
    "-ss", secondTime.toString(), "-i", videoPath,
    "-filter_complex", "[0:v][1:v]blend=all_mode=difference,crop=768:216:256:468",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
  return [...stdout].reduce((sum, value) => sum + value, 0);
}

async function executeWithWatchdog(options, { watchdogMs = 8_000 } = {}) {
  const executionController = createExecutionController({ gracePeriodMs: 500 });
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    executionController.cancel();
  }, watchdogMs);
  try {
    const output = await executeEditPlan({ ...options, executionController });
    assert.equal(watchdogFired, false, "mixed-FPS watchdog fired");
    return output;
  } finally {
    clearTimeout(watchdog);
    executionController.dispose();
  }
}

async function probeRenderedVideo(outputPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,r_frame_rate,time_base,nb_frames", "-of", "json", outputPath
  ]);
  const probe = JSON.parse(stdout);
  return {
    duration: Number(probe.format.duration),
    video: probe.streams.find((stream) => stream.codec_type === "video"),
    audio: probe.streams.find((stream) => stream.codec_type === "audio")
  };
}

async function audioMaxVolume(outputPath, { start, duration } = {}) {
  const seek = start === undefined ? [] : ["-ss", start.toString()];
  const limit = duration === undefined ? [] : ["-t", duration.toString()];
  try {
    const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "info", ...seek, "-i", outputPath, ...limit, "-af", "volumedetect", "-f", "null", "-"]);
    const match = String(stderr).match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
    if (!match) throw new Error("volumedetect did not produce a maximum volume");
    return match[1] === "-inf" ? -Infinity : Number(match[1]);
  } catch (error) {
    const match = String(error.stderr || "").match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
    if (!match) throw error;
    return match[1] === "-inf" ? -Infinity : Number(match[1]);
  }
}

async function videoFrameDifference(firstPath, secondPath, time = 1) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", time.toString(), "-i", firstPath,
    "-ss", time.toString(), "-i", secondPath,
    "-filter_complex", "[0:v][1:v]blend=all_mode=difference", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
  return [...stdout].reduce((sum, value) => sum + value, 0);
}

async function makeStyleFixture(output, filter) {
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", filter,
    "-t", "1", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", output
  ]);
}

async function renderStyleFixture(input, output, filters = []) {
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input,
    ...(filters.length ? ["-vf", filters.join(",")] : []),
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", output
  ]);
}

async function readRgbFrame(input) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", input, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"
  ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function rgbFixtureStats(frame) {
  const extrema = { red: [255, 0], green: [255, 0], blue: [255, 0] };
  let lumaTotal = 0;
  let chromaTotal = 0;
  for (let index = 0; index < frame.length; index += 3) {
    const [red, green, blue] = [frame[index], frame[index + 1], frame[index + 2]];
    extrema.red[0] = Math.min(extrema.red[0], red); extrema.red[1] = Math.max(extrema.red[1], red);
    extrema.green[0] = Math.min(extrema.green[0], green); extrema.green[1] = Math.max(extrema.green[1], green);
    extrema.blue[0] = Math.min(extrema.blue[0], blue); extrema.blue[1] = Math.max(extrema.blue[1], blue);
    lumaTotal += (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    chromaTotal += Math.max(red, green, blue) - Math.min(red, green, blue);
  }
  const pixels = frame.length / 3;
  return { extrema, meanLuma: lumaTotal / pixels, meanChroma: chromaTotal / pixels };
}

function rgbRegionStats(frame, { width, height, x, y, regionWidth, regionHeight }) {
  assert.ok(x >= 0 && y >= 0 && x + regionWidth <= width && y + regionHeight <= height, "RGB region stays inside its frame");
  const extrema = { red: [255, 0], green: [255, 0], blue: [255, 0] };
  let lumaTotal = 0;
  let chromaTotal = 0;
  let pixels = 0;
  for (let row = y; row < y + regionHeight; row += 1) for (let column = x; column < x + regionWidth; column += 1) {
    const index = ((row * width) + column) * 3;
    const [red, green, blue] = [frame[index], frame[index + 1], frame[index + 2]];
    extrema.red[0] = Math.min(extrema.red[0], red); extrema.red[1] = Math.max(extrema.red[1], red);
    extrema.green[0] = Math.min(extrema.green[0], green); extrema.green[1] = Math.max(extrema.green[1], green);
    extrema.blue[0] = Math.min(extrema.blue[0], blue); extrema.blue[1] = Math.max(extrema.blue[1], blue);
    lumaTotal += (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    chromaTotal += Math.max(red, green, blue) - Math.min(red, green, blue);
    pixels += 1;
  }
  return { extrema, meanLuma: lumaTotal / pixels, meanChroma: chromaTotal / pixels };
}

function upperClippedRgbSampleCount(frame) {
  return [...frame].reduce((count, value) => count + (value === 255 ? 1 : 0), 0);
}

async function probeStyleFixture(input) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries", "-of", "json", input
  ]);
  const streams = JSON.parse(stdout).streams;
  return {
    video: streams.find((stream) => stream.codec_type === "video"),
    hasAudio: streams.some((stream) => stream.codec_type === "audio")
  };
}

function grayscaleValues(frame, width = 320) {
  const values = [];
  for (let index = 0; index < width * 3; index += 3) values.push(frame[index]);
  return values;
}

function longestRepeatedRun(values) {
  let longest = 0;
  let current = 0;
  let previous = null;
  for (const value of values) {
    current = value === previous ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = value;
  }
  return longest;
}

test("B1 internal tone and vibrance filters render safely across deterministic grading fixtures", { timeout: 60_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-style-fixtures-"));
  const fixtureFilters = {
    food: "color=c=0x120c0a:size=320x180:rate=30,drawbox=x=10:y=15:w=65:h=65:color=0x5a1606:t=fill,drawbox=x=90:y=15:w=65:h=65:color=0xa33a0c:t=fill,drawbox=x=170:y=15:w=65:h=65:color=0x7d4a1f:t=fill",
    skin: "color=c=0x6b3f24:size=320x180:rate=30,drawbox=x=55:y=25:w=210:h=125:color=0xc68642:t=fill,drawbox=x=105:y=50:w=110:h=75:color=0xe0ac69:t=fill",
    foliage: "color=c=0x102613:size=320x180:rate=30,drawbox=x=15:y=20:w=95:h=130:color=0x1e5d31:t=fill,drawbox=x=120:y=10:w=85:h=145:color=0x3b7e36:t=fill,drawbox=x=220:y=30:w=85:h=120:color=0x6c963c:t=fill",
    practical: "color=c=0x080b12:size=320x180:rate=30,drawbox=x=135:y=28:w=45:h=105:color=0xffd36a:t=fill,drawbox=x=205:y=45:w=25:h=65:color=0xdcecff:t=fill",
    gradient: "nullsrc=size=320x180:rate=30,geq=lum='16+219*X/W':cb=128:cr=128"
  };
  const extendedFilters = buildStyleRecipeFilters(canonicalStyleRecipe({
    brightness: 0.06, contrast: 0.08, saturation: 0.03, temperature: 0.02, tint: -0.01,
    shadows: 0.45, highlights: -0.35, vibrance: 0.4
  }));
  try {
    for (const [name, filter] of Object.entries(fixtureFilters)) {
      const source = path.join(tempDirectory, `${name}-source.mp4`);
      const rendered = path.join(tempDirectory, `${name}-extended.mp4`);
      await makeStyleFixture(source, filter);
      await renderStyleFixture(source, rendered, extendedFilters);
      const [sourceProbe, renderedProbe, sourceFrame, renderedFrame] = await Promise.all([
        probeStyleFixture(source), probeStyleFixture(rendered), readRgbFrame(source), readRgbFrame(rendered)
      ]);
      assert.deepEqual(
        { width: renderedProbe.video.width, height: renderedProbe.video.height, pix_fmt: renderedProbe.video.pix_fmt },
        { width: sourceProbe.video.width, height: sourceProbe.video.height, pix_fmt: "yuv420p" },
        `${name} retains production-compatible geometry and pixel format`
      );
      assert.equal(
        renderedProbe.video.color_range ?? null,
        sourceProbe.video.color_range ?? null,
        `${name} does not introduce a conflicting color-range tag`
      );
      assert.equal(renderedProbe.hasAudio, false, `${name} grading-only render does not introduce audio`);
      assert.notDeepEqual(renderedFrame, sourceFrame, `${name} receives a measurable non-neutral pixel treatment`);
      const stats = rgbFixtureStats(renderedFrame);
      for (const [channel, [minimum, maximum]] of Object.entries(stats.extrema)) {
        assert.ok(minimum >= 0 && maximum <= 255, `${name} ${channel} remains in RGB display bounds`);
      }
    }

    const gradientSource = path.join(tempDirectory, "gradient-source.mp4");
    const gradientCurved = path.join(tempDirectory, "gradient-curved.mp4");
    await renderStyleFixture(gradientSource, gradientCurved, [buildToneCurveFilter({ shadows: 0.5, highlights: -0.5 })]);
    const sourceValues = grayscaleValues(await readRgbFrame(gradientSource));
    const curvedValues = grayscaleValues(await readRgbFrame(gradientCurved));
    assert.ok(new Set(curvedValues).size >= 128, "portable curves retain a broad grayscale ramp after yuv420p encoding");
    assert.ok(
      longestRepeatedRun(curvedValues) <= longestRepeatedRun(sourceValues) + 2,
      "portable curves do not materially worsen flat gradient bands after yuv420p encoding"
    );

    const foodSource = path.join(tempDirectory, "food-source.mp4");
    const stages = {
      brightnessContrast: ["eq=brightness=0.0427:contrast=1.1895"],
      brightnessContrastSaturation: ["eq=brightness=0.0427:contrast=1.1895:saturation=1.3207"],
      colorBalance: ["colorbalance=rs=0.0165:gs=0.0000:bs=-0.0165:rm=0.0219:gm=0.0000:bm=-0.0219:rh=0.0165:gh=0.0000:bh=-0.0165:pl=1"],
      combinedLegacy: buildStyleRecipeFilters(compileStyleProfile({ profileId: "vibrant_social", profileVersion: 1, strength: "standard" }).recipe),
      saferCandidate: ["eq=brightness=0.0350:contrast=1.1400:saturation=1.0800", buildVibranceFilter({ vibrance: 0.35 }), "colorbalance=rs=0.0165:gs=0.0000:bs=-0.0165:rm=0.0219:gm=0.0000:bm=-0.0219:rh=0.0165:gh=0.0000:bh=-0.0165:pl=1"]
    };
    const stageStats = {};
    for (const [name, filters] of Object.entries(stages)) {
      const output = path.join(tempDirectory, `food-${name}.mp4`);
      await renderStyleFixture(foodSource, output, filters);
      stageStats[name] = rgbFixtureStats(await readRgbFrame(output));
    }
    assert.ok(stageStats.brightnessContrastSaturation.meanChroma > stageStats.brightnessContrast.meanChroma, "legacy saturation is the stage that materially raises food-fixture chroma");
    assert.notEqual(stageStats.combinedLegacy.meanLuma, stageStats.brightnessContrastSaturation.meanLuma, "warm colorbalance remains a separately measurable legacy stage");
    assert.ok(stageStats.saferCandidate.meanChroma < stageStats.brightnessContrastSaturation.meanChroma, "candidate direction reduces global saturation pressure before any future profile calibration");
    for (const stats of Object.values(stageStats)) for (const [minimum, maximum] of Object.values(stats.extrema)) {
      assert.ok(minimum >= 0 && maximum <= 255, "Vibrant Social diagnostic stages stay in displayable RGB bounds");
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2 Stage 0 black lift and midtone gamma render safely across the deterministic reference fixture matrix", { timeout: 90_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2-stage-zero-"));
  const fixtureFilters = {
    normalSkin: "color=c=0x483228:size=320x180:rate=30,drawbox=x=58:y=20:w=205:h=140:color=0xc68642:t=fill,drawbox=x=108:y=48:w=105:h=72:color=0xe0ac69:t=fill",
    brightSkin: "color=c=0x9e7655:size=320x180:rate=30,drawbox=x=60:y=20:w=200:h=140:color=0xf0c491:t=fill,drawbox=x=110:y=52:w=100:h=68:color=0xffe0bc:t=fill",
    foliage: "color=c=0x102613:size=320x180:rate=30,drawbox=x=15:y=20:w=90:h=130:color=0x1e5d31:t=fill,drawbox=x=118:y=10:w=88:h=145:color=0x3b7e36:t=fill,drawbox=x=220:y=30:w=85:h=120:color=0x6c963c:t=fill",
    blueSky: "color=c=0x5ea8d8:size=320x180:rate=30,drawbox=x=0:y=125:w=320:h=55:color=0x335d32:t=fill",
    warmSunset: "color=c=0x5a2a3c:size=320x180:rate=30,drawbox=x=0:y=0:w=320:h=80:color=0xffa15c:t=fill,drawbox=x=0:y=80:w=320:h=45:color=0xe85d4a:t=fill",
    food: "color=c=0x120c0a:size=320x180:rate=30,drawbox=x=10:y=15:w=65:h=65:color=0x5a1606:t=fill,drawbox=x=90:y=15:w=65:h=65:color=0xa33a0c:t=fill,drawbox=x=170:y=15:w=65:h=65:color=0x7d4a1f:t=fill",
    mutedInterior: "color=c=0x47413c:size=320x180:rate=30,drawbox=x=20:y=25:w=75:h=125:color=0x7b7163:t=fill,drawbox=x=120:y=25:w=75:h=125:color=0x686f72:t=fill,drawbox=x=220:y=25:w=75:h=125:color=0x746758:t=fill",
    nightPracticals: "color=c=0x080b12:size=320x180:rate=30,drawbox=x=135:y=28:w=45:h=105:color=0xffd36a:t=fill,drawbox=x=205:y=45:w=25:h=65:color=0xdcecff:t=fill",
    underexposed: "color=c=0x080b0d:size=320x180:rate=30,drawbox=x=45:y=45:w=85:h=100:color=0x25332d:t=fill,drawbox=x=180:y=35:w=85:h=110:color=0x3a3024:t=fill",
    alreadySaturated: "color=c=0x141414:size=320x180:rate=30,drawbox=x=15:y=25:w=80:h=125:color=0xff1f18:t=fill,drawbox=x=120:y=25:w=80:h=125:color=0x16d451:t=fill,drawbox=x=225:y=25:w=80:h=125:color=0x176ee8:t=fill",
    nearClippedHighlights: "color=c=0x302d28:size=320x180:rate=30,drawbox=x=85:y=20:w=150:h=135:color=0xfff4dc:t=fill,drawbox=x=125:y=55:w=70:h=65:color=white:t=fill",
    smoothGradient: "nullsrc=size=320x180:rate=30,geq=lum='16+219*X/W':cb=128:cr=128"
  };
  const treatment = createCanonicalReferenceStyleTreatment({ recipe: {
    brightness: 0.025, contrast: 0.04, saturation: 0.02, temperature: 0.035, tint: -0.01,
    shadows: 0.1, highlights: -0.16, vibrance: 0.12, blackLift: 0.6, midtoneGamma: 0.28,
    shadowTemperature: -0.12, midtoneTemperature: 0, highlightTemperature: 0.1
  } });
  const filters = buildReferenceStyleTreatmentFilters(treatment.recipe);
  assert.match(filters.find((filter) => filter.startsWith("colorbalance=")), /rs=-.*rh=0\./, "real B2 fixture matrix uses independent cool-shadow/warm-highlight channels");
  const measured = {};
  try {
    for (const [name, filter] of Object.entries(fixtureFilters)) {
      const source = path.join(tempDirectory, `${name}-source.mp4`);
      const rendered = path.join(tempDirectory, `${name}-b2.mp4`);
      await makeStyleFixture(source, filter);
      await renderStyleFixture(source, rendered, filters);
      const [sourceProbe, renderedProbe, sourceFrame, renderedFrame] = await Promise.all([
        probeStyleFixture(source), probeStyleFixture(rendered), readRgbFrame(source), readRgbFrame(rendered)
      ]);
      measured[name] = { source: measureReferenceRgbFrame(sourceFrame), rendered: measureReferenceRgbFrame(renderedFrame) };
      assert.deepEqual(
        { width: renderedProbe.video.width, height: renderedProbe.video.height, pixFmt: renderedProbe.video.pix_fmt, hasAudio: renderedProbe.hasAudio },
        { width: sourceProbe.video.width, height: sourceProbe.video.height, pixFmt: "yuv420p", hasAudio: false },
        `${name} remains yuv420p-safe without changing geometry or audio behavior`
      );
      assert.notDeepEqual(renderedFrame, sourceFrame, `${name} receives a measurable non-neutral B2 treatment`);
      const metrics = measured[name].rendered;
      assert.ok(metrics.lumaP05 <= metrics.lumaP50 && metrics.lumaP50 <= metrics.lumaP95, `${name} luma percentiles remain ordered`);
      for (const [field, value] of Object.entries(metrics)) {
        if (field !== "version") assert.ok(value >= 0 && value <= 1, `${name} ${field} remains normalized and bounded`);
      }
    }

    assert.ok(measured.nightPracticals.rendered.lumaP05 > measured.nightPracticals.source.lumaP05, "bounded positive black lift reveals dark practical-light detail instead of crushing it");
    assert.ok(measured.nearClippedHighlights.rendered.nearWhiteFraction <= measured.nearClippedHighlights.source.nearWhiteFraction + 0.03, "highlight roll-off does not materially increase near-white clipping");
    assert.ok(measured.alreadySaturated.rendered.saturationIndex < 0.95, "already-saturated material remains below neon-like saturation");

    const gradientSource = path.join(tempDirectory, "smoothGradient-source.mp4");
    const gradientOutput = path.join(tempDirectory, "smoothGradient-primitives-only.mp4");
    await renderStyleFixture(
      gradientSource,
      gradientOutput,
      buildReferenceStyleTreatmentFilters({ blackLift: 0.6, midtoneGamma: 0.28 })
    );
    const [sourceGradientValues, gradientValues] = await Promise.all([
      readRgbFrame(gradientSource).then((frame) => grayscaleValues(frame)),
      readRgbFrame(gradientOutput).then((frame) => grayscaleValues(frame))
    ]);
    assert.ok(new Set(gradientValues).size >= 128, "black lift and gamma retain a broad encoded gradient");
    assert.ok(
      longestRepeatedRun(gradientValues) <= longestRepeatedRun(sourceGradientValues) + 8,
      `black lift and gamma do not materially posterize the smooth gradient (source=${longestRepeatedRun(sourceGradientValues)}, rendered=${longestRepeatedRun(gradientValues)})`
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2A scratch proxy frames use the production treatment chain without a second full render", { timeout: 60_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2a-proxy-"));
  try {
    const source = path.join(tempDirectory, "source.mp4");
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", source]);
    const samples = await extractTargetReferenceFrames({ inputPath: source, duration: 3, scratchDirectory: tempDirectory, count: 3 });
    const treatment = createCanonicalReferenceStyleTreatment({ version: 2, recipe: { brightness: 0.04, contrast: 0.1, saturation: 0.06, temperature: 0.07, tint: 0, shadows: 0, highlights: 0, vibrance: 0, blackLift: 0, midtoneGamma: 0, shadowTemperature: 0, midtoneTemperature: 0, highlightTemperature: 0 } });
    const proxy = await createReferenceStyleProxyFrames({ targetFrames: samples.frames, treatment, scratchDirectory: tempDirectory, width: 256 });
    assert.equal(proxy.frames.length, 3);
    assert.deepEqual(proxy.frames.map((frame) => frame.timestamp), samples.frames.map((frame) => frame.timestamp), "proxy timestamps remain tied to the representative target samples");
    assert.ok(proxy.filters.includes("scale=256:-2"));
    for (const frame of proxy.frames) {
      const probe = await probeStyleFixture(frame.imagePath);
      assert.ok(probe.video.width <= 256 && probe.video.height <= 256, "proxy is bounded below final-video resolution");
      await stat(frame.imagePath);
    }
    const cancelled = createExecutionController();
    cancelled.cancel();
    await assert.rejects(
      createReferenceStyleProxyFrames({ targetFrames: samples.frames, treatment, scratchDirectory: tempDirectory, executionController: cancelled }),
      EditExecutionCancelledError,
      "proxy extraction observes the same exact-child cancellation controller"
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2A strong cool-mint editorial treatment remains photographic on skin highlights and smooth gradients", { timeout: 60_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2a-fidelity-"));
  const analysis = {
    safe: true,
    reference: { context: "lifestyle", peopleOrSkin: true, exposure: "high", saturation: "high", warmth: "cool" },
    target: { context: "portrait", coherent: true, peopleOrSkin: true, exposure: "medium", saturation: "low", warmth: "neutral", compatible: true },
    treatment: { exposure: "raise", exposureIntensity: "strong", contrast: "raise", contrastIntensity: "strong", blacks: "lower", blackIntensity: "standard", highlights: "raise", highlightIntensity: "strong", color: "raise", colorIntensity: "strong", warmth: "cool", warmthIntensity: "strong", ambientColorCharacter: "cool_mint", highlightCharacter: "flash", colorSeparation: "editorial", mood: "rich" }
  };
  try {
    const skinSource = path.join(tempDirectory, "skin-source.mp4");
    const skinOutput = path.join(tempDirectory, "skin-output.mp4");
    await makeStyleFixture(
      skinSource,
      "color=c=0x687070:size=320x180:rate=30,drawbox=x=48:y=18:w=224:h=144:color=0xc68759:t=fill,drawbox=x=98:y=42:w=124:h=88:color=0xedbf92:t=fill,drawbox=x=122:y=58:w=76:h=48:color=0xffd8b5:t=fill"
    );
    const skinBefore = await readRgbFrame(skinSource);
    const treatment = deriveReferenceStyleTreatment({ analysis, metrics: measureReferenceRgbFrame(skinBefore) });
    const filters = buildReferenceStyleTreatmentFilters(treatment.recipe);
    await renderStyleFixture(skinSource, skinOutput, filters);
    const skinAfter = await readRgbFrame(skinOutput);
    const cheekBefore = rgbRegionStats(skinBefore, { width: 320, height: 180, x: 128, y: 64, regionWidth: 60, regionHeight: 36 });
    const cheekAfter = rgbRegionStats(skinAfter, { width: 320, height: 180, x: 128, y: 64, regionWidth: 60, regionHeight: 36 });
    assert.notDeepEqual(skinAfter, skinBefore, "the strong reference treatment creates a visible pixel-level movement");
    assert.equal(treatment.recipe.brightness, 0.07, "small bright skin highlights cap only unsafe global exposure lift");
    assert.equal(treatment.recipe.highlights, 0, "small bright skin highlights suppress only unsafe highlight lift");
    assert.ok(cheekAfter.meanChroma >= Math.max(18, cheekBefore.meanChroma * 0.45), "skin-highlight pixels retain meaningful chroma instead of collapsing grey");
    assert.ok(cheekAfter.meanLuma < 248, "skin-highlight pixels retain headroom instead of becoming a pale clipped patch");
    for (const [minimum, maximum] of Object.values(cheekAfter.extrema)) {
      assert.ok(minimum >= 0 && maximum <= 255, "skin-highlight channels remain displayable after color balance and curves");
    }

    const gradientSource = path.join(tempDirectory, "gradient-source.mp4");
    const gradientOutput = path.join(tempDirectory, "gradient-output.mp4");
    await makeStyleFixture(gradientSource, "nullsrc=size=320x180:rate=30,geq=lum='16+219*X/W':cb=128:cr=128");
    await renderStyleFixture(gradientSource, gradientOutput, filters);
    const [gradientBefore, gradientAfter] = await Promise.all([
      readRgbFrame(gradientSource).then((frame) => grayscaleValues(frame)),
      readRgbFrame(gradientOutput).then((frame) => grayscaleValues(frame))
    ]);
    const midtoneSource = gradientBefore.slice(32, 288);
    const midtoneOutput = gradientAfter.slice(32, 288);
    assert.ok(new Set(midtoneOutput).size >= 150, "strong B2A processing retains a broad smooth-gradient midtone ramp");
    assert.ok(
      longestRepeatedRun(midtoneOutput) <= longestRepeatedRun(midtoneSource) + 5,
      "strong B2A processing does not materially posterize smooth-gradient midtones"
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2A reference color balance avoids preserve-lightness chroma collapse on a textured face region", { timeout: 60_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2a-face-ablation-"));
  const productionRecipe = {
    brightness: 0.07, contrast: 0.10, saturation: 0.16, temperature: 0.12, tint: 0,
    shadows: -0.05, highlights: 0, vibrance: 0.26, blackLift: -0.08, midtoneGamma: 0
  };
  try {
    const source = path.join(tempDirectory, "textured-face-source.mp4");
    const unsafeOutput = path.join(tempDirectory, "textured-face-unsafe.mp4");
    const safeOutput = path.join(tempDirectory, "textured-face-safe.mp4");
    await makeStyleFixture(
      source,
      "color=c=0x667175:size=320x180:rate=30,drawbox=x=95:y=22:w=130:h=138:color=0xc88761:t=fill,drawbox=x=112:y=47:w=38:h=40:color=0xe1aa82:t=fill,drawbox=x=163:y=47:w=40:h=40:color=0xe0a77e:t=fill,drawbox=x=123:y=80:w=28:h=28:color=0xf1c5a2:t=fill,drawbox=x=168:y=80:w=28:h=28:color=0xd69a70:t=fill,drawbox=x=140:y=113:w=38:h=25:color=0xaf7151:t=fill,drawgrid=width=5:height=5:thickness=1:color=0xc08060@0.08"
    );
    const safeFilters = buildReferenceStyleTreatmentFilters(productionRecipe);
    const unsafeFilters = safeFilters.map((filter) => filter.startsWith("colorbalance=") ? filter.replace(":pl=0", ":pl=1") : filter);
    assert.ok(safeFilters.find((filter) => filter.startsWith("colorbalance="))?.endsWith(":pl=0"), "B2 retains its full color-balance authority without preserve-lightness");
    assert.ok(unsafeFilters.find((filter) => filter.startsWith("colorbalance="))?.endsWith(":pl=1"), "the ablation isolates only the former preserve-lightness branch");
    await Promise.all([
      renderStyleFixture(source, unsafeOutput, unsafeFilters),
      renderStyleFixture(source, safeOutput, safeFilters)
    ]);
    const [before, unsafe, safe, safeProbe] = await Promise.all([
      readRgbFrame(source), readRgbFrame(unsafeOutput), readRgbFrame(safeOutput), probeStyleFixture(safeOutput)
    ]);
    const cheek = { width: 320, height: 180, x: 122, y: 80, regionWidth: 28, regionHeight: 28 };
    const beforeCheek = rgbRegionStats(before, cheek);
    const unsafeCheek = rgbRegionStats(unsafe, cheek);
    const safeCheek = rgbRegionStats(safe, cheek);
    assert.ok(unsafeCheek.meanChroma < beforeCheek.meanChroma * 0.15, "the former pl=1 chain reproduces the localized grey/chroma-dead cheek failure");
    assert.ok(safeCheek.meanChroma >= beforeCheek.meanChroma * 0.7, "the B2 chain retains local facial chroma rather than producing a grey patch");
    assert.ok(safeCheek.meanLuma < 248, "the protected cheek retains usable highlight headroom");
    assert.deepEqual(
      { width: safeProbe.video.width, height: safeProbe.video.height, pixFmt: safeProbe.video.pix_fmt, hasAudio: safeProbe.hasAudio },
      { width: 320, height: 180, pixFmt: "yuv420p", hasAudio: false },
      "the B2 fix keeps the production-compatible delivery format"
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B1 Vibrant Social v2 replaces the v1 saturation-plus-warm-balance path with bounded editorial energy", { timeout: 60_000 }, async () => {
  const v1Recipe = canonicalStyleRecipe({ brightness: 0.04, contrast: 0.16, saturation: 0.28, temperature: 0.03, tint: 0 });
  const v2Recipe = canonicalStyleRecipe({ brightness: 0.025, contrast: 0.06, saturation: 0.025, temperature: 0, tint: 0, shadows: 0.04, highlights: 0.03, vibrance: 0.18 });
  assert.deepEqual(resolveStyleProfile("vibrant_social", 1).recipe, v1Recipe, "v1 remains historically reproducible");
  assert.deepEqual(resolveCurrentStyleProfile("vibrant_social"), { profileId: "vibrant_social", profileVersion: 2, recipe: v2Recipe });
  for (const strength of ["subtle", "standard", "strong"]) {
    const compiled = compileStyleProfile({ profileId: "vibrant_social", strength });
    const factor = STYLE_PROFILE_STRENGTHS[strength];
    for (const field of CANONICAL_VISUAL_RECIPE_FIELDS) {
      assert.equal(compiled.recipe[field], v2Recipe[field] * factor, `v2 ${strength} interpolates ${field} from neutral`);
      assert.ok(compiled.recipe[field] >= -1 && compiled.recipe[field] <= 1, `v2 ${strength} keeps ${field} bounded`);
    }
  }
  const v1Standard = compileStyleProfile({ profileId: "vibrant_social", profileVersion: 1, strength: "standard" });
  const v2Standard = compileStyleProfile({ profileId: "vibrant_social", strength: "standard" });
  assert.deepEqual(v2Standard.recipe, canonicalStyleRecipe({
    brightness: 0.017499999999999998, contrast: 0.041999999999999996, saturation: 0.017499999999999998,
    temperature: 0, tint: 0, shadows: 0.027999999999999997, highlights: 0.020999999999999998, vibrance: 0.126
  }));
  assert.ok(v2Standard.recipe.saturation < v1Standard.recipe.saturation / 4, "v2 materially reduces global saturation");
  assert.equal(v2Standard.recipe.temperature, 0, "v2 removes the blanket warm color shift");
  assert.ok(v2Standard.recipe.vibrance > 0 && v2Standard.recipe.vibrance <= 1, "v2 carries bounded positive vibrance");
  const tonePoints = buildToneCurvePoints(v2Standard.recipe);
  assert.ok(tonePoints.shadowPoint > 0.25 && tonePoints.highlightPoint > 0.75 && tonePoints.highlightPoint > tonePoints.shadowPoint, "v2 curve remains monotonic while opening tonal structure");
  assert.deepEqual(buildStyleRecipeFilters(v2Standard.recipe), [
    "curves=master='0/0 0.25/0.2619 0.75/0.7581 1/1'",
    "eq=brightness=0.0332:contrast=1.1092:saturation=1.0829",
    "vibrance=intensity=0.1374:rbal=1:gbal=1:bbal=1:alternate=0"
  ]);
  assert.equal(buildStyleRecipeFilters(v2Standard.recipe).some((filter) => filter.startsWith("colorbalance=")), false, "v2 does not retain v1's warm colorbalance stage");

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-vibrant-social-v2-"));
  const fixtureFilters = {
    food: "color=c=0x120c0a:size=320x180:rate=30,drawbox=x=10:y=15:w=65:h=65:color=0x5a1606:t=fill,drawbox=x=90:y=15:w=65:h=65:color=0xa33a0c:t=fill,drawbox=x=170:y=15:w=65:h=65:color=0x7d4a1f:t=fill",
    skin: "color=c=0x6b3f24:size=320x180:rate=30,drawbox=x=55:y=25:w=210:h=125:color=0xc68642:t=fill,drawbox=x=105:y=50:w=110:h=75:color=0xe0ac69:t=fill",
    foliage: "color=c=0x102613:size=320x180:rate=30,drawbox=x=15:y=20:w=95:h=130:color=0x1e5d31:t=fill,drawbox=x=120:y=10:w=85:h=145:color=0x3b7e36:t=fill,drawbox=x=220:y=30:w=85:h=120:color=0x6c963c:t=fill",
    muted: "color=c=0x69645a:size=320x180:rate=30,drawbox=x=20:y=20:w=80:h=130:color=0x9d8060:t=fill,drawbox=x=120:y=20:w=80:h=130:color=0x5f8290:t=fill,drawbox=x=220:y=20:w=80:h=130:color=0x778d5d:t=fill",
    practical: "color=c=0x080b12:size=320x180:rate=30,drawbox=x=135:y=28:w=45:h=105:color=0xffd36a:t=fill,drawbox=x=205:y=45:w=25:h=65:color=0xdcecff:t=fill",
    gradient: "nullsrc=size=320x180:rate=30,geq=lum='16+219*X/W':cb=128:cr=128"
  };
  try {
    const measurements = {};
    for (const [name, filter] of Object.entries(fixtureFilters)) {
      const source = path.join(tempDirectory, `${name}-source.mp4`);
      const v1Output = path.join(tempDirectory, `${name}-v1.mp4`);
      const v2Output = path.join(tempDirectory, `${name}-v2.mp4`);
      await makeStyleFixture(source, filter);
      await renderStyleFixture(source, v1Output, buildStyleRecipeFilters(v1Standard.recipe));
      await renderStyleFixture(source, v2Output, buildStyleRecipeFilters(v2Standard.recipe));
      const [sourceProbe, v1Probe, v2Probe, sourceFrame, v1Frame, v2Frame] = await Promise.all([
        probeStyleFixture(source), probeStyleFixture(v1Output), probeStyleFixture(v2Output), readRgbFrame(source), readRgbFrame(v1Output), readRgbFrame(v2Output)
      ]);
      assert.deepEqual(
        { width: v2Probe.video.width, height: v2Probe.video.height, pix_fmt: v2Probe.video.pix_fmt, hasAudio: v2Probe.hasAudio },
        { width: sourceProbe.video.width, height: sourceProbe.video.height, pix_fmt: "yuv420p", hasAudio: false },
        `${name} v2 preserves output geometry, format, and audio behavior`
      );
      measurements[name] = { v1: rgbFixtureStats(v1Frame), v2: rgbFixtureStats(v2Frame) };
      for (const [minimum, maximum] of Object.values(measurements[name].v2.extrema)) {
        assert.ok(minimum >= 0 && maximum <= 255, `${name} v2 remains in RGB display bounds`);
      }
      assert.ok(
        upperClippedRgbSampleCount(v2Frame) <= upperClippedRgbSampleCount(sourceFrame),
        `${name} v2 does not introduce additional upper-channel clipping`
      );
    }
    assert.ok(measurements.food.v2.meanChroma > measurements.food.v1.meanChroma * 3, "v2 restores dark saturated food separation instead of v1 chroma collapse");
    assert.ok(measurements.food.v2.extrema.red[1] > measurements.food.v1.extrema.red[1], "v2 retains readable red/orange food detail");
    assert.ok(measurements.skin.v2.meanLuma > measurements.skin.v1.meanLuma, "v2 keeps skin-like midtones bright and present");
    assert.ok(measurements.foliage.v2.meanChroma > measurements.foliage.v1.meanChroma, "v2 preserves clean foliage color energy");
    assert.ok(measurements.muted.v2.meanLuma > measurements.muted.v1.meanLuma - 3, "v2 retains campaign-like midtone presence without blanket saturation pressure");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("style profiles apply source scope before sequence assembly and global scope after it", { timeout: 30_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-style-profile-order-"));
  const sourcePaths = [path.join(tempDirectory, "source-1.mp4"), path.join(tempDirectory, "source-2.mp4")];
  const media = [
    { duration: 2, width: 160, height: 90, hasAudio: true, frameRate: 30 },
    { duration: 2, width: 160, height: 90, hasAudio: true, frameRate: 30 }
  ];
  const catalog = media.map((entry, index) => ({ ...entry, sourceId: `source-${index + 1}`, index }));
  const sequence = { type: "sequence", clips: [
    { sourceId: "source-1", start: 0, end: 2 }, { sourceId: "source-2", start: 0, end: 2 }
  ] };
  try {
    await makeSolidSequenceSource(sourcePaths[0], "0x9b5f2e");
    await makeSolidSequenceSource(sourcePaths[1], "0x3f694e");
    const baselineDirectory = path.join(tempDirectory, "baseline");
    const scopedDirectory = path.join(tempDirectory, "scoped");
    const globalDirectory = path.join(tempDirectory, "global");
    await Promise.all([mkdir(baselineDirectory), mkdir(scopedDirectory), mkdir(globalDirectory)]);
    const baseline = await executeWithWatchdog({
      inputPaths: sourcePaths, media, sourceCatalog: catalog, tempDirectory: baselineDirectory,
      plan: { version: "2", operations: [sequence] }
    }, { watchdogMs: 20_000 });
    const sourceScopedPlan = { version: "2", operations: [sequence, { type: "style_profile", sourceId: "source-1", profileId: "dark_moody", strength: "strong" }] };
    validateEditPlan(sourceScopedPlan, { sourceCatalog: catalog });
    const sourceScoped = await executeWithWatchdog({
      inputPaths: sourcePaths, media, sourceCatalog: catalog, tempDirectory: scopedDirectory, plan: sourceScopedPlan
    }, { watchdogMs: 20_000 });
    const globalPlan = { version: "2", operations: [sequence, { type: "style_profile", profileId: "dark_moody", strength: "strong" }] };
    validateEditPlan(globalPlan, { sourceCatalog: catalog });
    const global = await executeWithWatchdog({
      inputPaths: sourcePaths, media, sourceCatalog: catalog, tempDirectory: globalDirectory, plan: globalPlan
    }, { watchdogMs: 20_000 });

    const firstScopedDifference = await videoFrameDifference(baseline, sourceScoped, 0.5);
    const secondScopedDifference = await videoFrameDifference(baseline, sourceScoped, 2.5);
    assert.ok(firstScopedDifference > 5_000, "source-1 profile should visibly affect its pre-assembly segment");
    assert.ok(secondScopedDifference < 500, "source-2 segment should remain materially unchanged by a source-1 profile");
    const firstGlobalDifference = await videoFrameDifference(baseline, global, 0.5);
    const secondGlobalDifference = await videoFrameDifference(baseline, global, 2.5);
    assert.ok(firstGlobalDifference > 5_000, "global profile should affect the first assembled segment");
    assert.ok(secondGlobalDifference > 5_000, "global profile should affect the second assembled segment");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("server-owned audio controls parse and reconcile deterministic 3B-C prompts", () => {
  assert.deepEqual(extractAudioControlIntent("Mute the video."), { volume: { type: "audio_volume", factor: 0 } });
  assert.deepEqual(extractAudioControlIntent("Reduce the volume to 50%."), { volume: { type: "audio_volume", factor: 0.5 } });
  assert.deepEqual(extractAudioControlIntent("Set the audio volume to 120%."), { volume: { type: "audio_volume", factor: 1.2 } });
  assert.deepEqual(extractAudioControlIntent("Make the audio quieter."), { volume: { type: "audio_volume", factor: 0.5 } });
  assert.deepEqual(extractAudioControlIntent("Make the audio louder."), { volume: { type: "audio_volume", factor: 1.5 } });
  assert.deepEqual(extractAudioControlIntent("Lower the volume."), { volume: { type: "audio_volume", factor: 0.5 } });
  assert.deepEqual(extractAudioControlIntent("Decrease the volume."), { volume: { type: "audio_volume", factor: 0.5 } });
  assert.deepEqual(extractAudioControlIntent("Increase the volume."), { volume: { type: "audio_volume", factor: 1.5 } });
  assert.deepEqual(extractAudioControlIntent("Turn the volume down."), { volume: { type: "audio_volume", factor: 0.5 } });
  assert.deepEqual(extractAudioControlIntent("Turn the volume up."), { volume: { type: "audio_volume", factor: 1.5 } });
  assert.deepEqual(extractAudioControlIntent("Fade the audio in at the beginning."), { fade: { type: "audio_fade", mode: "in", duration: 1 } });
  assert.deepEqual(extractAudioControlIntent("Fade the audio out at the end."), { fade: { type: "audio_fade", mode: "out", duration: 1 } });
  assert.deepEqual(extractAudioControlIntent("Fade the audio in and out."), { fade: { type: "audio_fade", mode: "both", duration: 1 } });

  const reconciled = reconcileAudioControls({ version: "1", operations: [
    { type: "fade", mode: "out", duration: 1 }, { type: "audio_volume", factor: 1 }
  ] }, "Reduce the volume to 50% and fade the audio out at the end.");
  assert.deepEqual(reconciled.operations, [
    { type: "audio_volume", factor: 0.5 }, { type: "audio_fade", mode: "out", duration: 1 }
  ]);
  assert.equal(extractAudioControlIntent("Fade out at the end."), null);
  assert.equal(extractAudioControlIntent("Increase audio speed."), null);
  assert.equal(extractAudioControlIntent("Lower audio pitch."), null);
  assert.equal(extractAudioControlIntent("Increase audio quality."), null);
  assert.deepEqual(createEditPlan({ prompt: "Fade out at the end." }).operations, [{ type: "fade", mode: "out", duration: 1 }]);
  assert.deepEqual(createEditPlan({ prompt: "Fade the audio out at the end." }).operations, [{ type: "audio_fade", mode: "out", duration: 1 }]);
  assert.equal(extractAudioControlIntent("Add background music."), null);
});

test("audio controls validate as global singleton final-output operations", () => {
  assert.doesNotThrow(() => validateEditPlan({ version: "1", operations: [{ type: "audio_volume", factor: 0 }] }));
  assert.doesNotThrow(() => validateEditPlan({ version: "1", operations: [{ type: "audio_volume", factor: 2 }, { type: "audio_fade", mode: "both", duration: 1 }] }));
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "audio_volume", factor: -0.1 }] }), /audio volume factor/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "audio_volume", factor: 2.1 }] }), /audio volume factor/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "audio_volume", factor: Number.NaN }] }), /audio volume factor/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "audio_volume", factor: 1 }, { type: "audio_volume", factor: 0.5 }] }), /only one audio_volume/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "audio_fade", mode: "sideways", duration: 1 }] }), /audio fade mode/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "audio_fade", mode: "in", duration: 0 }] }), /audio fade duration/);
  assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "audio_fade", mode: "in", duration: 1 }, { type: "audio_fade", mode: "out", duration: 1 }] }), /only one audio_fade/);
  assert.throws(() => validateEditPlan({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 2 }] }, { type: "audio_volume", sourceId: "source-1", factor: 1 }] }, { sourceCatalog: [{ sourceId: "source-1", duration: 2 }] }), /sourceId/);
});

test("deterministic and Gemini planning preserve global audio controls", async () => {
  const timedSources = sourceCatalog.slice(0, 2);
  const deterministic = createEditPlan({
    prompt: "Use the first 3 seconds of source-1, then the first 3 seconds of source-2 and make the audio quieter.",
    hasMultipleVideos: true, sourceCatalog: timedSources
  });
  assert.equal(deterministic.version, "2");
  assert.deepEqual(deterministic.operations.at(-1), { type: "audio_volume", factor: 0.5 });
  validateEditPlan(deterministic, { sourceCatalog: timedSources });

  const aiClient = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [] }) });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: "Fade the audio out at the end.", sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient
  }));
  assert.deepEqual(result.plan.operations, [{ type: "audio_fade", mode: "out", duration: 1 }]);
  assert.equal(aiClient.requests.length, 1);
});

test("executor applies audio-only controls without changing video pixels", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-audio-controls-"));
  const inputPath = path.join(tempDirectory, "source.mp4");
  const catalog = [{ sourceId: "source-1", index: 0, duration: 4, hasAudio: true }];
  const media = [{ duration: 4, width: 160, height: 90, hasAudio: true, frameRate: 30 }];
  try {
    await makeMixedFrameRateSource(inputPath, 30, 4);
    const baseline = await executeWithWatchdog({ inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory, plan: { version: "1", operations: [] } }, { watchdogMs: 15_000 });
    const controlledDirectory = path.join(tempDirectory, "controlled");
    await mkdir(controlledDirectory);
    const controlled = await executeWithWatchdog({
      inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory: controlledDirectory,
      plan: { version: "1", operations: [{ type: "audio_volume", factor: 0.5 }, { type: "audio_fade", mode: "out", duration: 1 }] }
    }, { watchdogMs: 15_000 });
    const mutedDirectory = path.join(tempDirectory, "muted");
    await mkdir(mutedDirectory);
    const muted = await executeWithWatchdog({
      inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory: mutedDirectory,
      plan: { version: "1", operations: [{ type: "audio_volume", factor: 0 }] }
    }, { watchdogMs: 15_000 });

    assert.ok((await probeRenderedVideo(controlled)).audio);
    const baselineLevel = await audioMaxVolume(baseline, { start: 1, duration: 1 });
    const controlledLevel = await audioMaxVolume(controlled, { start: 1, duration: 1 });
    const fadedLevel = await audioMaxVolume(controlled, { start: 3.8, duration: 0.15 });
    assert.ok(controlledLevel < baselineLevel - 4, "0.5 volume should measurably reduce amplitude");
    assert.ok(fadedLevel < controlledLevel - 8, "audio fade-out should reduce amplitude at the final boundary");
    assert.equal(await videoFrameDifference(baseline, controlled), 0, "audio-only controls must stream-copy video pixels");
    assert.ok(await audioMaxVolume(muted) < -80, "mute should keep a valid effectively silent audio stream");

    const temporalDirectory = path.join(tempDirectory, "temporal");
    await mkdir(temporalDirectory);
    const temporal = await executeWithWatchdog({
      inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory: temporalDirectory,
      plan: { version: "1", operations: [{ type: "trim", start: 1, end: 4 }, { type: "speed", factor: 1.5 }, { type: "audio_fade", mode: "out", duration: 1 }] }
    }, { watchdogMs: 15_000 });
    assert.ok((await probeRenderedVideo(temporal)).duration > 1.9 && (await probeRenderedVideo(temporal)).duration < 2.1);
    assert.ok(await audioMaxVolume(temporal, { start: 1.9, duration: 0.08 }) < -20, "audio fade should use the post-trim/post-speed final timeline");
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
});

test("mixed 24fps and 30fps sequence concat preserves a bounded VFR output", { timeout: 15_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-mixed-fps-"));
  const sourcePaths = [path.join(tempDirectory, "source-24.mp4"), path.join(tempDirectory, "source-30.mp4")];
  try {
    await makeMixedFrameRateSource(sourcePaths[0], 24, 4);
    await makeMixedFrameRateSource(sourcePaths[1], 30, 10);
    const media = [
      { duration: 4, width: 160, height: 90, hasAudio: true, frameRate: 24 },
      { duration: 10, width: 160, height: 90, hasAudio: true, frameRate: 30 }
    ];
    const catalog = media.map((entry, index) => ({ ...entry, sourceId: `source-${index + 1}`, index }));
    const startedAt = Date.now();
    const renderedPath = await executeWithWatchdog({
      inputPaths: sourcePaths,
      media,
      sourceCatalog: catalog,
      tempDirectory,
      plan: {
        version: "2",
        operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 4 }, { sourceId: "source-2", start: 0, end: 10 }] }]
      }
    });
    assert.equal(renderedPath, path.join(tempDirectory, "sequence.mp4"));
    assert.ok(Date.now() - startedAt < 10_000, "mixed-FPS render should complete quickly");
    const outputStats = await stat(renderedPath);
    assert.ok(outputStats.size > 0 && outputStats.size < 5 * 1024 * 1024, "output should remain bounded");
    const { duration, video, audio } = await probeRenderedVideo(renderedPath);
    assert.ok(duration > 13.8 && duration < 14.3, `unexpected output duration: ${duration}`);
    assert.ok(video, "output should include video");
    assert.ok(audio, "output should include audio");
    assert.ok(Number(video.nb_frames) > 350 && Number(video.nb_frames) < 600, `unexpected video frame count: ${video.nb_frames}`);
    const [numerator, denominator] = video.avg_frame_rate.split("/").map(Number);
    assert.ok(Number.isFinite(numerator / denominator) && numerator / denominator > 0 && numerator / denominator < 100, `unexpected video frame rate: ${video.avg_frame_rate}`);
    assert.match(video.time_base, /^\d+\/\d+$/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("mixed-FPS sequence remains playable through global black and white", { timeout: 15_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-mixed-fps-color-"));
  const sourcePaths = [path.join(tempDirectory, "source-24.mp4"), path.join(tempDirectory, "source-30.mp4")];
  try {
    await makeMixedFrameRateSource(sourcePaths[0], 24, 1);
    await makeMixedFrameRateSource(sourcePaths[1], 30, 1);
    const media = [
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 24 },
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 30 }
    ];
    const catalog = media.map((entry, index) => ({ ...entry, sourceId: `source-${index + 1}`, index }));
    const renderedPath = await executeWithWatchdog({
      inputPaths: sourcePaths,
      media,
      sourceCatalog: catalog,
      tempDirectory,
      plan: {
        version: "2",
        operations: [
          { type: "sequence", clips: [{ sourceId: "source-1", start: 0, end: 1 }, { sourceId: "source-2", start: 0, end: 1 }] },
          // Compatibility only: downstream filters may choose their own output cadence.
          { type: "color_grade", style: "bw" }
        ]
      }
    });
    const outputStats = await stat(renderedPath);
    const { duration, video, audio } = await probeRenderedVideo(renderedPath);
    assert.ok(outputStats.size > 0 && outputStats.size < 2 * 1024 * 1024, "processed output should remain bounded");
    assert.ok(duration > 1.8 && duration < 2.2, `unexpected processed duration: ${duration}`);
    assert.ok(video && audio, "processed output should retain video and audio");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

function titlePlan(operation, { version = "1" } = {}) {
  return { version, operations: [operation] };
}

test("title typography normalizes legacy and rich title plans through the registered catalog", () => {
  const legacy = titlePlan({
    type: "title", text: "Trip to Kerala", start: 0, end: 3,
    position: "bottom", size: "medium", color: "white", weight: "regular", font: "instrumentSerif"
  });
  validateEditPlan(legacy);
  assert.equal(legacy.operations[0].position, "bottom-center");
  assert.equal(legacy.operations[0].font, "instrumentSerif");
  assert.deepEqual(legacy.operations[0].runs, [{ text: "Trip to Kerala", font: "instrumentSerif", size: "medium", color: "#FFFFFF", weight: "regular" }]);

  const rich = titlePlan({
    type: "title", text: "Trip to Kerala", start: 0.25, end: 3,
    position: "bottom-right", size: "medium", color: "white", weight: "regular", font: "inter",
    runs: [
      { text: "Trip to ", font: "inter", size: "medium", color: "#FFFFFF", weight: "regular" },
      { text: "Kerala", fontIntent: "elegant classy", size: 58, color: "#677dec", weight: "bold" }
    ]
  });
  validateEditPlan(rich);
  assert.deepEqual(rich.operations[0].runs[1], { text: "Kerala", font: "instrumentSerif", size: 58, color: "#677DEC", weight: "bold" });
  assert.equal(resolveFontId("Instrument Serif"), "instrumentSerif");
  assert.equal(resolveFontId("Barlow Condensed"), "barlowCondensed");
  assert.equal(resolveFontId("Comic Sans"), null);
  assert.equal(resolveSemanticFontIntent("gaming fun"), "jetbrainsMono");
  assert.ok(Object.values(FONT_CATALOG).every((font) => font.files.regular));
  assert.match(buildAiEditorPrompt({ prompt: "Add a title", sourceCatalog: [] }), /Title timestamps use the final assembled output timeline/);
  assert.deepEqual(parseTitle('Add the title "Kerala" at 0:03 in a large font.'), {
    text: '"Kerala"', start: 3, end: 6, position: "center", size: "large", color: "white", weight: "regular", font: "inter"
  });
  assert.equal(parseTitle('Add the title "Kerala" using Comic Sans font.').font, "__unavailable__");
});

test("title typography rejects unsupported renderer values and inconsistent rich runs", () => {
  const base = { type: "title", text: "Kerala", start: 0, end: 1, position: "center", size: "medium", color: "white", weight: "regular", font: "inter" };
  for (const operation of [
    { ...base, color: "#12FG00" },
    { ...base, font: "Comic Sans" },
    { ...base, size: 999 },
    { ...base, position: "middle-ish" },
    { ...base, start: 2, end: 1 },
    { ...base, runs: [{ text: "Different" }] }
  ]) {
    assert.throws(() => validateEditPlan(titlePlan(operation)), /Invalid edit plan/);
  }
});

test("ASS title rendering escapes control-like text while preserving Unicode and independent runs", () => {
  const document = buildAssDocument([{
    text: "Hello ｛world｝ Kerala",
    start: 0.25, end: 1.75, position: "top-left",
    runs: [
      { text: "Hello {\\pos(1,1)} ", font: "inter", size: 32, color: "#FFFFFF", weight: "regular" },
      { text: "കേരള", font: "instrumentSerif", size: 44, color: "#45A049", weight: "bold" }
    ]
  }], { width: 640, height: 360 });
  assert.match(document, /Dialogue: 0,0:00:00\.25,0:00:01\.75/);
  assert.match(document, /\\fnInter\\fs32\\c&H00FFFFFF&\\b0/);
  assert.match(document, /\\fnInstrument Serif\\fs44\\c&H0049A045&\\b1/);
  assert.match(document, /｛＼pos\(1,1\)｝/);
  assert.match(document, /കേരള/);
  assert.doesNotMatch(document, /\}\{\\pos\(1,1\)/);
});

test("rich ASS titles render after a sequence and temporal trim on the final output timeline", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-title-render-"));
  const sourcePaths = [path.join(tempDirectory, "one.mp4"), path.join(tempDirectory, "two.mp4")];
  try {
    await makeMixedFrameRateSource(sourcePaths[0], 24, 1);
    await makeMixedFrameRateSource(sourcePaths[1], 30, 1);
    const media = [
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 24 },
      { duration: 1, width: 160, height: 90, hasAudio: true, frameRate: 30 }
    ];
    const catalog = media.map((entry, index) => ({ ...entry, sourceId: `source-${index + 1}`, index }));
    const plan = {
      version: "2",
      operations: [
        { type: "sequence", clips: [{ sourceId: "source-2", start: 0, end: 1 }, { sourceId: "source-1", start: 0, end: 1 }] },
        { type: "trim", start: 0.25, end: 1.75 },
        {
          type: "title", text: "Trip to Kerala", start: 0.25, end: 1.1,
          position: "bottom-right", size: "medium", color: "white", weight: "regular", font: "inter",
          runs: [
            { text: "Trip to ", font: "inter", size: 24, color: "#FFFFFF", weight: "regular" },
            { text: "Kerala", font: "instrumentSerif", size: 36, color: "#45A049", weight: "bold" }
          ]
        }
      ]
    };
    validateEditPlan(plan, { sourceCatalog: catalog });
    const output = await executeWithWatchdog({ inputPaths: sourcePaths, media, sourceCatalog: catalog, tempDirectory, plan }, { watchdogMs: 15_000 });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    const { duration, video, audio } = await probeRenderedVideo(output);
    assert.match(ass, /Dialogue: 0,0:00:00\.25,0:00:01\.10/);
    assert.match(ass, /\\fnInter/);
    assert.match(ass, /\\fnInstrument Serif/);
    assert.ok(duration > 1.35 && duration < 1.65, `unexpected title render duration: ${duration}`);
    assert.ok(video && audio, "rich title output should remain playable with audio");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2B target-aware title readability samples a bright final frame and keeps its ASS protection understated", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2b-title-readability-"));
  const sourcePath = path.join(tempDirectory, "bright.mp4");
  try {
    await makeSolidSequenceSource(sourcePath, "white", 2);
    const media = [{ duration: 2, width: 160, height: 90, hasAudio: true, frameRate: 30 }];
    const plan = {
      version: "1",
      operations: [{
        type: "title", text: "Kerala", start: 0.5, end: 1.5, position: "bottom-center", size: "medium", color: "white", weight: "regular", font: "instrumentSerif",
        readability: { mode: "target_aware" },
        runs: [{ text: "Kerala", font: "instrumentSerif", size: "medium", color: "#FFFFFF", weight: "regular" }]
      }]
    };
    validateEditPlan(plan);
    const output = await executeWithWatchdog({ inputPaths: [sourcePath], media, tempDirectory, plan }, { watchdogMs: 15_000 });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    const { video, audio } = await probeRenderedVideo(output);
    assert.match(ass, /\\bord1\.45\\shad0\.3\\3c&H55000000&/, "bright footage gets bounded readability contrast without a box");
    assert.ok(video && audio, "target-aware title output remains playable");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("B2B condensed all-caps hero display titles load through real FFmpeg/libass rendering", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-b2b-condensed-title-"));
  const sourcePath = path.join(tempDirectory, "source.mp4");
  try {
    await makeSolidCaptionSource(sourcePath, 2, { width: 854, height: 480 });
    const media = [{ duration: 2, width: 854, height: 480, hasAudio: true, frameRate: 30 }];
    const plan = {
      version: "1",
      operations: [{
        type: "title", text: "The Journey Begins", start: 0, end: 1.5, position: "upper-third", size: "large", color: "white", weight: "bold", font: "barlowCondensed", renderCaseStyle: "uppercase", presentation: "hero_display",
        runs: [{ text: "The Journey Begins", font: "barlowCondensed", size: "large", color: "#FFFFFF", weight: "bold" }]
      }]
    };
    validateEditPlan(plan);
    const output = await executeWithWatchdog({ inputPaths: [sourcePath], media, tempDirectory, plan }, { watchdogMs: 15_000 });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.match(ass, /\\an8\\pos\(427,106\).*\\fnBarlow Condensed ExtraBold\\fs67\\c&H00FFFFFF&\\b1\}THE JOURNEY BEGINS/);
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "verbose", "-i", sourcePath,
      "-vf", buildAssFilter(path.join(tempDirectory, "title-layers.ass")), "-frames:v", "1", "-f", "null", "-"
    ]);
    assert.match(stderr, /Barlow Condensed ExtraBold/, "libass selects the bundled ExtraBold display face rather than a generic bold fallback");
    assert.ok(await videoFrameDifference(sourcePath, output, 1) > 100_000, "the self-hosted condensed display font visibly renders through libass");
    assert.ok((await probeRenderedVideo(output)).video);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("captions segment canonical transcript words into readable server-owned cues", () => {
  const cues = createCaptionCues(createCanonicalTranscript({ sourceId: "source-1", duration: 10, words: [
    { text: "Welcome", start: 0, end: 0.3 }, { text: "to", start: 0.3, end: 0.45 }, { text: "Kerala.", start: 0.45, end: 0.9 },
    { text: "This", start: 2, end: 2.2 }, { text: "is", start: 2.2, end: 2.35 }, { text: "Cliponaut.", start: 2.35, end: 2.9 }
  ] }));
  assert.deepEqual(cues, [
    { sourceId: "source-1", text: "Welcome to Kerala.", start: 0, end: 0.9 },
    { sourceId: "source-1", text: "This is Cliponaut.", start: 2, end: 2.9 }
  ]);
  assert.deepEqual(createCaptionCues({ sourceId: "source-2", segments: [] }), []);
});

test("caption timing maps source cues through repeated V2 clips, trim, and speed", () => {
  const catalog = [{ sourceId: "source-1", index: 0, duration: 10, hasAudio: true }];
  const cues = [{ sourceId: "source-1", text: "Hello", start: 2, end: 4 }];
  const repeated = { version: "2", operations: [{ type: "sequence", clips: [
    { sourceId: "source-1", start: 0, end: 5 }, { sourceId: "source-1", start: 1, end: 5 }
  ] }] };
  assert.deepEqual(mapCaptionCuesToOutput(cues, repeated, catalog), [
    { text: "Hello", start: 2, end: 4 }, { text: "Hello", start: 6, end: 8 }
  ]);
  const temporal = { version: "2", operations: [...repeated.operations, { type: "trim", start: 1, end: 7 }, { type: "speed", factor: 2 }] };
  assert.deepEqual(mapCaptionCuesToOutput(cues, temporal, catalog), [
    { text: "Hello", start: 0.5, end: 1.5 }, { text: "Hello", start: 2.5, end: 3 }
  ]);
  const ranged = { version: "1", operations: [{ type: "speed", start: 1, end: 3, factor: 2 }] };
  assert.deepEqual(mapCaptionCuesToOutput(cues, ranged, catalog), [
    { text: "Hello", start: 1.5, end: 2 }, { text: "Hello", start: 2, end: 3 }
  ]);
});

test("caption corrections preserve timings and reject unsafe no-match or ambiguous replacements", () => {
  const cues = [
    { text: "I am the founder of clip or not", start: 6.5, end: 7.5 },
    { text: "Clip or not helps editors", start: 8, end: 9 }
  ];
  const corrected = applyCaptionCorrection(cues, { from: "I am the founder of Cliponaut", to: "I am the founder of Cliponaut", scope: "one", at: 7 });
  assert.equal(corrected[0].text, "I am the founder of Cliponaut");
  assert.deepEqual(corrected.map(({ start, end }) => ({ start, end })), cues.map(({ start, end }) => ({ start, end })));
  const everywhere = applyCaptionCorrection(cues, { from: "clip or not", to: "Cliponaut", scope: "all" });
  assert.deepEqual(everywhere.map((cue) => cue.text), ["I am the founder of Cliponaut", "Cliponaut helps editors"]);
  assert.throws(() => applyCaptionCorrection(cues, { from: "clip or not", to: "Cliponaut", scope: "one" }),
    (error) => error instanceof CaptionError && error.message === "CAPTION_CORRECTION_AMBIGUOUS");
  assert.throws(() => applyCaptionCorrection(cues, { from: "missing", to: "new", scope: "one" }),
    (error) => error instanceof CaptionError && error.message === "CAPTION_CORRECTION_NO_MATCH");
  assert.throws(() => applyCaptionCorrection(cues, { from: "missing", to: "new", scope: "all" }),
    (error) => error instanceof CaptionError && error.message === "CAPTION_CORRECTION_NO_MATCH");
  assert.deepEqual(extractCaptionCorrection('Change "clip or not" everywhere to "Cliponaut" in the video.'), { from: "clip or not", to: "Cliponaut", scope: "all" });
  assert.deepEqual(extractCaptionCorrection("Change clip or not everywhere to Cliponaut in the video"), { from: "clip or not", to: "Cliponaut", scope: "all" });
  assert.equal(requestsCaptions("Change clip or not everywhere to Cliponaut in the video"), true);
  assert.equal(requestsCaptions('Change "clip or not" everywhere to "Cliponaut" in the video.'), true);
});

test("caption correction parsing supports targeted subtitle and sentence wording", () => {
  const expected = { from: "I am the founder of clip or not", to: "I am the founder of Cliponaut", scope: "one", at: 7 };
  assert.deepEqual(extractCaptionCorrection("Change the subtitle or sentence 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection('Change the subtitle "I am the founder of clip or not" to "I am the founder of Cliponaut" at 0:07'), expected);
  assert.deepEqual(extractCaptionCorrection("Change the sentence 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection("Change the subtitle 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection("Change the subtitle or sentence ‘I am the founder of clip or not’ to ‘I am the founder of Cliponaut’ at 0:07"), expected);
  assert.deepEqual(extractCaptionCorrection('Change the sentence “I am the founder of clip or not” to “I am the founder of Cliponaut” at 0:07'), expected);
  assert.equal(requestsCaptions("Change the sentence 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07"), true);
});

test("recognized caption corrections survive an empty Gemini plan while unrelated requests remain unsupported", async () => {
  const prompts = [
    "Change the subtitle or sentence 'I am the founder of clip or not' to 'I am the founder of Cliponaut' at 0:07",
    "Change clip or not everywhere to Cliponaut in the video"
  ];
  for (const prompt of prompts) {
    const result = await withGeminiKey(() => createAiEditPlan({
      prompt, sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]),
      aiClient: createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [] }) })
    }));
    assert.deepEqual(result.plan.operations, [{ type: "captions" }]);
  }
  await withGeminiKey(() => assert.rejects(
    () => createAiEditPlan({
      prompt: "Make this video feel magical", sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]),
      aiClient: createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [] }) })
    }),
    UnsupportedEditRequestError
  ));
});

test("caption intent reconciliation preserves explicit prompt styling after Gemini planning", async () => {
  const prompt = "Add subtitles using Inter, #677DEC, larger text at the bottom center";
  const explicitStyle = { font: "inter", color: "#677DEC", size: "large", position: "bottom-center" };
  assert.deepEqual(extractCaptionStyleRequest(prompt), explicitStyle);
  assert.deepEqual(createEditPlan({ prompt }).operations.find((operation) => operation.type === "captions"), { type: "captions", ...explicitStyle });
  assert.equal(createEditPlan({ prompt: "Add subtitles" }).operations.filter((operation) => operation.type === "captions").length, 1);
  assert.equal(createEditPlan({ prompt: 'Change the subtitle "old text" to "new text" at 0:07' }).operations.filter((operation) => operation.type === "captions").length, 1);

  const omitted = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] }) });
  const omittedResult = await withGeminiKey(() => createAiEditPlan({
    prompt, sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: omitted
  }));
  assert.deepEqual(omittedResult.plan.operations, [{ type: "color_grade", style: "bw" }, { type: "captions", ...explicitStyle }]);

  const conflicting = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{
    type: "captions", font: "jetbrainsMono", fontIntent: "serif", color: "#E94B4B", size: "small", position: "top-left", weight: "bold"
  }] }) });
  const conflictResult = await withGeminiKey(() => createAiEditPlan({
    prompt, sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: conflicting
  }));
  assert.deepEqual(conflictResult.plan.operations, [{ type: "captions", ...explicitStyle, weight: "bold" }]);

  const unspecified = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{
    type: "captions", font: "instrumentSerif", color: "#F6D365", size: "small", position: "top-left", weight: "bold"
  }] }) });
  const unspecifiedResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "Add subtitles", sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: unspecified
  }));
  assert.deepEqual(unspecifiedResult.plan.operations, [{
    type: "captions", font: "instrumentSerif", color: "#F6D365", size: "small", position: "top-left", weight: "bold"
  }]);

  const nonCaption = createMockGemini({ responseText: JSON.stringify({ version: "1", operations: [{ type: "color_grade", style: "bw" }] }) });
  const nonCaptionResult = await withGeminiKey(() => createAiEditPlan({
    prompt: "Make the video black and white", sourceCatalog: [sourceCatalog[0]], sourceInputs: plannerSources([sourceCatalog[0]]), aiClient: nonCaption
  }));
  assert.equal(nonCaptionResult.plan.operations.some((operation) => operation.type === "captions"), false);
});

test("styled captions preserve dialogue events and render with server-owned final cues", { timeout: 15_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-caption-render-"));
  const inputPath = path.join(tempDirectory, "source.mp4");
  try {
    await makeMixedFrameRateSource(inputPath, 30, 2);
    const media = [{ duration: 2, width: 160, height: 90, hasAudio: true, frameRate: 30 }];
    const plan = { version: "1", operations: [
      { type: "title", text: "Existing title", start: 0.1, end: 0.5, position: "top-center", size: "small", color: "white", weight: "bold", font: "inter" },
      { type: "captions", font: "inter", position: "bottom-center", size: "large", color: "#677DEC", weight: "regular" }
    ] };
    validateEditPlan(plan);
    assert.deepEqual(plan.operations[1], { type: "captions", font: "inter", position: "bottom-center", size: "large", color: "#677DEC", weight: "regular" });
    assert.throws(() => validateEditPlan({ version: "1", operations: [{ type: "captions" }, { type: "captions" }] }), /only one captions/);
    const sourceCatalog = [{ sourceId: "source-1", index: 0, duration: 2, hasAudio: true }];
    const output = await executeWithWatchdog({ inputPaths: [inputPath], media, sourceCatalog, tempDirectory, plan, captionCues: [{ sourceId: "source-1", text: "കേരള {\\pos(1,1)}", start: 0.2, end: 1.2 }] });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.equal(ass.match(/^Dialogue: /gm)?.length, 2);
    assert.match(ass, /^Dialogue: /m);
    assert.match(ass, /\\an2\\pos\(80,76\)/);
    assert.match(ass, /\\fnInter\\fs9/);
    assert.match(ass, /കേരള ｛＼pos\(1,1\)｝/);
    assert.match(ass, /\\c&H00EC7D67&/);
    assert.ok((await stat(output)).size > 0);
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
});

test("default and production-styled captions visibly alter final pixels at local and production canvas sizes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-caption-pixels-"));
  const sourceCatalog = [{ sourceId: "source-1", index: 0, duration: 4, hasAudio: true }];
  const cue = [{ sourceId: "source-1", text: "Cliponaut caption test", start: 1, end: 3 }];
  try {
    for (const { width, height } of [{ width: 1280, height: 720 }, { width: 854, height: 480 }]) {
      const inputPath = path.join(root, `source-${width}x${height}.mp4`);
      const media = [{ duration: 4, width, height, hasAudio: true, frameRate: 30 }];
      await makeSolidCaptionSource(inputPath, 4, { width, height });
      for (const [name, operation] of [
        ["default", { type: "captions", font: "inter", color: "#FFFFFF", size: "medium", position: "bottom-center", weight: "regular" }],
        ["styled", { type: "captions", font: "inter", color: "#677DEC", size: "large", position: "bottom-center", weight: "regular" }]
      ]) {
        const tempDirectory = path.join(root, `${width}x${height}-${name}`);
        await mkdir(tempDirectory);
        const output = await executeWithWatchdog({
          inputPaths: [inputPath], media, sourceCatalog, tempDirectory,
          plan: { version: "1", operations: [operation] }, captionCues: cue
        }, { watchdogMs: 20_000 });
        const duringDifference = await captionRegionDifference(output, 0.5, 2);
        const outsideCueDifference = await captionRegionDifference(output, 0.5, 3.5);
        assert.ok(duringDifference > 50_000, `${width}x${height} ${name} caption should visibly alter the bottom-center region`);
        assert.ok(outsideCueDifference < 5_000, `${width}x${height} ${name} caption should not alter the region outside its cue window`);
        if (name === "styled") {
          const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
          assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.00/);
          assert.match(ass, new RegExp(`\\\\fnInter\\\\fs${Math.round(height * 0.1)}\\\\c&H00EC7D67&`));
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("executor renders global-speed captions on the final output timeline", { timeout: 20_000 }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cliponaut-caption-speed-"));
  const inputPath = path.join(tempDirectory, "source.mp4");
  try {
    await makeMixedFrameRateSource(inputPath, 30, 15);
    const media = [{ duration: 15, width: 160, height: 90, hasAudio: true, frameRate: 30 }];
    const catalog = [{ sourceId: "source-1", index: 0, duration: 15, hasAudio: true }];
    const plan = { version: "1", operations: [{ type: "speed", factor: 1.5 }, { type: "captions" }] };
    validateEditPlan(plan, { sourceCatalog: catalog });
    const output = await executeWithWatchdog({
      inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory, plan,
      captionCues: [{ sourceId: "source-1", text: "Caption at ten seconds", start: 10, end: 11 }]
    }, { watchdogMs: 15_000 });
    const ass = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.match(ass, /Dialogue: 0,0:00:06\.67,0:00:07\.33/);
    assert.ok((await probeRenderedVideo(output)).duration > 9.9 && (await probeRenderedVideo(output)).duration < 10.1);
    const trimPlan = { version: "1", operations: [{ type: "trim", start: 5, end: 15 }, { type: "captions" }] };
    validateEditPlan(trimPlan, { sourceCatalog: catalog });
    const trimmed = await executeWithWatchdog({
      inputPaths: [inputPath], media, sourceCatalog: catalog, tempDirectory, plan: trimPlan,
      captionCues: [{ sourceId: "source-1", text: "Caption at ten seconds", start: 10, end: 11 }]
    }, { watchdogMs: 15_000 });
    const trimAss = await readFile(path.join(tempDirectory, "title-layers.ass"), "utf8");
    assert.match(trimAss, /Dialogue: 0,0:00:05\.00,0:00:06\.00/);
    assert.ok((await probeRenderedVideo(trimmed)).duration > 9.9 && (await probeRenderedVideo(trimmed)).duration < 10.1);
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
});

test("spoken selection retains its job-local transcript for caption reuse", async () => {
  const catalog = speechCatalog([sourceCatalog[0]]);
  const aiClient = createMockGemini({
    responses: [JSON.stringify({ version: "1", operations: [{ type: "captions" }] })],
    transcriptionInteractions: [interaction([{ text: "Welcome", start_offset: "1s", end_offset: "1.4s" }])]
  });
  const result = await withGeminiKey(() => createAiEditPlan({
    prompt: 'Use the part where I say "Welcome" and add subtitles.', sourceCatalog: catalog,
    sourceInputs: plannerSources(catalog), aiClient, scratchDirectory: "/scratch",
    transcriptionOptions: { spawn: successfulSpawn(), remove: async () => {} }
  }));
  assert.equal(aiClient.interactionRequests.length, 1);
  assert.equal(result.transcripts.get("source-1").segments[0].text, "Welcome");
  assert.ok(result.plan.operations.some((operation) => operation.type === "captions"));
});
