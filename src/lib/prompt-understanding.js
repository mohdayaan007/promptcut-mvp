export const INTENTS = {
  cinematic: {
    aliases: [
      "cinematic", "movie", "movie look", "movie style", "film", "film look",
      "filmic", "cinema", "hollywood", "hollywood look", "blockbuster", "netflix",
      "netflix look", "dramatic", "epic", "professional look", "high quality look"
    ]
  },
  warm: {
    aliases: [
      "warm", "warmer", "golden", "golden hour", "sunset", "sunrise", "summer",
      "cozy", "warm tone", "orange tone"
    ]
  },
  cool: {
    aliases: ["cool", "colder", "cold", "blue", "blue tone", "winter", "icy", "moonlight"]
  },
  blackWhite: {
    aliases: [
      "black and white", "black & white", "bw", "b&w", "grayscale", "greyscale",
      "monochrome", "old movie", "classic movie"
    ]
  },
  merge: {
    aliases: [
      "merge", "combine", "join", "stitch", "append", "put together", "merge videos",
      "combine videos"
    ]
  },
  trim: {
    aliases: [
      "trim", "cut", "shorten", "clip", "remove intro", "remove outro", "remove beginning",
      "remove ending"
    ]
  },
  title: {
    aliases: [
      "title", "add title", "add text", "text", "caption", "headline", "overlay text",
      "write", "display text", "show title"
    ]
  }
};

export function normalizePrompt(prompt = "") {
  return prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function understandPrompt(originalPrompt = "") {
  const normalizedPrompt = normalizePrompt(originalPrompt);
  const intents = Object.entries(INTENTS)
    .filter(([, { aliases }]) =>
      aliases.some((alias) => normalizedPrompt.includes(normalizePrompt(alias)))
    )
    .map(([name]) => name);

  return { originalPrompt, normalizedPrompt, intents };
}

export function getIntentPattern(intentName) {
  return INTENTS[intentName].aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}
