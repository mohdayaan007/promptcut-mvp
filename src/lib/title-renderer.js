import path from "path";
import { COLOR_MAP, FONT_MAP, POSITION_MAP, SIZE_MAP } from "@/lib/title-config";

function escapeDrawtextValue(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

export function buildTitleFilter(title) {
  const fontFile = path.join(process.cwd(), FONT_MAP[title.font][title.weight]);
  const fontSize = SIZE_MAP[title.size];
  const position = POSITION_MAP[title.position];
  const color = COLOR_MAP[title.color];

  return [
    `drawtext=fontfile='${escapeDrawtextValue(fontFile)}'`,
    `text='${escapeDrawtextValue(title.text)}'`,
    `fontsize=${fontSize}`,
    `fontcolor=${color}`,
    position,
    "expansion=none",
    `enable=between(t\\,${title.start}\\,${title.end})`
  ].join(":");
}
