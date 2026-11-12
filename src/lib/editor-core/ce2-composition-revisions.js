import { CE1_VISUAL_ADJUSTMENT, createCe1FounderReelPlan, validateCe1FounderReelPlan } from "@/lib/editor-core/ce1-founder-reel";

export const CE2_COMPOSITION_VERSION = "ce2-composition/1";
export const CE2_SLIGHTLY_BRIGHTER_DELTA = 0.025;

const LAYERS = Object.freeze([
  ["intro-greeting", "HEY, A16Z.", "white"], ["founder-given-name", "MOHAMMED", "white"], ["founder-family-name", "AYAAN", "yellow"],
  ["product-chatgpt", "ChatGPT", "charcoal"], ["product-description", "for video editing", "white"],
  ["crossover-heading", "A CROSSOVER BETWEEN", "white"], ["crossover-resolve", "DAVINCI RESOLVE", "white"], ["crossover-chatgpt", "and ChatGPT", "yellow"]
]);
const COLOURS = new Set(["white", "yellow", "red", "charcoal"]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

function planWithAdjustment(adjustment) {
  const plan = createCe1FounderReelPlan();
  plan.operations = plan.operations.map((operation) => operation.type === "visual_adjustment" ? { type: "visual_adjustment", ...adjustment } : operation);
  return plan;
}

export function createCe2Composition({ seededOldName = false } = {}) {
  const textLayers = LAYERS.map(([id, text, colour]) => ({ id, text: id === "founder-family-name" && seededOldName ? "AYAN" : text, colour }));
  return { version: CE2_COMPOSITION_VERSION, compositionId: seededOldName ? "ce1-v3-title-correction-fixture" : "ce1-v3-recovered", revision: 0, parentRevision: null, plan: planWithAdjustment(CE1_VISUAL_ADJUSTMENT), textLayers, revisionHistory: [] };
}

function error(message) { throw new Error(`Invalid CE-2 revision: ${message}`); }

export function validateCe2Composition(composition, sourceCatalog = []) {
  if (!composition || composition.version !== CE2_COMPOSITION_VERSION || !Number.isInteger(composition.revision) || composition.revision < 0) error("invalid composition identity");
  validateCe1FounderReelPlan(composition.plan, sourceCatalog);
  const adjustment = composition.plan.operations.find((operation) => operation.type === "visual_adjustment");
  if (!adjustment || Object.keys(adjustment).some((key) => !["type", "brightness", "contrast", "saturation", "temperature", "tint"].includes(key))) error("invalid footage adjustment");
  for (const key of ["contrast", "saturation", "temperature", "tint"]) if (adjustment[key] !== CE1_VISUAL_ADJUSTMENT[key]) error("non-exposure footage changes are unsupported");
  if (![CE1_VISUAL_ADJUSTMENT.brightness, CE1_VISUAL_ADJUSTMENT.brightness + CE2_SLIGHTLY_BRIGHTER_DELTA].includes(adjustment.brightness)) error("unsupported exposure adjustment");
  if (!Array.isArray(composition.textLayers) || composition.textLayers.length !== LAYERS.length) error("invalid editable layer set");
  for (const [id, defaultText] of LAYERS) {
    const layer = composition.textLayers.find((candidate) => candidate?.id === id);
    if (!layer || typeof layer.text !== "string" || !COLOURS.has(layer.colour)) error("invalid editable layer");
    if (layer.text !== defaultText && !(id === "founder-family-name" && ["AYAN", "AYAAN"].includes(layer.text))) error("unsupported title content");
  }
  return composition;
}

export function parseCe2RevisionRequest(request) {
  const text = normalize(request);
  if (text === "change all yellow text to red.") return { type: "replace_typography_colour", from: "yellow", to: "red" };
  if (text === "change mohammed ayan to mohammed ayaan.") return { type: "correct_founder_title", from: "AYAN", to: "AYAAN" };
  if (text === "make the footage slightly brighter.") return { type: "adjust_exposure", brightnessDelta: CE2_SLIGHTLY_BRIGHTER_DELTA };
  error("request is unsupported or ambiguous");
}

export function applyCe2Revision(composition, request, sourceCatalog = []) {
  validateCe2Composition(composition, sourceCatalog);
  const action = parseCe2RevisionRequest(request);
  const next = clone(composition);
  if (action.type === "replace_typography_colour") {
    const matching = next.textLayers.filter((layer) => layer.colour === action.from);
    if (!matching.length) error("no matching typography colour");
    matching.forEach((layer) => { layer.colour = action.to; });
  } else if (action.type === "correct_founder_title") {
    const familyName = next.textLayers.find((layer) => layer.id === "founder-family-name");
    if (familyName?.text !== action.from) error("requested title text is not present");
    familyName.text = action.to;
  } else {
    const visual = next.plan.operations.find((operation) => operation.type === "visual_adjustment");
    if (visual.brightness !== CE1_VISUAL_ADJUSTMENT.brightness) error("footage is already revised for exposure");
    visual.brightness += action.brightnessDelta;
  }
  next.parentRevision = composition.revision;
  next.revision = composition.revision + 1;
  next.revisionHistory.push({ revision: next.revision, operation: action.type });
  return validateCe2Composition(next, sourceCatalog);
}

export function createCe2RevisionExample(name, sourceCatalog = []) {
  if (name === "yellow-to-red") return applyCe2Revision(createCe2Composition(), "Change all yellow text to red.", sourceCatalog);
  if (name === "text-correction") return applyCe2Revision(createCe2Composition({ seededOldName: true }), "Change Mohammed Ayan to Mohammed Ayaan.", sourceCatalog);
  if (name === "slightly-brighter") return applyCe2Revision(createCe2Composition(), "Make the footage slightly brighter.", sourceCatalog);
  error("unknown CE-2 example");
}
