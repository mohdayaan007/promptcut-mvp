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
  if (p.includes("blue")) return "blue";
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

/* -------------------- STABLE NORMALIZATION -------------------- */
/* 
   - No forced padding
   - No fixed 1280x720
   - Keeps aspect ratio
   - Handles 4K phone videos safely
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
    "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p",
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

/* -------------------- COLOR FILTERS -------------------- */

function buildColorFilter(color) {
  if (!color) return null;

  if (color === "bw") {
    return "format=gray";
  }

  if (color === "cinematic") {
    return "eq=contrast=1.15:saturation=1.05:brightness=0.02";
  }

  if (color === "warm") {
    return "eq=contrast=1.05:saturation=1.10:brightness=0.01";
  }

  if (color === "blue") {
    return "eq=contrast=1.05:saturation=1.08:brightness=-0.01";
  }

  return null;
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

    /* -------- MERGE -------- */
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
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        merged
      ]);

      baseVideo = merged;
    }

    /* -------- COLOR + TITLE -------- */

    const color = detectColor(prompt);
    const overlay = parseOverlay(prompt);

    const filters = [];

    const colorFilter = buildColorFilter(color);
    if (colorFilter) filters.push(colorFilter);

    if (overlay) {
      filters.push(
        `drawtext=text='${overlay.text.replace(/'/g, "\\'")}':` +
        `x=(w-text_w)/2:` +
        `y=(h-text_h)/2:` +
        `fontsize=h*0.07:` +
        `fontcolor=white:` +
        `enable='between(t,${overlay.start},${overlay.end})'`
      );
    }

    if (filters.length) {
      await exec(FFMPEG, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", baseVideo,
        "-vf", filters.join(","),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "128k",
        processed
      ]);
    } else {
      processed = baseVideo;
    }

    let finalVideo = processed;

    /* -------- TRIM -------- */

    const trim = parseTrim(prompt);
    if (trim) {
      const dur = await getDuration(processed);
      const start = Math.max(0, trim.start);
      const end = Math.min(trim.end, dur);

      if (end <= start) {
        throw new Error("Invalid trim range");
      }

      await exec(FFMPEG, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-ss", start.toString(),
        "-to", end.toString(),
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

    /* -------- FINAL ENCODE -------- */

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
