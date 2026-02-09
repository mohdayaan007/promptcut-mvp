import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

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

/* 🔥 STABLE NORMALIZATION (MERGE SAFE) */
async function normalize(input, output) {
  await exec(FFMPEG, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-noautorotate",
    "-i", input,
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease," +
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
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

      /* 🔥 STABLE CONCAT */
      await exec(FFMPEG, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", n1,
        "-i", n2,
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v];" +
        "[0:a][1:a]concat=n=2:v=0:a=1[a]",
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

    const color = detectColor(prompt);
    const overlay = parseOverlay(prompt);
    const trim = parseTrim(prompt);
    const filters = [];

    /* 🎨 COLOR GRADING (VISIBLE + STABLE) */

    if (color === "bw") {
      filters.push("hue=s=0");
    }

    if (color === "blue") {
      filters.push(
        "colorchannelmixer=rr=0.85:gg=0.95:bb=1.25,eq=saturation=1.1"
      );
    }

    if (color === "warm") {
      filters.push(
        "colorchannelmixer=rr=1.2:gg=1.05:bb=0.85,eq=saturation=1.1"
      );
    }

    if (color === "cinematic") {
  filters.push(
    "curves=preset=medium_contrast,eq=saturation=1.05"
  );
}

    if (overlay) {
      filters.push(
        `drawtext=text='${overlay.text.replace(/'/g, "\\'")}':` +
        `x=(w-text_w)/2:y=h*0.1:` +
        `fontsize=40:fontcolor=white:` +
        `enable='between(t,${overlay.start},${overlay.end})'`
      );
    }

    await exec(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", baseVideo,
      "-vf", filters.length ? filters.join(",") : "null",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "128k",
      processed
    ]);

    let finalVideo = processed;

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
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        trimmed
      ]);

      finalVideo = trimmed;
    }

    /* FINAL SAFE ENCODE */

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
