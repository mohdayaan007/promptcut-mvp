import { COLOR_PRESETS } from "@/lib/color-presets";
import { COLOR_MAP, FONT_MAP, POSITION_MAP, SIZE_MAP } from "@/lib/title-config";

export const CAPABILITY_REGISTRY = {
  merge: { requiredFields: [] },
  color_grade: { requiredFields: ["style"], supportedValues: COLOR_PRESETS },
  title: {
    requiredFields: ["text", "start", "end", "position", "size", "color", "weight", "font"]
  },
  trim: { requiredFields: ["start", "end"] }
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
    merge: hasSecondVideo
      ? "Automatically added by the server because two videos were uploaded. Do not emit it."
      : "Unavailable without a second uploaded video. Do not emit it."
  };
}
