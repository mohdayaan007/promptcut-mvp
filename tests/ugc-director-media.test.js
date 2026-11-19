import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createUgcDirectorPlan, reviseUgcTitle } from "../src/lib/editor-core/ugc-director.js";
import { executeEditPlan } from "../src/lib/editor-core/edit-executor.js";
import { probeVideoFile } from "../src/lib/media/media-probe.js";
import { removeOutputInterval } from "../src/lib/editor-core/conversation-state.js";

const run = promisify(execFile);
// Five full-height FFmpeg renders are intentionally retained as durable media
// evidence. GitHub-hosted runners can take longer than the former 90 seconds.
test("deterministic UGC Director fixture renders playable titled vertical MP4 revisions", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-ugc-director-"));
  try {
    const input = path.join(root, "ugc-fixture.mp4");
    await run("ffmpeg", ["-v","error","-y","-f","lavfi","-i","testsrc2=size=720x1280:rate=30","-f","lavfi","-i","aevalsrc=0.15*sin(2*PI*(220*t+4*t*t)):s=48000","-t","32","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",input]);
    const media = await probeVideoFile(input);
    const catalog = [{sourceId:"source-1",index:0,ordinal:1,filename:"ugc-fixture.mp4",duration:media.duration,width:media.width,height:media.height,hasAudio:true}];
    const initial = createUgcDirectorPlan({sourceCatalog:catalog,evidence:{productClips:[{sourceId:"source-1",start:2,end:28}]},prompt:"Create a premium skincare advertisement. Add the title Mama Earth Lotion Review at 0:07 in a luxury font."});
    // Synthetic equivalents of both customer conversations. The fixture is
    // intentionally explicit about evidence; it proves FFmpeg semantics, not
    // product recognition or creative taste from a real model.
    const refined = createUgcDirectorPlan({priorPlan:initial,sourceCatalog:catalog,evidence:{productClips:[{sourceId:"source-1",start:3,end:27}]},prompt:"Make it more premium and luxurious while preserving selected shots and title.",locked:["sequence","title"]});
    const revised = reviseUgcTitle({plan:refined,prompt:"Add the title Mama Earth Lotion Review at 0:07 in a cool luxury font",sourceCatalog:catalog});
    const removed = removeOutputInterval(initial, 10, 14, catalog);
    const renamed = reviseUgcTitle({plan:removed,prompt:'Add the title "Glow Starts Here" using Instrument Serif at 0:07',sourceCatalog:catalog});
    const paced = createUgcDirectorPlan({priorPlan:renamed,sourceCatalog:catalog,evidence:{productClips:[{sourceId:"source-1",start:4,end:26}]},prompt:"Improve the pacing while preserving selected shots and title.",locked:["sequence","title"]});
    const firstDir = path.join(root,"first"), secondDir = path.join(root,"second"), thirdDir = path.join(root,"third"), fourthDir = path.join(root,"fourth"), fifthDir = path.join(root,"fifth"); await Promise.all([firstDir,secondDir,thirdDir,fourthDir,fifthDir].map((directory)=>mkdir(directory)));
    const first = await executeEditPlan({inputPaths:[input],media:[media],plan:initial,sourceCatalog:catalog,tempDirectory:firstDir});
    const second = await executeEditPlan({inputPaths:[input],media:[media],plan:revised,sourceCatalog:catalog,tempDirectory:secondDir});
    const third = await executeEditPlan({inputPaths:[input],media:[media],plan:removed,sourceCatalog:catalog,tempDirectory:thirdDir});
    const fourth = await executeEditPlan({inputPaths:[input],media:[media],plan:renamed,sourceCatalog:catalog,tempDirectory:fourthDir});
    const fifth = await executeEditPlan({inputPaths:[input],media:[media],plan:paced,sourceCatalog:catalog,tempDirectory:fifthDir});
    for (const [output, expectedDuration] of [[first,26],[second,26],[third,22],[fourth,22],[fifth,22]]) { const probe=await probeVideoFile(output); assert.ok(Math.abs(probe.duration-expectedDuration)<0.2); assert.equal(probe.width,720); assert.equal(probe.height,1280); assert.equal(probe.hasAudio,true); await run("ffmpeg",["-v","error","-xerror","-i",output,"-f","null","-"]); }
    const evidence = process.env.UGC_DIRECTOR_EVIDENCE_DIRECTORY;
    if (evidence) { await mkdir(evidence,{recursive:true}); await Promise.all([
      [first,"workflow-a-product-selection.mp4"],[second,"workflow-a-title-revision.mp4"],
      [third,"workflow-b-timestamp-removal.mp4"],[fourth,"workflow-b-title-revision.mp4"],[fifth,"workflow-b-director-refinement.mp4"]
    ].map(([output,name])=>copyFile(output,path.join(evidence,name)))); }
  } finally { await rm(root,{recursive:true,force:true}); }
});
