import path from "path";
import { writeFile } from "fs/promises";
import { FONT_CATALOG, assColor, titleFontDirectory, titleFontSize } from "@/lib/title-config";

const ASS_ALIGNMENTS = {
  "bottom-left": 1, "bottom-center": 2, "bottom-right": 3,
  "center-left": 4, center: 5, "center-right": 6,
  "top-left": 7, "top-center": 8, "top-right": 9,
  "upper-third": 8
};

function escapeAssText(value = "") {
  // Never permit ASS override blocks or line-level control syntax from user text.
  return String(value)
    .replace(/\\/g, "＼")
    .replace(/[{}]/g, (character) => character === "{" ? "｛" : "｝")
    .replace(/\r?\n/g, "\\N");
}

function escapeAssFont(value = "") {
  return String(value).replace(/[\\{}]/g, "");
}

function positionForTitle(position, width, height) {
  const horizontal = position.endsWith("left") ? width * 0.1 : position.endsWith("right") ? width * 0.9 : width / 2;
  const vertical = position === "upper-third" ? height * 0.22 : position.startsWith("top") ? height * 0.13 : position.startsWith("bottom") ? height * 0.84 : height / 2;
  return { alignment: ASS_ALIGNMENTS[position], x: Math.round(horizontal), y: Math.round(vertical) };
}

function assTimestamp(seconds) {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const secondsPart = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function safeReadabilityOverrides(readability) {
  if (!readability || typeof readability !== "object") return "";
  const outline = Number(readability.outline);
  const shadow = Number(readability.shadow);
  if (!Number.isFinite(outline) || !Number.isFinite(shadow) || outline < 0 || outline > 2 || shadow < 0 || shadow > 1) return "";
  const outlineColor = readability.outlineColor && assColor(readability.outlineColor);
  const outlineAlpha = Number(readability.outlineAlpha);
  const outlineColorOverride = outlineColor && Number.isFinite(outlineAlpha) && outlineAlpha >= 0 && outlineAlpha <= 255
    ? `\\3c&H${Math.round(outlineAlpha).toString(16).padStart(2, "0").toUpperCase()}${outlineColor.slice(4)}`
    : "\\3c&H55000000&";
  // Server-owned values only. This remains intentionally understated rather
  // than introducing a title-card or a heavy universal shadow.
  return `\\bord${outline}\\shad${shadow}${outlineColorOverride}`;
}

// B2B keeps canonical title text untouched in the plan, then applies a bounded
// reference-derived presentation case only while generating safe ASS text.
function renderTextCase(value, caseStyle) {
  const text = String(value);
  if (caseStyle === "uppercase") return text.toUpperCase();
  if (caseStyle === "lowercase") return text.toLowerCase();
  if (caseStyle === "title_case") {
    return text.toLowerCase().replace(/(^|[\s\-–—])([^\s\-–—])/g, (_, prefix, character) => `${prefix}${character.toUpperCase()}`);
  }
  return text;
}

function wrapHeroText(value, width, height) {
  const baseSize = height * 0.14;
  const maxCharacters = Math.max(8, Math.floor((width * 0.78) / (baseSize * 0.35)));
  return String(value).split(/\r?\n/).flatMap((line) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (current && next.length > maxCharacters) {
        lines.push(current);
        current = word;
      } else current = next;
    }
    if (current) lines.push(current);
    return lines;
  }).join("\n");
}

function titleRunSize(run, width, height, presentation, renderedText) {
  if (presentation !== "hero_display") return titleFontSize(run.size, height);
  const ideal = Math.round(height * 0.14);
  const longestLine = Math.max(...String(renderedText).split(/\r?\n/).map((line) => line.length), 1);
  const widthBound = Math.floor((width * 0.78) / (longestLine * 0.35));
  return Math.max(12, Math.min(ideal, widthBound));
}

function runOverrides(run, width, height, readability, presentation, renderedText) {
  const font = FONT_CATALOG[run.font];
  const family = font.familyByWeight?.[run.weight] || font.family;
  return `{${safeReadabilityOverrides(readability)}\\fn${escapeAssFont(family)}\\fs${titleRunSize(run, width, height, presentation, renderedText)}\\c${assColor(run.color)}\\b${run.weight === "bold" ? 1 : 0}}`;
}

export function buildAssDocument(titles, { width, height }) {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Inter,48,&H00FFFFFF,&H00FFFFFF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];

  for (const title of titles) {
    const { alignment, x, y } = positionForTitle(title.position, width, height);
    const text = title.runs.map((run) => {
      const cased = renderTextCase(run.text, title.renderCaseStyle);
      const rendered = title.presentation === "hero_display" ? wrapHeroText(cased, width, height) : cased;
      return `${runOverrides(run, width, height, title.readability, title.presentation, rendered)}${escapeAssText(rendered)}`;
    }).join("");
    lines.push(`Dialogue: 0,${assTimestamp(title.start)},${assTimestamp(title.end)},Default,,0,0,0,,{\\an${alignment}\\pos(${x},${y})}${text}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeFilterPath(value) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export async function writeTitleAssFile(titles, { width, height, tempDirectory }) {
  const assPath = path.join(tempDirectory, "title-layers.ass");
  await writeFile(assPath, buildAssDocument(titles, { width, height }), "utf8");
  return assPath;
}

export function buildAssFilter(assPath) {
  const fontsDirectory = path.join(process.cwd(), titleFontDirectory());
  return `ass=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDirectory)}'`;
}
