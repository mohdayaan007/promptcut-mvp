import { COLOR_PRESETS } from "@/lib/color-presets";

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
