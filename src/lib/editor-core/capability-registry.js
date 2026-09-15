import { COLOR_PRESETS } from "@/lib/color-presets";
import { COLOR_MAP, FONT_MAP, POSITION_MAP, SIZE_MAP } from "@/lib/title-config";

export const CAPABILITY_LIMITS = {
  zoom: { minAmount: 1, maxAmount: 2 },
  speed: { minFactor: 0.25, maxFactor: 4 },
  fade: { minDuration: 0.1, maxDuration: 10 },
  aspectRatios: ["16:9", "9:16", "1:1"]
};

export const CAPABILITY_REGISTRY = {
  merge: { requiredFields: [] },
  color_grade: { requiredFields: ["style"], supportedValues: COLOR_PRESETS },
  title: {
    requiredFields: ["text", "start", "end", "position", "size", "color", "weight", "font"]
  },
  trim: { requiredFields: ["start", "end"] },
  zoom: { requiredFields: ["start", "end", "amount"], limits: CAPABILITY_LIMITS.zoom },
  speed: { requiredFields: ["factor"], limits: CAPABILITY_LIMITS.speed },
  fade: { requiredFields: ["mode", "duration"], modes: ["in", "out", "both"], limits: CAPABILITY_LIMITS.fade },
  crop: { requiredFields: ["aspect_ratio"], aspectRatios: CAPABILITY_LIMITS.aspectRatios }
};

export function getCapability(type) {
  return CAPABILITY_REGISTRY[type] || null;
}

export function getAiCapabilityContract({ hasSecondVideo = false } = {}) {
  return {
    color_grade: { styles: Object.keys(COLOR_PRESETS) },
    title: {
      fonts: Object.keys(FONT_MAP),
      positions: Object.keys(POSITION_MAP),
      sizes: Object.keys(SIZE_MAP),
      colors: Object.keys(COLOR_MAP),
      weights: ["regular", "bold"],
      requiredFields: CAPABILITY_REGISTRY.title.requiredFields
    },
    trim: { requiredFields: CAPABILITY_REGISTRY.trim.requiredFields },
    zoom: { requiredFields: CAPABILITY_REGISTRY.zoom.requiredFields, ...CAPABILITY_REGISTRY.zoom.limits },
    speed: {
      requiredFields: CAPABILITY_REGISTRY.speed.requiredFields,
      optionalFields: ["start", "end"],
      ...CAPABILITY_REGISTRY.speed.limits
    },
    fade: { requiredFields: CAPABILITY_REGISTRY.fade.requiredFields, modes: CAPABILITY_REGISTRY.fade.modes, ...CAPABILITY_REGISTRY.fade.limits },
    crop: { requiredFields: CAPABILITY_REGISTRY.crop.requiredFields, aspectRatios: CAPABILITY_REGISTRY.crop.aspectRatios },
    merge: hasSecondVideo
      ? "Automatically added by the server because two videos were uploaded. Do not emit it."
      : "Unavailable without a second uploaded video. Do not emit it."
  };
}
