import { COLOR_MAP, FONT_MAP, POSITION_MAP, SIZE_MAP } from "@/lib/title-config";
import { getCapability } from "@/lib/editor-core/capability-registry";

function validationError(message) {
  return new Error(`Invalid edit plan: ${message}`);
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateTitle(operation) {
  if (typeof operation.text !== "string" || !operation.text.trim()) {
    throw validationError("title text must be non-empty");
  }
  if (!isNonNegativeNumber(operation.start) || !isNonNegativeNumber(operation.end) || operation.end <= operation.start) {
    throw validationError("title timestamps must be a valid positive range");
  }
  if (!POSITION_MAP[operation.position] || !SIZE_MAP[operation.size] || !COLOR_MAP[operation.color]) {
    throw validationError("title position, size, or color is unsupported");
  }
  if (!FONT_MAP[operation.font] || !FONT_MAP[operation.font][operation.weight]) {
    throw validationError("title font or weight is unsupported");
  }
}

export function validateEditPlan(plan) {
  if (!plan || plan.version !== "1" || !Array.isArray(plan.operations)) {
    throw validationError("version 1 with an operations array is required");
  }

  const seenSingletons = new Set();
  for (const operation of plan.operations) {
    const capability = getCapability(operation?.type);
    if (!capability) throw validationError(`unsupported operation type: ${operation?.type || "unknown"}`);

    for (const field of capability.requiredFields) {
      if (operation[field] === undefined || operation[field] === null) {
        throw validationError(`${operation.type} requires ${field}`);
      }
    }

    if (["merge", "color_grade", "trim"].includes(operation.type)) {
      if (seenSingletons.has(operation.type)) throw validationError(`only one ${operation.type} operation is allowed`);
      seenSingletons.add(operation.type);
    }

    if (operation.type === "color_grade" && !capability.supportedValues[operation.style]) {
      throw validationError(`unsupported color grade: ${operation.style}`);
    }
    if (operation.type === "trim" && (!isNonNegativeNumber(operation.start) || !isNonNegativeNumber(operation.end) || operation.end <= operation.start)) {
      throw validationError("trim timestamps must be a valid positive range");
    }
    if (operation.type === "title") validateTitle(operation);
  }

  return plan;
}
