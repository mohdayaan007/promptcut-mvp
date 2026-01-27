import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export const runtime = "nodejs";

const MAX_SIZE_MB = 50;
const MAX_DURATION_SEC = 60;

/* -------------------- PARSERS -------------------- */

function parseOverlay(prompt) {
  const match = prompt.match(/add title:\s*(.+?)\s*at\s*(\d+):(\d+)/i);
  if (!match) return null;

  const text = match[1].trim();
  const start = parseInt(match[2]) * 60 + parseInt(match[3]);
  const end = start + 3;

  return { text, start, end };
}

function detectColor(prompt) {
  const p = prompt.toLowerCase();

  if (p.includes("black and white") || p.includes("bw") || p.includes("monochrome"))
    return "bw";

  if (p.includes("cinematic") || p.includes("film") || p.includes("movie"))
    return "cinematic";

  if (p.includes("blue") || p.includes("cool") || p.includes("cold") || p.includes("night"))
    return "blue";

  if (p.includes("warm") || p.includes("sunset") || p.includes("cozy"))
    return "warm";

  return null;
}

function wantsSubtitles(prompt) {
  const p = prompt.toLowerCase();
  return (
    p.includes("subtitle") ||
    p.includes("subtitles") ||
    p.includes("caption") ||
    p.includes("captions")
  );
}

/* -------------------- HELPERS -------------------- */

async function getDuration(filePath) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  return parseFloat(stdout.trim());
}

async function normalize(input, output) {
  await exec("ffmpeg", [
    "-y",
    "-i", input,

    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease," +
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",

    "-af",
    "aresample=48000,asetpts=PTS-STARTPTS",

    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.1",

    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",

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

    const tmpDir = path.join(os.tmpdir(), `promptcut-${Date.now()}`);
    if (!existsSync(tmpDir)) await mkdir(tmpDir);

    const v1 = path.join(tmpDir, "v1.mp4");
    const v2 = path.join(tmpDir, "v2.mp4");
    const n1 = path.join(tmpDir, "n1.mp4");
    const n2 = path.join(tmpDir, "n2.mp4");
    const list = path.join(tmpDir, "list.txt");
    const merged = path.join(tmpDir, "merged.mp4");
    const audio = path.join(tmpDir, "audio.wav");
    const subs = path.join(tmpDir, "audio.srt");
    const output = path.join(tmpDir, "output.mp4");

    await writeFile(v1, Buffer.from(await file1.arrayBuffer()));
    await normalize(v1, n1);

    let baseVideo = n1;

    if (file2) {
      await writeFile(v2, Buffer.from(await file2.arrayBuffer()));
      await normalize(v2, n2);

      await writeFile(list, `file '${n1}'\nfile '${n2}'\n`);
      await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", merged]);
      baseVideo = merged;
    }

    const overlay = parseOverlay(prompt);
    const color = detectColor(prompt);
    const subtitles = wantsSubtitles(prompt);

    /* --------- SUBTITLES (WHISPER) --------- */

    if (subtitles) {
      await exec("ffmpeg", ["-y", "-i", baseVideo, "-vn", "-ac", "1", "-ar", "16000", audio]);

      await exec("python3", [
  "-m", "whisper",
  audio,

  // 🔒 ALWAYS TRANSLATE TO ENGLISH
  "--task", "translate",
  "--language", "en",

  "--model", "tiny",
  "--output_format", "srt",
  "--output_dir", tmpDir
]);


      if (!existsSync(subs)) {
        throw new Error("Subtitle generation failed");
      }
    }

    /* --------- FILTERS --------- */

    const filters = [];

    if (color === "bw") {
      filters.push("format=gray");
    }

    if (color && color !== "bw") {
      const lutPath = path.join(process.cwd(), "luts", `${color}.cube`);
      const strength =
        color === "warm" ? 0.22 :
        color === "blue" ? 0.30 :
        color === "cinematic" ? 0.28 : 0.25;

      filters.push(
        `[0:v]split=2[base][graded];` +
        `[graded]lut3d=file=${lutPath},format=rgba,colorchannelmixer=aa=${strength}[lut];` +
        `[base][lut]overlay`
      );
    }

    if (subtitles) {
      filters.push(`subtitles=${subs}`);
    }

    if (overlay) {
      const safeText = overlay.text.replace(/'/g, "\\'");
      filters.push(
        `drawtext=text='${safeText}':x=(w-text_w)/2:y=(h-text_h)/2:` +
        `fontsize=h*0.07:fontcolor=white:` +
        `enable='between(t,${overlay.start},${overlay.end})'`
      );
    }

    const vf = filters.length ? filters.join(",") : "null";

    await exec("ffmpeg", [
      "-y",
      "-i", baseVideo,
      "-vf", vf,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      output
    ]);

    const buffer = await import("fs").then(fs => fs.promises.readFile(output));

    return new Response(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": "attachment; filename=promptcut.mp4"
      }
    });

  } catch (err) {
    console.error("ERROR:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
