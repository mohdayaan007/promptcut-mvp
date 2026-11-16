import assert from "node:assert/strict";
import test from "node:test";
import { FONT_CATALOG } from "@/lib/title-config";
import { parseTitle } from "@/lib/title-parser";
import { namedTypographyFont, recommendTypographyFonts } from "@/lib/typography/font-recommendations";

test("V1A font recommendations stay inside renderer-installed catalogue", () => {
  for (const intent of ["luxurious elegant editorial", "bold cinematic condensed", "futuristic hacker technical", "clean modern minimal"]) {
    const ranked = recommendTypographyFonts(intent);
    assert.ok(ranked.length > 0, intent);
    assert.ok(ranked.every(({ fontId }) => FONT_CATALOG[fontId]?.files.regular));
  }
  assert.equal(recommendTypographyFonts("luxurious elegant editorial")[0].fontId, "instrumentSerif");
  assert.equal(recommendTypographyFonts("bold cinematic condensed")[0].fontId, "barlowCondensed");
  assert.equal(recommendTypographyFonts("futuristic hacker technical")[0].fontId, "jetbrainsMono");
  assert.equal(recommendTypographyFonts("clean modern minimal")[0].fontId, "inter");
  assert.deepEqual(recommendTypographyFonts("nonsense", { limit: 3 }), []);
  assert.equal(recommendTypographyFonts("elegant", { limit: -1 }).length, 0);
});

test("V1A exact installed font beats semantic recommendations", () => {
  assert.equal(namedTypographyFont("Use Inter for this luxurious title"), "inter");
  assert.equal(namedTypographyFont("Use Barlow Condensed for the headline"), "barlowCondensed");
  assert.equal(namedTypographyFont("Interstellar title"), null);
  assert.equal(parseTitle('Add title: Bangalore using Inter font, make it luxury').font, "inter");
});

test("V1A title parser handles descriptive fonts without selecting random unavailable families", () => {
  assert.equal(parseTitle('Add title: Bangalore in a bold cinematic condensed font').font, "barlowCondensed");
  assert.equal(parseTitle('Add title: Bangalore using an elegant luxury font').font, "instrumentSerif");
  assert.equal(parseTitle('Add title: Bangalore in a futuristic technical font').font, "jetbrainsMono");
  assert.equal(parseTitle('Add title: Bangalore in a clean minimal font').font, "inter");
  assert.equal(parseTitle('Add title: Bangalore using Comic Sans font').font, "__unavailable__");
  assert.equal(parseTitle('Add title: Bangalore at 0:03 in a large font').font, "inter");
});
