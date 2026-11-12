import test from "node:test";
import assert from "node:assert/strict";
import { FOUNDER_REFERENCE_STYLE_ASSETS } from "../src/lib/editor-core/founder-reference-style-staging.js";
test("founder reference staging has fixed server-owned local asset identities",()=>{ assert.equal(FOUNDER_REFERENCE_STYLE_ASSETS.reference.id,"founder-rve1-moved-to-blore"); assert.equal(FOUNDER_REFERENCE_STYLE_ASSETS.source.id,"founder-gym-outside"); assert.ok(FOUNDER_REFERENCE_STYLE_ASSETS.reference.path.startsWith("/Users/ayaan/")); });
