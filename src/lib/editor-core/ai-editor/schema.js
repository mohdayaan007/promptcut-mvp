import { COLOR_MAP, FONT_MAP, POSITION_MAP, SIZE_MAP } from "@/lib/title-config";
import { COLOR_PRESETS } from "@/lib/color-presets";

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

export const EDIT_PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", enum: ["1"] },
    operations: {
      type: "array",
      items: {
        anyOf: [
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
          }
        ]
      }
    }
  },
  required: ["version", "operations"],
  additionalProperties: false
};
