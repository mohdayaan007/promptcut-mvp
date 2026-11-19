/** Test-only Gemini Files/plan stand-in for isolated worker integration. */
function syntheticSequenceFromRequest(request) {
  const prompt = Array.isArray(request?.contents)
    ? [...request.contents].reverse().find((entry) => typeof entry === "string" && entry.includes("Authoritative source catalog:"))
    : "";
  const catalogMatch = prompt?.match(/Authoritative source catalog: (\[[^\n]+\])/);
  let source;
  try { [source] = catalogMatch ? JSON.parse(catalogMatch[1]) : []; } catch { source = null; }
  if (!source?.sourceId || !Number.isFinite(source.duration) || source.duration <= 0) {
    throw new Error("Synthetic Gemini fixture requires one finite authoritative source duration");
  }
  return {
    version: "2",
    operations: [{ type: "sequence", clips: [{ sourceId: source.sourceId, start: 0, end: source.duration }] }]
  };
}

export function createSyntheticTestGemini() {
  const uploads = [];
  return {
    files: {
      upload: async ({ file }) => {
        const value = { name: `files/synthetic-${uploads.length + 1}`, uri: `gemini://synthetic/${uploads.length + 1}`, mimeType: "video/mp4", state: "ACTIVE" };
        uploads.push({ ...value, file }); return value;
      },
      get: async ({ name }) => uploads.find((value) => value.name === name),
      delete: async () => {}
    },
    models: { generateContent: async (request) => ({ text: JSON.stringify(syntheticSequenceFromRequest(request)) }) }
  };
}
