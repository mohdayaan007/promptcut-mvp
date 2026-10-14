import { COLOR_PRESETS } from "@/lib/color-presets";
import { COLOR_MAP, FONT_CATALOG, POSITION_MAP, SIZE_MAP, TITLE_SIZE_LIMITS } from "@/lib/title-config";
import { STYLE_PROFILE_CONSTRAINTS, STYLE_PROFILE_IDS, STYLE_PROFILE_STRENGTHS } from "@/lib/editor-core/style-profiles";

export const CAPABILITY_LIMITS = {
  zoom: { minAmount: 1, maxAmount: 2 },
  speed: { minFactor: 0.25, maxFactor: 4 },
  fade: { minDuration: 0.1, maxDuration: 10 },
  audioVolume: { minFactor: 0, maxFactor: 2 },
  visualAdjustment: { min: -1, max: 1 },
  aspectRatios: ["16:9", "9:16", "1:1"]
};

export const CAPABILITY_REGISTRY = {
  merge: { requiredFields: [] },
  sequence: { requiredFields: ["clips"] },
  color_grade: { requiredFields: ["style"], supportedValues: COLOR_PRESETS },
  title: {
    requiredFields: ["text", "start", "end", "position", "size", "color", "weight", "font"]
  },
  captions: { requiredFields: [] },
  trim: { requiredFields: ["start", "end"] },
  zoom: { requiredFields: ["start", "end", "amount"], limits: CAPABILITY_LIMITS.zoom },
  speed: { requiredFields: ["factor"], limits: CAPABILITY_LIMITS.speed },
  fade: { requiredFields: ["mode", "duration"], modes: ["in", "out", "both"], limits: CAPABILITY_LIMITS.fade },
  audio_volume: { requiredFields: ["factor"], limits: CAPABILITY_LIMITS.audioVolume },
  audio_fade: { requiredFields: ["mode", "duration"], modes: ["in", "out", "both"], limits: CAPABILITY_LIMITS.fade },
  visual_adjustment: { requiredFields: [], limits: CAPABILITY_LIMITS.visualAdjustment },
  style_profile: {
    requiredFields: ["profileId"],
    profileIds: STYLE_PROFILE_IDS,
    strengths: Object.keys(STYLE_PROFILE_STRENGTHS),
    constraints: STYLE_PROFILE_CONSTRAINTS
  },
  crop: { requiredFields: ["aspect_ratio"], aspectRatios: CAPABILITY_LIMITS.aspectRatios }
};

export function getCapability(type) {
  return CAPABILITY_REGISTRY[type] || null;
}

export function getAiCapabilityContract({ hasMultipleVideos = false, supportsSequence = hasMultipleVideos } = {}) {
  return {
    color_grade: { styles: Object.keys(COLOR_PRESETS) },
    title: {
      fonts: Object.values(FONT_CATALOG).map(({ id, family, aliases, tags, weights }) => ({ id, family, aliases, tags, weights })),
      positions: Object.keys(POSITION_MAP),
      sizes: Object.keys(SIZE_MAP),
      colors: Object.keys(COLOR_MAP),
      weights: ["regular", "bold"],
      numericSizeBounds: TITLE_SIZE_LIMITS,
      requiredFields: CAPABILITY_REGISTRY.title.requiredFields
    },
    captions: {
      fonts: Object.values(FONT_CATALOG).map(({ id, family, aliases, tags, weights }) => ({ id, family, aliases, tags, weights })),
      positions: Object.keys(POSITION_MAP), sizes: Object.keys(SIZE_MAP), colors: Object.keys(COLOR_MAP),
      weights: ["regular", "bold"], numericSizeBounds: TITLE_SIZE_LIMITS,
      note: "Captions use only server-owned transcript text and final-output cue timestamps. Never include caption text or cue timestamps in the edit plan."
    },
    trim: { requiredFields: CAPABILITY_REGISTRY.trim.requiredFields },
    zoom: { requiredFields: CAPABILITY_REGISTRY.zoom.requiredFields, ...CAPABILITY_REGISTRY.zoom.limits },
    speed: {
      requiredFields: CAPABILITY_REGISTRY.speed.requiredFields,
      optionalFields: ["start", "end"],
      ...CAPABILITY_REGISTRY.speed.limits
    },
    fade: { requiredFields: CAPABILITY_REGISTRY.fade.requiredFields, modes: CAPABILITY_REGISTRY.fade.modes, ...CAPABILITY_REGISTRY.fade.limits },
    audio_volume: { requiredFields: CAPABILITY_REGISTRY.audio_volume.requiredFields, ...CAPABILITY_REGISTRY.audio_volume.limits, note: "Controls final-output audio only. Mute is factor 0; quieter/lower/decrease is 0.5; louder/increase is 1.5." },
    audio_fade: { requiredFields: CAPABILITY_REGISTRY.audio_fade.requiredFields, modes: CAPABILITY_REGISTRY.audio_fade.modes, ...CAPABILITY_REGISTRY.audio_fade.limits, note: "Fades final-output audio only; it never fades video." },
    visual_adjustment: { fields: ["brightness", "contrast", "saturation", "temperature", "tint"], min: -1, max: 1, note: "Normalized visual controls only; positive temperature is warmer and positive tint is magenta. Never emit FFmpeg filters." },
    crop: { requiredFields: CAPABILITY_REGISTRY.crop.requiredFields, aspectRatios: CAPABILITY_REGISTRY.crop.aspectRatios },
    merge: hasMultipleVideos
      ? "Automatically added by the server because multiple videos were uploaded. Do not emit it."
      : "Unavailable without multiple uploaded videos. Do not emit it.",
    sequence: supportsSequence
      ? "Available only in a version 2 source-aware plan. It arranges validated source-local clips."
      : "Unavailable without multiple uploaded videos."
  };
}
