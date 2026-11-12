import { createCe2Composition, validateCe2Composition } from "@/lib/editor-core/ce2-composition-revisions";

export const CE3_HYPERFRAMES_COMPOSITION_VERSION = "ce3-hyperframes-composition/1";
const clone = (value) => JSON.parse(JSON.stringify(value));
const colours = new Set(["white", "yellow", "red", "charcoal"]);
const titleIds = new Set(["founder-given-name", "founder-family-name"]);
const fail = (message) => { throw new Error(`Invalid CE-3 HyperFrames composition: ${message}`); };

export function createCe3HyperframesComposition() {
  return {
    version: CE3_HYPERFRAMES_COMPOSITION_VERSION,
    compositionId: "ce1-founder-reel-hyperframes",
    revision: 0,
    parentRevision: null,
    ce2: createCe2Composition(),
    layout: {
      "founder-title": { x: 104, y: 160, width: 450, height: 220, fontSize: 130, containerWidth: 490 },
      "product-copy": { x: 108, y: 620, width: 620, height: 300 },
      "closing-copy": { x: 108, y: 126, width: 730, height: 290 }
    },
    graphics: [{ id: "cliponaut-wordmark", assetId: "cliponaut-wordmark", placement: "bottom-right-safe" }],
    revisionHistory: []
  };
}

export function validateCe3HyperframesComposition(composition, sourceCatalog = []) {
  if (!composition || composition.version !== CE3_HYPERFRAMES_COMPOSITION_VERSION || !Number.isInteger(composition.revision) || composition.revision < 0) fail("invalid identity");
  validateCe2Composition(composition.ce2, sourceCatalog);
  const title = composition.layout?.["founder-title"];
  if (!title || !["x", "y", "width", "height", "fontSize", "containerWidth"].every((key) => Number.isFinite(title[key]))) fail("invalid title layout");
  if (title.x < 68 || title.y < 72 || title.width <= 0 || title.height <= 0 || title.fontSize < 72 || title.fontSize > 150 || title.width > title.containerWidth || title.x + title.containerWidth > 760 || title.y + title.height > 480) fail("title does not fit its safe container");
  if (!Array.isArray(composition.graphics) || composition.graphics.length !== 1 || composition.graphics[0].assetId !== "cliponaut-wordmark") fail("invalid graphics");
  return composition;
}

export function applyCe3HyperframesRevision(composition, request, sourceCatalog = []) {
  validateCe3HyperframesComposition(composition, sourceCatalog);
  const normalized = String(request || "").trim().toLowerCase();
  const next = clone(composition);
  if (normalized === "fit the title fully inside its container.") {
    next.layout["founder-title"] = { ...next.layout["founder-title"], x: 104, y: 160, width: 420, fontSize: 112 };
  } else if (normalized === "move the title and change its colour.") {
    next.layout["founder-title"] = { ...next.layout["founder-title"], x: 138, y: 188 };
    next.ce2.textLayers = next.ce2.textLayers.map((layer) => titleIds.has(layer.id) ? { ...layer, colour: "red" } : layer);
    if (next.ce2.textLayers.some((layer) => titleIds.has(layer.id) && !colours.has(layer.colour))) fail("invalid title colour");
  } else fail("request is unsupported or ambiguous");
  next.parentRevision = composition.revision;
  next.revision = composition.revision + 1;
  next.revisionHistory.push({ revision: next.revision, request: normalized });
  return validateCe3HyperframesComposition(next, sourceCatalog);
}
