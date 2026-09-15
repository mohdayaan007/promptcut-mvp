import { COLOR_MAP, FONT_MAP, POSITION_MAP, SIZE_MAP } from "@/lib/title-config";
import { CAPABILITY_LIMITS, getCapability } from "@/lib/editor-core/capability-registry";

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

function validateTimedOperation(operation, name) {
  if (!isNonNegativeNumber(operation.start) || !isNonNegativeNumber(operation.end) || operation.end <= operation.start) {
    throw validationError(`${name} timestamps must be a valid positive range`);
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

    if (["merge", "color_grade", "trim", "zoom", "speed", "fade", "crop"].includes(operation.type)) {
      if (seenSingletons.has(operation.type)) throw validationError(`only one ${operation.type} operation is allowed`);
      seenSingletons.add(operation.type);
    }

    if (operation.type === "color_grade" && !capability.supportedValues[operation.style]) {
      throw validationError(`unsupported color grade: ${operation.style}`);
    }
    if (operation.type === "trim") validateTimedOperation(operation, "trim");
    if (operation.type === "title") validateTitle(operation);
    if (operation.type === "zoom") {
      validateTimedOperation(operation, "zoom");
      if (!isNonNegativeNumber(operation.amount) || operation.amount < CAPABILITY_LIMITS.zoom.minAmount || operation.amount > CAPABILITY_LIMITS.zoom.maxAmount) {
        throw validationError(`zoom amount must be between ${CAPABILITY_LIMITS.zoom.minAmount} and ${CAPABILITY_LIMITS.zoom.maxAmount}`);
      }
    }
    if (operation.type === "speed") {
      if (!isNonNegativeNumber(operation.factor) || operation.factor < CAPABILITY_LIMITS.speed.minFactor || operation.factor > CAPABILITY_LIMITS.speed.maxFactor) {
        throw validationError(`speed factor must be between ${CAPABILITY_LIMITS.speed.minFactor} and ${CAPABILITY_LIMITS.speed.maxFactor}`);
      }
      const hasStart = operation.start !== undefined;
      const hasEnd = operation.end !== undefined;
      if (hasStart !== hasEnd) throw validationError("speed requires both start and end, or neither for global speed");
      if (hasStart) validateTimedOperation(operation, "speed");
    }
    if (operation.type === "fade") {
      if (!getCapability("fade").modes.includes(operation.mode)) throw validationError("fade mode is unsupported");
      if (!isNonNegativeNumber(operation.duration) || operation.duration < CAPABILITY_LIMITS.fade.minDuration || operation.duration > CAPABILITY_LIMITS.fade.maxDuration) {
        throw validationError(`fade duration must be between ${CAPABILITY_LIMITS.fade.minDuration} and ${CAPABILITY_LIMITS.fade.maxDuration}`);
      }
    }
    if (operation.type === "crop" && !CAPABILITY_LIMITS.aspectRatios.includes(operation.aspect_ratio)) {
      throw validationError("crop aspect ratio is unsupported");
    }
  }

  return plan;
}
