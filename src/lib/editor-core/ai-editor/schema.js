import { COLOR_MAP, FONT_MAP, POSITION_MAP, SIZE_MAP } from "@/lib/title-config";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { CAPABILITY_LIMITS } from "@/lib/editor-core/capability-registry";

const titleFields = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["title"] },
    text: { type: "string" },
    start: { type: "number", minimum: 0 },
    end: { type: "number", minimum: 0 },
    position: { type: "string", enum: Object.keys(POSITION_MAP) },
    size: { type: "string", enum: Object.keys(SIZE_MAP) },
    color: { type: "string", enum: Object.keys(COLOR_MAP) },
    weight: { type: "string", enum: ["regular", "bold"] },
    font: { type: "string", enum: Object.keys(FONT_MAP) }
  },
  required: ["type", "text", "start", "end", "position", "size", "color", "weight", "font"],
  additionalProperties: false
};

export function createEditPlanJsonSchema({ sourceIds = [] } = {}) {
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
        type: { type: "string", enum: ["crop"] },
        aspect_ratio: { type: "string", enum: CAPABILITY_LIMITS.aspectRatios }
      },
      required: ["type", "aspect_ratio"],
      additionalProperties: false
    }
  ];
  if (supportsSourceAwarePlans) operationSchemas.push(sourceColorFields, sequenceFields);

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

export const EDIT_PLAN_JSON_SCHEMA = createEditPlanJsonSchema();
