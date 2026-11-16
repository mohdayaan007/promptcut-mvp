import assert from "node:assert/strict";
import test from "node:test";
import { findGoogleFontByFamily, googleFontCatalogSize, googleFontPreviewStylesheet, searchGoogleFonts } from "@/lib/typography/google-font-catalog";

test("Google Fonts snapshot contains a large searchable catalogue", () => {
  assert.ok(googleFontCatalogSize() > 2000);
  assert.equal(searchGoogleFonts().total, googleFontCatalogSize());
  assert.deepEqual(searchGoogleFonts({ query: "Playfair Display" }).families.map(x => x.family), ["Playfair Display", "Playfair Display SC"]);
  assert.ok(searchGoogleFonts({ query: "noto sans" }).total >= 10);
  assert.equal(searchGoogleFonts({ query: "noto sans", limit: 10, offset: 0 }).families.length, 10);
  assert.equal(searchGoogleFonts({ query: "noto sans", limit: 10, offset: 10 }).families.length, 10);
  assert.equal(searchGoogleFonts({ query: "invalid-unlisted-name" }).total, 0);
});

test("Google Fonts previews only build allowlisted stylesheet URLs", () => {
  assert.equal(findGoogleFontByFamily("Anton")?.family, "Anton");
  assert.equal(findGoogleFontByFamily("Anton")?.license, "ofl");
  assert.equal(googleFontPreviewStylesheet("Anton"), "https://fonts.googleapis.com/css2?family=Anton&display=swap");
  assert.equal(googleFontPreviewStylesheet("Playfair Display"), "https://fonts.googleapis.com/css2?family=Playfair+Display&display=swap");
  assert.equal(googleFontPreviewStylesheet("http://evil.com"), null);
  assert.equal(googleFontPreviewStylesheet("Unlisted Font"), null);
  assert.equal(findGoogleFontByFamily("__proto__"), null);
});

test("Browse availability must not overclaim export readiness", () => {
  assert.equal(findGoogleFontByFamily("Inter")?.exportReady, true);
  assert.equal(findGoogleFontByFamily("Anton")?.exportReady, false);
  assert.equal(findGoogleFontByFamily("Bebas Neue")?.exportReady, false);
  assert.ok(searchGoogleFonts({ limit: 500 }).families.length <= 60);
  assert.ok(searchGoogleFonts({ query: "X".repeat(81) }).total === 0);
});
