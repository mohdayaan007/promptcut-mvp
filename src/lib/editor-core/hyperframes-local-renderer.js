import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CE1_PRODUCT_GRAPHIC, validateCe1FounderReelPlan } from "@/lib/editor-core/ce1-founder-reel";
import { validateCe3HyperframesComposition } from "@/lib/editor-core/ce3-hyperframes-composition";

const exec = promisify(execFile);
const colour = { white: "#f8f7f2", yellow: "#f8d363", red: "#ed4b3a", charcoal: "#263746" };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function layer(layers, id) { return layers.find((candidate) => candidate.id === id); }
function markup(composition) {
  const layers = composition.ce2.textLayers; const title = composition.layout["founder-title"];
  const name = layer(layers, "founder-given-name"); const family = layer(layers, "founder-family-name");
  const product = layer(layers, "product-chatgpt"); const productLine = layer(layers, "product-description");
  const resolve = layer(layers, "crossover-resolve"); const chatgpt = layer(layers, "crossover-chatgpt");
  const clips = [{ id: "intro", start: 0, duration: 2.4, media: .8 }, { id: "product", start: 2.4, duration: 5.4, media: 20.8 }, { id: "closing", start: 7.8, duration: 4.1, media: 73.6 }];
  const videos = clips.map((clip) => `<video class="clip footage" src="source.mp4" playsinline data-start="${clip.start}" data-duration="${clip.duration}" data-media-start="${clip.media}" data-track-index="0" data-has-audio="true"></video>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script><style>*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#111820}.clip{position:absolute}.footage{inset:0;width:100%;height:100%;object-fit:cover;filter:contrast(1.035) saturate(.98)}.panel{z-index:1;background:linear-gradient(90deg,rgba(12,20,31,.72),rgba(12,20,31,.44));border-left:6px solid #ed4b3a;box-shadow:0 20px 48px rgba(0,0,0,.14)}.type{z-index:2;position:absolute;color:#f8f7f2;text-transform:uppercase}.brand{z-index:3;position:absolute;right:112px;bottom:104px;width:235px;filter:brightness(0) invert(1)}.rule{z-index:2;position:absolute;background:#ed4b3a;height:13px}</style></head><body><main data-composition-id="cliponaut-ce3-hyperframes" data-start="0" data-duration="11.9" data-width="1920" data-height="1080" data-fps="30">${videos}<div class="clip panel" data-start="0" data-duration="2.4" data-track-index="1" style="left:68px;top:72px;width:490px;height:348px"></div><div class="clip panel" data-start="2.4" data-duration="5.4" data-track-index="1" style="left:68px;bottom:74px;width:620px;height:410px"></div><div class="clip panel" data-start="7.8" data-duration="4.1" data-track-index="1" style="left:68px;top:88px;width:730px;height:340px"></div><div id="title" class="clip type" data-start=".25" data-duration="2.15" data-track-index="2" style="left:${title.x}px;top:${title.y}px;width:${title.width}px;height:${title.height}px;font:800 ${title.fontSize}px/.78 Arial Narrow,Arial,sans-serif;color:${colour[name.colour]}">${escape(name.text)}<span style="display:block;margin-top:14px;font:italic 82px/.8 Georgia,serif;color:${colour[family.colour]};text-transform:none">${escape(family.text)}</span></div><div class="rule" data-start=".45" data-duration="1.95" data-track-index="2" style="left:${title.x}px;top:${title.y + title.height - 12}px;width:${title.width}px"></div><div id="product-copy" class="clip type" data-start="2.4" data-duration="5.4" data-track-index="2" style="left:108px;bottom:144px;font:800 150px/.75 Arial Narrow,Arial,sans-serif">CLIP OR NOT<span style="display:block;font:italic 92px/.72 Georgia,serif;color:${colour[product.colour]};text-transform:none">${escape(product.text)}</span><small style="display:block;margin-top:32px;font:700 31px/1 Arial,sans-serif;text-transform:none;color:${colour[productLine.colour]}">${escape(productLine.text)}</small></div><div id="closing-copy" class="clip type" data-start="7.8" data-duration="4.1" data-track-index="2" style="left:108px;top:126px;font:800 103px/.8 Arial Narrow,Arial,sans-serif">${escape(resolve.text)}<span style="display:block;margin-top:20px;font:italic 84px/.78 Georgia,serif;color:${colour[chatgpt.colour]};text-transform:none">${escape(chatgpt.text)}</span></div><img class="clip brand" src="cliponaut.svg" data-start="2.9" data-duration="4.45" data-track-index="3"><script>const tl=gsap.timeline({paused:true});tl.from('#title',{opacity:0,y:62,duration:.48,ease:'power4.out'},.22).from('#product-copy',{opacity:0,y:84,duration:.55,ease:'power4.out'},2.48).from('.brand',{opacity:0,x:150,duration:.52,ease:'power3.out'},2.95).from('#closing-copy',{opacity:0,y:70,duration:.55,ease:'power4.out'},7.9);window.__timelines={'cliponaut-ce3-hyperframes':tl};</script></main></body></html>`;
}

export async function renderHyperframesLocally({ composition, sourceCatalog, sourcePath, outputPath, rendererPath, temporaryDirectory, run = exec }) {
  validateCe3HyperframesComposition(composition, sourceCatalog);
  const validated = validateCe1FounderReelPlan(composition.ce2.plan, sourceCatalog);
  if (!rendererPath || !sourcePath || !outputPath || !temporaryDirectory) throw new Error("HyperFrames local renderer requires trusted paths");
  await rm(temporaryDirectory, { recursive: true, force: true }); await mkdir(temporaryDirectory, { recursive: true });
  try {
    await symlink(path.resolve(sourcePath), path.join(temporaryDirectory, "source.mp4"));
    await copyFile(path.resolve(process.cwd(), CE1_PRODUCT_GRAPHIC.relativePath), path.join(temporaryDirectory, "cliponaut.svg"));
    await writeFile(path.join(temporaryDirectory, "index.html"), markup(composition), "utf8");
    await run(rendererPath, ["render", "--quality", "looks", "--workers", "4", "-o", outputPath], { cwd: temporaryDirectory, timeout: 180000 });
    return { outputPath, duration: validated.duration, renderer: "hyperframes-local-adapter/1" };
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}
