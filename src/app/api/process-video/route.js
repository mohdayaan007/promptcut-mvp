import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = (cmd, args) =>
  promisify(execFile)(cmd, args, {
    maxBuffer: 1024 * 1024 * 20
  });

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

export const runtime = "nodejs";

/* -------------------- PARSERS -------------------- */

function detectColor(prompt = "") {
  const p = prompt.toLowerCase();
  if (p.includes("black and white") || p.includes("bw")) return "bw";
  if (p.includes("cinematic")) return "cinematic";
  if (p.includes("blue") || p.includes("cool")) return "blue";
  if (p.includes("warm")) return "warm";
  return null;
}

function parseOverlay(prompt = "") {
  const m = prompt.match(/add title:\s*(.+?)\s*at\s*(\d+):(\d+)/i);
  if (!m) return null;

  const start = parseInt(m[2]) * 60 + parseInt(m[3]);
  return { text: m[1].trim(), start, end: start + 3 };
}

function parseTrim(prompt = "") {
  const m = prompt.match(/trim.*?(\d+):(\d+)\s*to\s*(\d+):(\d+)/i);
  if (!m) return null;

  return {
    start: parseInt(m[1]) * 60 + parseInt(m[2]),
    end: parseInt(m[3]) * 60 + parseInt(m[4])
  };
}

/* -------------------- HELPERS -------------------- */

async function getDuration(file) {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file
  ]);
  return parseFloat(stdout.trim());
}

/* 
  🔥 NEW NORMALIZATION:
  - Forces constant frame rate
  - Forces 1280 width
  - Auto height
  - Fixes SAR
  - Converts pixel format safely
  - Removes HDR color space metadata
*/
async function normalize(input, output) {
  await exec(FFMPEG, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",

    "-noautorotate",
    "-fflags", "+genpts",
    "-i", input,

    "-vf",
    "scale=1280:-2:flags=lanczos," +
    "format=yuv420p," +
    "setsar=1," +
    "fps=30",

    "-af", "aresample=48000",

    "-movflags", "+faststart",

    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",

    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.0",
    "-pix_fmt", "yuv420p",

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
    const prompt = formData.get("prompt") || "";

    if (!file1) {
      return Response.json({ error: "Missing video" }, { status: 400 });
    }

    const tmp = path.join(os.tmpdir(), `cliponaut-${Date.now()}`);
    if (!existsSync(tmp)) await mkdir(tmp);

    const v1 = path.join(tmp, "v1.mp4");
    const v2 = path.join(tmp, "v2.mp4");
    const n1 = path.join(tmp, "n1.mp4");
    const n2 = path.join(tmp, "n2.mp4");
    const merged = path.join(tmp, "merged.mp4");
    const processed = path.join(tmp, "processed.mp4");
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
        "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        merged
      ]);

      baseVideo = merged;
    }

    const color = detectColor(prompt);
    const overlay = parseOverlay(prompt);

    let filterChain = [];

    if (color === "bw") {
      filterChain.push("format=gray");
    }

    if (color && color !== "bw") {
      const lut = path.join(process.cwd(), "luts", `${color}.cube`);
      filterChain.push(`lut3d=${lut}`);
    }

    if (overlay) {
      filterChain.push(
        `drawtext=text='${overlay.text.replace(/'/g, "\\'")}':` +
        `x=(w-text_w)/2:y=(h-text_h)/2:` +
        `fontsize=h*0.07:fontcolor=white:` +
        `enable='between(t,${overlay.start},${overlay.end})'`
      );
    }

    await exec(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", baseVideo,
      "-vf", filterChain.length ? filterChain.join(",") : "null",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      processed
    ]);

    let finalVideo = processed;
    const trim = parseTrim(prompt);

    if (trim) {
      const dur = await getDuration(processed);
      const start = Math.max(0, trim.start);
      const end = Math.min(trim.end, dur);

      if (end <= start) throw new Error("Invalid trim range");

      await exec(FFMPEG, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-ss", start.toString(),
        "-to", end.toString(),
        "-i", processed,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        trimmed
      ]);

      finalVideo = trimmed;
    }

    await exec(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", finalVideo,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-ar", "48000",
      output
    ]);

    if (!existsSync(output)) {
      throw new Error("Processing failed before output generation");
    }

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
