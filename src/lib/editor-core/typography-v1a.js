import { FONT_CATALOG } from "@/lib/title-config";

export const FOUNDER_TYPOGRAPHY_V1A_FLAG = "FOUNDER_TYPOGRAPHY_V1A_ENABLED";

/**
 * This deliberately small, server-owned marker is persisted with the job.
 * It cannot name an arbitrary browser font: only the four font files that
 * ship in the worker image are accepted.
 */
export function validateTypographyV1a(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      typeof value.font !== "string" || !Object.hasOwn(FONT_CATALOG, value.font) ||
      Object.keys(value).some((key) => !["version", "font"].includes(key))) {
    throw new Error("Typography V1A selection is invalid");
  }
  return Object.freeze({ version: 1, font: value.font });
}

export function founderTypographyV1aEnabled({ env = process.env, founderAuthorized = false } = {}) {
  return founderAuthorized === true && env[FOUNDER_TYPOGRAPHY_V1A_FLAG] === "true";
}

export function assertFounderTypographyV1a({ env = process.env, founderAuthorized = false } = {}) {
  if (!founderTypographyV1aEnabled({ env, founderAuthorized })) {
    throw new Error("Typography V1A is not enabled for this account");
  }
}

/** Preserve explicit rich-run fonts while applying the selected font as the title default. */
export function applyTypographyV1aToPlan(plan, typographyV1a) {
  const selection = validateTypographyV1a(typographyV1a);
  if (!selection) return plan;
  const title = plan?.operations?.find((operation) => operation?.type === "title");
  if (!title) throw new Error("Add a title in your request to use the selected export font");
  title.font = selection.font;
  delete title.fontIntent;
  if (Array.isArray(title.runs)) {
    title.runs = title.runs.map((run) => run.font ? run : { ...run, font: selection.font });
  }
  return plan;
}
