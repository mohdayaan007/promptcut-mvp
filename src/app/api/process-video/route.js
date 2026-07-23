import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { COLOR_PRESETS } from "@/lib/color-presets";
import { getIntentPattern, understandPrompt } from "@/lib/prompt-understanding";
import { parseTitle } from "@/lib/title-parser";
import { buildTitleFilter } from "@/lib/title-renderer";

const exec = (cmd, args) =>
  promisify(execFile)(cmd, args, {
    maxBuffer: 1024 * 1024 * 20
  });

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const MAX_VIDEO_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1000;

export const runtime = "nodejs";

/* -------------------- PARSERS -------------------- */

function detectColor(intents = []) {
  if (intents.includes("blackWhite")) return "bw";
  if (intents.includes("cinematic")) return "cinematic";
  if (intents.includes("cool")) return "blue";
  if (intents.includes("warm")) return "warm";
  return null;
}

function parseTrim(prompt = "", intents = []) {
  if (!intents.includes("trim")) return null;

  const m = prompt.match(
    new RegExp(`(?:${getIntentPattern("trim")}).*?(\\d+):(\\d+)\\s*to\\s*(\\d+):(\\d+)`, "i")
  );
  if (!m) return null;

  return {
    start: parseInt(m[1]) * 60 + parseInt(m[2]),
    end: parseInt(m[3]) * 60 + parseInt(m[4])
  };
}

/* -------------------- NORMALIZE (STABLE) -------------------- */

async function normalize(input, output) {
  await exec(FFMPEG, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "+genpts",
    "-noautorotate",
    "-i", input,
    "-vf",
    // FORCE identical resolution for ALL videos
    "scale=1280:720:force_original_aspect_ratio=decrease," +
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2," +
    "fps=30,format=yuv420p,setsar=1",
    "-threads", "2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
    output
  ]);
}

/* -------------------- API -------------------- */

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file1 = formData.get("video1");
    const file2 = formData.get("video2");
    const promptValue = formData.get("prompt");

    if (!(file1 instanceof File)) {
      return Response.json({ error: "video1 must be an uploaded file" }, { status: 400 });
    }

    if (file2 !== null && !(file2 instanceof File)) {
      return Response.json({ error: "video2 must be an uploaded file" }, { status: 400 });
    }

    if (file1.size > MAX_VIDEO_FILE_SIZE_BYTES ||
        file2 instanceof File && file2.size > MAX_VIDEO_FILE_SIZE_BYTES) {
      return Response.json(
        { error: "Each video must be 100 MB or smaller" },
        { status: 413 }
      );
    }

    if (!file1.type.startsWith("video/") ||
        file2 instanceof File && !file2.type.startsWith("video/")) {
      return Response.json({ error: "Uploaded files must be videos" }, { status: 400 });
    }

    if (promptValue !== null && typeof promptValue !== "string") {
      return Response.json({ error: "prompt must be text" }, { status: 400 });
    }

    const prompt = promptValue || "";

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return Response.json(
        { error: "prompt must be 1000 characters or fewer" },
        { status: 400 }
      );
    }

    const tmp = path.join(os.tmpdir(), `cliponaut-${Date.now()}`);
    if (!existsSync(tmp)) await mkdir(tmp);

    const v1 = path.join(tmp, "v1.mp4");
    const v2 = path.join(tmp, "v2.mp4");
    const n1 = path.join(tmp, "n1.mp4");
    const n2 = path.join(tmp, "n2.mp4");
    const merged = path.join(tmp, "merged.mp4");
    const processedPath = path.join(tmp, "processed.mp4");
    const trimmed = path.join(tmp, "trimmed.mp4");
    const output = path.join(tmp, "output.mp4");

    await writeFile(v1, Buffer.from(await file1.arrayBuffer()));
    await normalize(v1, n1);

    let baseVideo = n1;

    if (file2) {
      await writeFile(v2, Buffer.from(await file2.arrayBuffer()));
      await normalize(v2, n2);

      await exec(FFMPEG, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", n1,
        "-i", n2,
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v];[0:a][1:a]concat=n=2:v=0:a=1[a]",
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        merged
      ]);

      baseVideo = merged;
    }

    const { intents } = understandPrompt(prompt);
    const color = detectColor(intents);
    const title = parseTitle(prompt);
    const trim = parseTrim(prompt, intents);

    let filters = [];

    /* ---- COLOR GRADING ---- */

    if (COLOR_PRESETS[color]) {
      filters.push(...COLOR_PRESETS[color]);
    }

    /* ---- TITLE ---- */

    if (title) {
      filters.push(buildTitleFilter(title));
    }

    /* ---- APPLY FILTERS ---- */

let processed = baseVideo;

if (filters.length) {
  await exec(FFMPEG, [
    "-y",
    "-hide_banner",
    "-loglevel", "info",
    "-i", baseVideo,
    "-vf", filters.join(","),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
    processedPath
  ]);

  processed = processedPath;
}

    /* ---- TRIM ---- */

    let finalVideo = processed;

    if (trim) {
      await exec(FFMPEG, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-ss", trim.start.toString(),
        "-to", trim.end.toString(),
        "-i", processed,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        trimmed
      ]);

      finalVideo = trimmed;
    }

    /* ---- FINAL OUTPUT ---- */

    await exec(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", finalVideo,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "128k",
      output
    ]);

    const buffer = await import("fs").then(fs =>
      fs.promises.readFile(output)
    );

    return new Response(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": "attachment; filename=cliponaut.mp4"
      }
    });

  } catch (err) {
    console.error("CLIPONAUT ERROR:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
