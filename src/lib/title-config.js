const FONT_DIRECTORY = "public/fonts";

export const FONT_CATALOG = {
  inter: {
    id: "inter",
    family: "Inter",
    aliases: ["inter"],
    weights: ["regular", "bold"],
    files: { regular: `${FONT_DIRECTORY}/Inter-Variable.ttf`, bold: `${FONT_DIRECTORY}/Inter-Bold.ttf` },
    tags: ["clean", "minimal", "sans-serif", "documentary", "technical"]
  },
  instrumentSerif: {
    id: "instrumentSerif",
    family: "Instrument Serif",
    aliases: ["instrument serif", "instrumentserif"],
    weights: ["regular", "bold"],
    files: { regular: `${FONT_DIRECTORY}/InstrumentSerif-Regular.ttf`, bold: `${FONT_DIRECTORY}/InstrumentSerif-Regular.ttf` },
    tags: ["serif", "editorial", "elegant", "classy", "luxury", "cinematic", "display", "retro", "vintage"]
  },
  jetbrainsMono: {
    id: "jetbrainsMono",
    family: "JetBrains Mono",
    aliases: ["jetbrains mono", "jetbrainsmono"],
    weights: ["regular", "bold"],
    files: { regular: `${FONT_DIRECTORY}/JetBrainsMono-Regular.ttf`, bold: `${FONT_DIRECTORY}/JetBrainsMono-Bold.ttf` },
    tags: ["mono", "technical", "gaming", "futuristic", "bold", "fun", "playful"]
  }
};

// Legacy exports are retained for existing planner and title-operation callers.
export const FONT_MAP = Object.fromEntries(Object.entries(FONT_CATALOG).map(([id, font]) => [id, font.files]));

export const TITLE_SIZE_PRESETS = { small: 0.045, medium: 0.07, large: 0.1 };
export const SIZE_MAP = Object.fromEntries(Object.entries(TITLE_SIZE_PRESETS).map(([name, ratio]) => [name, `h*${ratio}`]));

export const POSITION_MAP = {
  top: "top-center",
  center: "center",
  bottom: "bottom-center",
  "top-left": "top-left",
  "top-center": "top-center",
  "top-right": "top-right",
  "center-left": "center-left",
  "center-right": "center-right",
  "bottom-left": "bottom-left",
  "bottom-center": "bottom-center",
  "bottom-right": "bottom-right"
};

export const COLOR_MAP = {
  white: "#FFFFFF", black: "#000000", yellow: "#F6D365", red: "#E94B4B", blue: "#4A90E2",
  green: "#4CAF50", orange: "#F28C28", purple: "#8E6CEF", pink: "#EC6AA8"
};

export const TITLE_DEFAULTS = { position: "center", size: "medium", color: "white", weight: "regular", font: "inter" };
export const CAPTION_DEFAULTS = { position: "bottom-center", size: "medium", color: "white", weight: "regular", font: "inter" };
export const TITLE_SIZE_LIMITS = { min: 12, max: 200 };

function normalizedFontName(value = "") {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function resolveFontId(value) {
  const normalized = normalizedFontName(value);
  return Object.values(FONT_CATALOG).find((font) => [font.id, font.family, ...font.aliases]
    .some((alias) => normalizedFontName(alias) === normalized))?.id || null;
}

export function resolveSemanticFontIntent(intent) {
  const words = normalizedFontName(intent).split(" ").filter(Boolean);
  if (!words.length) return null;
  const ranked = Object.values(FONT_CATALOG).map((font) => ({
    id: font.id,
    score: words.reduce((score, word) => score + (font.tags.includes(word) ? 1 : 0), 0)
  })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return ranked[0]?.id || null;
}

export function normalizeTitleColor(value) {
  const named = COLOR_MAP[String(value || "").trim().toLowerCase()];
  if (named) return named;
  const hex = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

export function normalizeTitlePosition(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return POSITION_MAP[normalized] ? POSITION_MAP[normalized] : null;
}

export function normalizeTitleWeight(value) {
  return value === "bold" ? "bold" : value === "regular" ? "regular" : null;
}

export function normalizeTitleSize(value) {
  if (Object.hasOwn(TITLE_SIZE_PRESETS, value)) return value;
  return typeof value === "number" && Number.isFinite(value) && value >= TITLE_SIZE_LIMITS.min && value <= TITLE_SIZE_LIMITS.max ? value : null;
}

export function titleFontSize(value, height) {
  return typeof value === "number" ? value : Math.round(height * TITLE_SIZE_PRESETS[value]);
}

export function assColor(hex) {
  const value = normalizeTitleColor(hex);
  if (!value) return null;
  return `&H00${value.slice(5, 7)}${value.slice(3, 5)}${value.slice(1, 3)}&`;
}

export function titleFontDirectory() { return FONT_DIRECTORY; }
