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

const run = promisify(execFile);
test("deterministic UGC Director fixture renders playable titled vertical MP4 revisions", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-ugc-director-"));
  try {
    const input = path.join(root, "ugc-fixture.mp4");
    await run("ffmpeg", ["-v","error","-y","-f","lavfi","-i","testsrc2=size=720x1280:rate=30","-f","lavfi","-i","aevalsrc=0.15*sin(2*PI*(220*t+4*t*t)):s=48000","-t","32","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",input]);
    const media = await probeVideoFile(input);
    const catalog = [{sourceId:"source-1",index:0,ordinal:1,filename:"ugc-fixture.mp4",duration:media.duration,width:media.width,height:media.height,hasAudio:true}];
    const initial = createUgcDirectorPlan({sourceCatalog:catalog,evidence:{productClips:[{sourceId:"source-1",start:2,end:28}]},prompt:"Create a premium skincare advertisement. Add the title Mama Earth Lotion Review at 0:07 in a luxury font."});
    const revised = reviseUgcTitle({plan:initial,prompt:"Add the title Mama Earth Lotion Review at 0:07 in a cool luxury font",sourceCatalog:catalog});
    const firstDir = path.join(root,"first"), secondDir = path.join(root,"second"); await mkdir(firstDir); await mkdir(secondDir);
    const first = await executeEditPlan({inputPaths:[input],media:[media],plan:initial,sourceCatalog:catalog,tempDirectory:firstDir});
    const second = await executeEditPlan({inputPaths:[input],media:[media],plan:revised,sourceCatalog:catalog,tempDirectory:secondDir});
    for (const output of [first,second]) { const probe=await probeVideoFile(output); assert.ok(Math.abs(probe.duration-26)<0.2); assert.equal(probe.width,720); assert.equal(probe.height,1280); assert.equal(probe.hasAudio,true); await run("ffmpeg",["-v","error","-xerror","-i",output,"-f","null","-"]); }
    const evidence = process.env.UGC_DIRECTOR_EVIDENCE_DIRECTORY;
    if (evidence) { await mkdir(evidence,{recursive:true}); await copyFile(first,path.join(evidence,"workflow-a-director.mp4")); await copyFile(second,path.join(evidence,"workflow-a-title-revision.mp4")); }
  } finally { await rm(root,{recursive:true,force:true}); }
});
