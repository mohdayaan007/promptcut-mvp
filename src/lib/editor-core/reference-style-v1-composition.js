const fail = (message) => { throw new Error(`Invalid Reference Style V1 composition: ${message}`); };
const clone = (value) => JSON.parse(JSON.stringify(value));
export const REFERENCE_STYLE_V1_COMPOSITION_VERSION = "reference-style-composition/1";
export function createReferenceStyleV1Composition({ title, profile }) { if (!title || !profile) fail("missing title or profile"); return { version: REFERENCE_STYLE_V1_COMPOSITION_VERSION, compositionId: "reference-style-v1-street", revision: 0, parentRevision: null, profile, title: { id: "reference-title", text: title, color: "#f8d363", x: 108, y: 118, width: 690, start: 7, end: 10, animation: "phrase_rise" }, revisionHistory: [] }; }
export function validateReferenceStyleV1Composition(value, duration) { const t=value?.title; if (!value || value.version !== REFERENCE_STYLE_V1_COMPOSITION_VERSION || !Number.isInteger(value.revision) || !t || t.id !== "reference-title" || typeof t.text !== "string" || !t.text.trim() || t.text.length > 48 || !/^#[0-9a-f]{6}$/i.test(t.color) || t.x < 68 || t.y < 72 || t.width < 300 || t.width > 780 || t.x + t.width > 840 || t.start !== 7 || t.end !== 10 || t.end > duration || t.animation !== "phrase_rise") fail("unsafe title layout"); return value; }
function changeColourStrength(composition, factor) {
  const recipe = composition?.profile?.colour?.treatment?.recipe;
  if (!recipe || typeof recipe !== "object") fail("reference colour treatment is unavailable");
  for (const [field, value] of Object.entries(recipe)) {
    if (field === "channelCurves") {
      if (!value || typeof value !== "object") fail("reference colour treatment is invalid");
      for (const points of Object.values(value)) {
        if (!Array.isArray(points)) fail("reference colour treatment is invalid");
        for (const point of points) {
          if (!point || typeof point.input !== "number" || typeof point.output !== "number") fail("reference colour treatment is invalid");
          point.output = Math.max(0, Math.min(1, point.input + ((point.output - point.input) * factor)));
        }
      }
      continue;
    }
    if (typeof value !== "number") fail("reference colour treatment is invalid");
    recipe[field] = Math.max(-1, Math.min(1, value * factor));
  }
}

export function applyReferenceStyleV1Revision(composition, request, duration) {
  validateReferenceStyleV1Composition(composition,duration);
  const next=clone(composition); const normalized=String(request||"").trim().toLowerCase();
  if (normalized === "change a trip to new york to exploring bangalore.") { if(next.title.text!=="A Trip to New York") fail("requested title text is not present"); next.title.text="Exploring Bangalore"; }
  else if (normalized === "make the title red and move it slightly higher.") { next.title.color="#ed4b3a"; next.title.y-=28; }
  else if (normalized === "move the title slightly lower.") next.title.y+=28;
  else if (normalized === "move the title slightly higher.") next.title.y-=28;
  else if (["match the reference more strongly.", "make the colours closer to the reference."].includes(normalized)) changeColourStrength(next, 1.35);
  else if (normalized === "reduce the intensity slightly.") changeColourStrength(next, 0.75);
  else fail("unsupported or ambiguous revision");
  next.parentRevision=composition.revision; next.revision+=1; next.revisionHistory.push({revision:next.revision,request:normalized});
  return validateReferenceStyleV1Composition(next,duration);
}
