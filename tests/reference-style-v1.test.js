import test from "node:test";
import assert from "node:assert/strict";
import { createRve1OfflineProfile, resolveReferenceStyleTitle } from "../src/lib/editor-core/reference-style-v1.js";
test("Reference Style V1 records bounded offline evidence and a canonical treatment", () => { const profile = createRve1OfflineProfile(); assert.equal(profile.version, "reference-style/1"); assert.equal(profile.colour.treatment.version, 2); assert.equal(profile.typography.primaryFamily, "condensed_sans"); });
test("Reference Style V1 never invents a title without source evidence and respects no-text", () => { const profile = createRve1OfflineProfile(); assert.equal(resolveReferenceStyleTitle({ profile }), null); assert.equal(resolveReferenceStyleTitle({ profile, noText: true, sourceEvidence: { observedStreetMotion: true } }), null); assert.equal(resolveReferenceStyleTitle({ profile, sourceEvidence: { observedStreetMotion: true } }).text, "CITY MOTION"); });
