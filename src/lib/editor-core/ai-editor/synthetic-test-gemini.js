/** Test-only Gemini Files/plan stand-in for isolated worker integration. */
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
    models: { generateContent: async () => ({ text: JSON.stringify({ version: "2", operations: [{ type: "sequence", clips: [{ sourceId: "source-1", start: 2, end: 28 }] }] }) }) }
  };
}
