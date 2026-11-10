import { validateEditPlan } from "@/lib/editor-core/plan-validator";

/**
 * CE-1 is intentionally a sealed, founder-review prototype. It is not a
 * public planner capability: transcript-backed selections and visual layers
 * are owned here, not accepted from a prompt or a model response.
 */
export const CE1_SOURCE_ID = "source-1";
export const CE1_OUTPUT_DURATION = 11.9;

export const CE1_TRANSCRIPT_EVIDENCE = Object.freeze([
  Object.freeze({ evidenceId: "source-1-seg-1", start: 0.8, end: 2.1, text: "Hey team A16Z." }),
  Object.freeze({ evidenceId: "source-1-seg-2", start: 2.1, end: 3.2, text: "I am Mohammad Ayan." }),
  Object.freeze({ evidenceId: "source-1-seg-7", start: 20.8, end: 23, text: "Last few months I've been working on Clip or Not." }),
  Object.freeze({ evidenceId: "source-1-seg-8", start: 23.1, end: 26.2, text: "Clip or Not is basically ChatGPT for video editing." }),
  Object.freeze({ evidenceId: "source-1-seg-22", start: 73.6, end: 77.7, text: "It's more of a crossover between DaVinci Resolve and ChatGPT." })
]);

const CE1_CLIPS = Object.freeze([
  Object.freeze({ sourceId: CE1_SOURCE_ID, start: 0.8, end: 3.2 }),
  Object.freeze({ sourceId: CE1_SOURCE_ID, start: 20.8, end: 26.2 }),
  Object.freeze({ sourceId: CE1_SOURCE_ID, start: 73.6, end: 77.7 })
]);

/** A restrained cool treatment, separate from the seven shipped profiles. */
export const CE1_VISUAL_ADJUSTMENT = Object.freeze({
  brightness: -0.025,
  contrast: 0.08,
  saturation: -0.02,
  temperature: -0.035,
  tint: 0.005
});

export function createCe1FounderReelPlan() {
  return {
    version: "2",
    operations: [
      { type: "sequence", clips: CE1_CLIPS.map((clip) => ({ ...clip })) },
      { type: "visual_adjustment", ...CE1_VISUAL_ADJUSTMENT }
    ]
  };
}

function fail(message) {
  throw new Error(`Invalid CE-1 founder reel: ${message}`);
}

/**
 * Verifies the private composition still has precisely the source evidence it
 * was designed around. It deliberately rejects a caller-supplied sequence.
 */
export function validateCe1FounderReelPlan(plan, sourceCatalog = []) {
  const source = sourceCatalog.find((candidate) => candidate?.sourceId === CE1_SOURCE_ID);
  if (!source || !Number.isFinite(source.duration)) fail("source-1 media evidence is required");
  if (source.duration + 0.01 < CE1_CLIPS.at(-1).end) fail("source evidence does not cover the final selected range");
  const validated = validateEditPlan(plan, { sourceCatalog });
  const sequence = validated.operations.find((operation) => operation.type === "sequence");
  if (!sequence || sequence.clips.length !== CE1_CLIPS.length) fail("requires the sealed three-beat sequence");
  for (const [index, clip] of sequence.clips.entries()) {
    const expected = CE1_CLIPS[index];
    if (clip.sourceId !== expected.sourceId || clip.start !== expected.start || clip.end !== expected.end) {
      fail("sequence differs from transcript-backed CE-1 selections");
    }
  }
  const duration = sequence.clips.reduce((total, clip) => total + (clip.end - clip.start), 0);
  if (Math.abs(duration - CE1_OUTPUT_DURATION) > 0.001) fail("unexpected output duration");
  return Object.freeze({ plan: validated, duration, transcriptEvidence: CE1_TRANSCRIPT_EVIDENCE });
}

function assTime(seconds) {
  const centiseconds = Math.round(seconds * 100);
  const secondsPart = Math.floor(centiseconds / 100);
  return `0:${String(Math.floor(secondsPart / 60)).padStart(2, "0")}:${String(secondsPart % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}

function dialogue(start, end, text) {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;
}

/**
 * Fixed, local ASS composition. \move and \fad are libass primitives whose
 * inputs here are server-owned literals; no HTML, URL, model text, or user
 * supplied renderer syntax reaches the filter.
 */
export function createCe1KineticAssDocument() {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Inter,48,&H00FFFFFF,&H00FFFFFF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
  const layers = [
    // Beat one: verified source introduction. The thin colour bars are a
    // bounded vector-graphic overlay, not an external asset.
    dialogue(0, 2.4, "{\\an7\\pos(76,86)\\fad(140,180)\\move(38,86,76,86,0,220)\\fnBarlow Condensed ExtraBold\\fs104\\b1\\c&H00FFFFFF&}MOHAMMAD"),
    dialogue(0.32, 2.4, "{\\an7\\pos(76,184)\\fad(120,180)\\move(38,184,76,184,0,220)\\fnInstrument Serif\\fs92\\i1\\c&H003DD5FF&}AYAN"),
    dialogue(0, 2.35, "{\\an7\\pos(76,282)\\fad(120,180)\\p1\\c&H003DD5FF&}m 0 0 l 286 0 286 12 0 12"),
    dialogue(0.35, 2.3, "{\\an7\\pos(1138,92)\\fad(120,180)\\fnInter\\fs22\\b1\\c&H00FFFFFF&}01 / FOUNDER"),
    // Beat two: exact product words from source segments 7–8.
    dialogue(2.4, 7.8, "{\\an7\\pos(76,88)\\fad(120,180)\\move(76,116,76,88,0,210)\\fnBarlow Condensed ExtraBold\\fs110\\b1\\c&H00FFFFFF&}CLIP OR NOT"),
    dialogue(2.67, 7.8, "{\\an7\\pos(76,198)\\fad(120,180)\\move(76,230,76,198,0,220)\\fnInstrument Serif\\fs72\\i1\\c&H002F3145&}ChatGPT"),
    dialogue(2.67, 7.8, "{\\an7\\pos(356,216)\\fad(120,180)\\fnInter\\fs38\\b1\\c&H00FFFFFF&}for video editing"),
    dialogue(2.5, 7.75, "{\\an7\\pos(76,286)\\fad(120,180)\\p1\\c&H00354BE9&}m 0 0 l 390 0 390 10 0 10"),
    dialogue(2.65, 7.7, "{\\an9\\pos(1200,640)\\fad(120,180)\\fnInter\\fs20\\b1\\c&H00FFFFFF&}MAKE THE CUT"),
    // Beat three: exact named tools, presented with type hierarchy rather
    // than a claim of a formal partnership or a copied reference graphic.
    dialogue(7.8, 11.9, "{\\an7\\pos(76,86)\\fad(120,180)\\move(38,86,76,86,0,220)\\fnBarlow Condensed ExtraBold\\fs88\\b1\\c&H00FFFFFF&}DAVINCI RESOLVE"),
    dialogue(8.04, 11.9, "{\\an7\\pos(76,182)\\fad(120,180)\\fnInstrument Serif\\fs76\\i1\\c&H003DD5FF&}and ChatGPT"),
    dialogue(7.9, 11.85, "{\\an7\\pos(76,270)\\fad(120,180)\\p1\\c&H003DD5FF&}m 0 0 l 310 0 310 12 0 12"),
    dialogue(8.15, 11.8, "{\\an9\\pos(1200,640)\\fad(120,180)\\fnInter\\fs20\\b1\\c&H00FFFFFF&}02 / PRODUCT"),
    // A small animated red accent moves independently of the words.
    dialogue(2.4, 7.8, "{\\an7\\move(76,320,330,320,0,900)\\fad(100,160)\\p1\\c&H00354BE9&}m 0 0 l 90 0 90 8 0 8")
  ];
  return `${[...header, ...layers].join("\n")}\n`;
}

