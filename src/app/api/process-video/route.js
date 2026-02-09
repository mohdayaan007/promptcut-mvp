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

/* -------------------- NORMALIZE -------------------- */

async function normalize(input, output) {
  await exec(FFMPEG, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-noautorotate",
    "-i", input,
    "-vf",
    "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p,setsar=1",
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

    const color = detectColor(prompt);
    const overlay = parseOverlay(prompt);
    const trim = parseTrim(prompt);

    let filters = [];

    /* ---- COLOR GRADING ---- */

    if (color === "bw") {
  filters.push("hue=s=0");
}

if (color === "cinematic") {
  filters.push(
    "eq=contrast=1.12:saturation=1.08:brightness=0.01",
    "colorchannelmixer=rr=1.04:gg=1.0:bb=0.96"
  );
}

if (color === "warm") {
  filters.push(
    "eq=contrast=1.05:saturation=1.07:brightness=0.02",
    "colorchannelmixer=rr=1.06:gg=1.0:bb=0.94"
  );
}

if (color === "blue") {
  filters.push(
    "eq=contrast=1.05:saturation=1.05",
    "colorchannelmixer=rr=0.94:gg=1.0:bb=1.10"
  );
}

    /* ---- TITLE ---- */

    if (overlay) {
      filters.push(
        `drawtext=text='${overlay.text.replace(/'/g, "\\'")}':` +
        `x=(w-text_w)/2:y=(h-text_h)/2:` +
        `fontsize=h*0.07:fontcolor=white:` +
        `enable='between(t,${overlay.start},${overlay.end})'`
      );
    }

    /* ---- APPLY FILTERS ---- */

    let processed = baseVideo;

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
