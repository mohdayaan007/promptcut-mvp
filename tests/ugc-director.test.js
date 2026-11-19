import test from "node:test";
import assert from "node:assert/strict";
import { createUgcDirectorPlan, isAmbiguousUgcTitleRevision, isUgcDirectorFollowUp, reviseUgcTitle } from "../src/lib/editor-core/ugc-director.js";

const catalog = [{ sourceId:"source-1",index:0,ordinal:1,filename:"ugc.mp4",duration:40,width:720,height:1280,hasAudio:true }];
const evidence = { productClips:[{ sourceId:"source-1",start:2,end:22 }] };

test("UGC Director produces renderer-supported vertical premium plan from verified product evidence", () => {
  const plan = createUgcDirectorPlan({ sourceCatalog:catalog,evidence,prompt:"Add the title Mama Earth Lotion Review at 0:07 in a luxury font" });
  assert.deepEqual(plan.operations[0].clips,[{sourceId:"source-1",start:2,end:22}]);
  assert.equal(plan.operations.find(x=>x.type==="crop").aspect_ratio,"9:16");
  assert.equal(plan.operations.find(x=>x.type==="color_grade").style,"cinematic");
  assert.equal(plan.operations.find(x=>x.type==="title").text,"Mama Earth Lotion Review");
});
test("UGC Director retains prior cuts and title-only revision preserves selection and treatment", () => {
  const director = createUgcDirectorPlan({ priorPlan:{version:"2",operations:[{type:"sequence",clips:[{sourceId:"source-1",start:5,end:30}]}]},sourceCatalog:catalog,evidence,prompt:"Add the title Mama Earth Lotion Review at 0:07" });
  const revised = reviseUgcTitle({plan:director,prompt:"Add the title Mama Earth Lotion Review at 0:07 in a cool luxury font",sourceCatalog:catalog});
  assert.deepEqual(revised.operations[0].clips,[{sourceId:"source-1",start:5,end:22}]);
  assert.equal(revised.operations.find(x=>x.type==="color_grade").style,"cinematic");
});
test("UGC Director fails rather than inventing unsupported footage duration", () => {
  assert.throws(()=>createUgcDirectorPlan({sourceCatalog:catalog,evidence:{productClips:[{sourceId:"source-1",start:2,end:10}]},prompt:"Make an ad"}),/15–45/);
});
test("UGC Director refinement retains an explicitly locked source sequence", () => {
  const priorPlan = createUgcDirectorPlan({ sourceCatalog: catalog, evidence, prompt: "Add the title Mama Earth Lotion Review at 0:07" });
  const refined = createUgcDirectorPlan({
    priorPlan, sourceCatalog: catalog, evidence: { productClips: [{ sourceId: "source-1", start: 6, end: 26 }] },
    prompt: "Make it more premium and luxurious while preserving selected shots.", locked: ["sequence", "title"]
  });
  assert.equal(isUgcDirectorFollowUp("Make it more premium and luxurious while preserving selected shots.", priorPlan), true);
  assert.deepEqual(refined.operations[0].clips, priorPlan.operations[0].clips);
  assert.equal(refined.operations.find((operation) => operation.type === "title").text, "Mama Earth Lotion Review");
});
test("ambiguous title-only wording is rejected before it can rewrite title text", () => {
  const director = createUgcDirectorPlan({ sourceCatalog: catalog, evidence, prompt: "Add the title Mama Earth Lotion Review at 0:07" });
  assert.equal(isAmbiguousUgcTitleRevision("Change only the title styling.", director), true);
  assert.equal(isAmbiguousUgcTitleRevision('Add the title "A NIGHT IN BANGALORE" using Instrument Serif.', director), false);
});
