import { COLOR_MAP, FONT_CATALOG, POSITION_MAP, SIZE_MAP, TITLE_SIZE_LIMITS } from "@/lib/title-config";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { CAPABILITY_LIMITS } from "@/lib/editor-core/capability-registry";
import { STYLE_PROFILE_CONSTRAINTS, STYLE_PROFILE_IDS, STYLE_PROFILE_STRENGTHS } from "@/lib/editor-core/style-profiles";

const titleFields = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["title"] },
    text: { type: "string" },
    start: { type: "number", minimum: 0 },
    end: { type: "number", minimum: 0 },
    position: { type: "string", enum: Object.keys(POSITION_MAP) },
    size: { anyOf: [{ type: "string", enum: Object.keys(SIZE_MAP) }, { type: "number", minimum: TITLE_SIZE_LIMITS.min, maximum: TITLE_SIZE_LIMITS.max }] },
    color: { type: "string", pattern: "^(?:#[0-9A-Fa-f]{6}|white|black|yellow|red|blue|green|orange|purple|pink)$" },
    weight: { type: "string", enum: ["regular", "bold"] },
    font: { type: "string", enum: Object.keys(FONT_CATALOG) },
    fontIntent: { type: "string", maxLength: 64 },
    runs: {
      type: "array", minItems: 1, maxItems: 20,
      items: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 500 },
          font: { type: "string", enum: Object.keys(FONT_CATALOG) },
          fontIntent: { type: "string", maxLength: 64 },
          size: { anyOf: [{ type: "string", enum: Object.keys(SIZE_MAP) }, { type: "number", minimum: TITLE_SIZE_LIMITS.min, maximum: TITLE_SIZE_LIMITS.max }] },
          color: { type: "string", pattern: "^(?:#[0-9A-Fa-f]{6}|white|black|yellow|red|blue|green|orange|purple|pink)$" },
          weight: { type: "string", enum: ["regular", "bold"] }
        },
        required: ["text"], additionalProperties: false
      }
    }
  },
  required: ["type", "text", "start", "end", "position", "size", "color", "weight", "font"],
  additionalProperties: false
};

const captionFields = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["captions"] },
    position: { type: "string", enum: Object.keys(POSITION_MAP) },
    size: { anyOf: [{ type: "string", enum: Object.keys(SIZE_MAP) }, { type: "number", minimum: TITLE_SIZE_LIMITS.min, maximum: TITLE_SIZE_LIMITS.max }] },
    color: { type: "string", pattern: "^(?:#[0-9A-Fa-f]{6}|white|black|yellow|red|blue|green|orange|purple|pink)$" },
    weight: { type: "string", enum: ["regular", "bold"] },
    font: { type: "string", enum: Object.keys(FONT_CATALOG) },
    fontIntent: { type: "string", maxLength: 64 }
  },
  required: ["type"], additionalProperties: false
};

export function createEditPlanJsonSchema({ sourceIds = [], supportsStyleProfiles = false } = {}) {
  const supportsSourceAwarePlans = sourceIds.length > 0;
  const sourceId = { type: "string", enum: sourceIds };
  const sourceColorFields = {
    type: "object",
    properties: {
      type: { type: "string", enum: ["color_grade"] },
      sourceId,
      style: { type: "string", enum: Object.keys(COLOR_PRESETS) }
    },
    required: ["type", "sourceId", "style"],
    additionalProperties: false
  };
  const visualProperties = {
    type: { type: "string", enum: ["visual_adjustment"] },
    brightness: { type: "number", minimum: -1, maximum: 1 }, contrast: { type: "number", minimum: -1, maximum: 1 },
    saturation: { type: "number", minimum: -1, maximum: 1 }, temperature: { type: "number", minimum: -1, maximum: 1 }, tint: { type: "number", minimum: -1, maximum: 1 }
  };
  // Gemini responseJsonSchema does not support minProperties. The validator
  // independently rejects empty adjustment operations before execution.
  const visualAdjustmentFields = { type: "object", properties: visualProperties, required: ["type"], additionalProperties: false };
  const sourceVisualFields = { type: "object", properties: { ...visualProperties, sourceId }, required: ["type", "sourceId"], additionalProperties: false };
  const styleProfileProperties = {
    type: { type: "string", enum: ["style_profile"] },
    profileId: { type: "string", enum: STYLE_PROFILE_IDS },
    strength: { type: "string", enum: Object.keys(STYLE_PROFILE_STRENGTHS) },
    constraints: {
      type: "array",
      uniqueItems: true,
      maxItems: STYLE_PROFILE_CONSTRAINTS.length,
      items: { type: "string", enum: STYLE_PROFILE_CONSTRAINTS }
    }
  };
  const styleProfileFields = {
    type: "object", properties: styleProfileProperties,
    required: ["type", "profileId"], additionalProperties: false
  };
  const sourceStyleProfileFields = {
    type: "object", properties: { ...styleProfileProperties, sourceId },
    required: ["type", "profileId", "sourceId"], additionalProperties: false
  };
  const sequenceFields = {
    type: "object",
    properties: {
      type: { type: "string", enum: ["sequence"] },
      clips: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            sourceId,
            start: { type: "number", minimum: 0 },
            end: { type: "number", minimum: 0 }
          },
          required: ["sourceId", "start", "end"],
          additionalProperties: false
        }
      }
    },
    required: ["type", "clips"],
    additionalProperties: false
  };

  const operationSchemas = [
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["color_grade"] },
        style: { type: "string", enum: Object.keys(COLOR_PRESETS) }
      },
      required: ["type", "style"],
      additionalProperties: false
    },
    titleFields,
    captionFields,
    visualAdjustmentFields,
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["trim"] },
        start: { type: "number", minimum: 0 },
        end: { type: "number", minimum: 0 }
      },
      required: ["type", "start", "end"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["zoom"] },
        start: { type: "number", minimum: 0 },
        end: { type: "number", minimum: 0 },
        amount: { type: "number", minimum: CAPABILITY_LIMITS.zoom.minAmount, maximum: CAPABILITY_LIMITS.zoom.maxAmount }
      },
      required: ["type", "start", "end", "amount"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["speed"] },
        start: { type: "number", minimum: 0 },
        end: { type: "number", minimum: 0 },
        factor: { type: "number", minimum: CAPABILITY_LIMITS.speed.minFactor, maximum: CAPABILITY_LIMITS.speed.maxFactor }
      },
      required: ["type", "factor"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["fade"] },
        mode: { type: "string", enum: ["in", "out", "both"] },
        duration: { type: "number", minimum: CAPABILITY_LIMITS.fade.minDuration, maximum: CAPABILITY_LIMITS.fade.maxDuration }
      },
      required: ["type", "mode", "duration"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["audio_volume"] },
        factor: { type: "number", minimum: CAPABILITY_LIMITS.audioVolume.minFactor, maximum: CAPABILITY_LIMITS.audioVolume.maxFactor }
      },
      required: ["type", "factor"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["audio_fade"] },
        mode: { type: "string", enum: ["in", "out", "both"] },
        duration: { type: "number", minimum: CAPABILITY_LIMITS.fade.minDuration, maximum: CAPABILITY_LIMITS.fade.maxDuration }
      },
      required: ["type", "mode", "duration"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["crop"] },
        aspect_ratio: { type: "string", enum: CAPABILITY_LIMITS.aspectRatios }
      },
      required: ["type", "aspect_ratio"],
      additionalProperties: false
    }
  ];
  if (supportsStyleProfiles) operationSchemas.push(styleProfileFields);
  if (supportsSourceAwarePlans) {
    operationSchemas.push(sourceColorFields, sourceVisualFields, sequenceFields);
    if (supportsStyleProfiles) operationSchemas.push(sourceStyleProfileFields);
  }

  return {
    type: "object",
    properties: {
      version: { type: "string", enum: supportsSourceAwarePlans ? ["1", "2"] : ["1"] },
    operations: {
      type: "array",
      items: {
        anyOf: operationSchemas
      }
    }
  },
  required: ["version", "operations"],
  additionalProperties: false
  };
}

export function createSemanticSourceClassificationJsonSchema({ sourceId, referenceIds = [] } = {}) {
  return {
    type: "object",
    properties: {
      sourceId: { type: "string", enum: [sourceId] },
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            referenceId: { type: "string", enum: referenceIds },
            plausibleMatch: { type: "boolean" }
          },
          required: ["referenceId", "plausibleMatch"],
          additionalProperties: false
        }
      }
    },
    required: ["sourceId", "matches"],
    additionalProperties: false
  };
}

export function createVisualMomentLocalizationJsonSchema({ sourceId, momentIds = [] } = {}) {
  return {
    type: "object",
    properties: {
      sourceId: { type: "string", enum: [sourceId] },
      moments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            momentId: { type: "string", enum: momentIds },
            candidates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: { type: "number" },
                  end: { type: "number" }
                },
                required: ["start", "end"],
                additionalProperties: false
              }
            }
          },
          required: ["momentId", "candidates"],
          additionalProperties: false
        }
      }
    },
    required: ["sourceId", "moments"],
    additionalProperties: false
  };
}

/** Semantic speech matching may return only canonical transcript segment IDs. */
export function createSemanticTranscriptMatchJsonSchema({ sourceId, momentId } = {}) {
  return {
    type: "object",
    properties: {
      sourceId: { type: "string", enum: [sourceId] },
      momentId: { type: "string", enum: [momentId] },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            startSegmentId: { type: "string" },
            endSegmentId: { type: "string" }
          },
          required: ["startSegmentId", "endSegmentId"],
          additionalProperties: false
        }
      }
    },
    required: ["sourceId", "momentId", "candidates"],
    additionalProperties: false
  };
}

export const EDIT_PLAN_JSON_SCHEMA = createEditPlanJsonSchema();
