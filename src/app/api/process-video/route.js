import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import fs from "fs";
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
  return { text: m[1], start, end: start + 3 };
}

function parseTrim(prompt = "") {
  const m = prompt.match(/trim.*?(\d+):(\d+)\s*to\s*(\d+):(\d+)/i);
  if (!m) return null;
  return {
    start: parseInt(m[1]) * 60 + parseInt(m[2]),
    end: parseInt(m[3]) * 60 + parseInt(m[4])
  };
}

function wantsSubtitles(prompt = "") {
  const p = prompt.toLowerCase();
  return p.includes("subtitle") || p.includes("captions");
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

async function normalize(input, output) {
  await exec(FFMPEG, [
    "-y",
    "-i", input,
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease," +
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
    "-af", "aresample=48000,asetpts=PTS-STARTPTS",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    output
  ]);
}

/* -------------------- API -------------------- */

export async function POST(req) {
  try {
    const formData = await req.formData();
    const video1 = formData.get("video1");
    const video2 = formData.get("video2");
    const prompt = formData.get("prompt") || "";

    if (!video1) {
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
    const audio = path.join(tmp, "audio.wav");
    const srt = path.join(tmp, "audio.srt");
    const output = path.join(tmp, "output.mp4");

    /* ---------- NORMALIZE ---------- */

    await writeFile(v1, Buffer.from(await video1.arrayBuffer()));
    await normalize(v1, n1);

    let baseVideo = n1;

    if (video2) {
      await writeFile(v2, Buffer.from(await video2.arrayBuffer()));
      await normalize(v2, n2);

      const list = path.join(tmp, "list.txt");
      fs.writeFileSync(list, `file '${n1}'\nfile '${n2}'\n`);

      await exec(FFMPEG, [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", list,
        "-c", "copy",
        merged
      ]);

      baseVideo = merged;
    }

    /* ---------- COLOR + TITLE ---------- */

    const filters = [];
    const color = detectColor(prompt);
    const overlay = parseOverlay(prompt);

    if (color === "bw") filters.push("format=gray");

    if (color && color !== "bw") {
      const lut = path.join(process.cwd(), "luts", `${color}.cube`);
      const strength =
        color === "warm" ? 0.22 :
        color === "blue" ? 0.3 :
        color === "cinematic" ? 0.28 : 0.25;

      filters.push(
        `[0:v]split=2[a][b];` +
        `[b]lut3d=${lut},format=rgba,colorchannelmixer=aa=${strength}[c];` +
        `[a][c]overlay`
      );
    }

    if (overlay) {
      filters.push(
        `drawtext=text='${overlay.text.replace(/'/g, "\\'")}':` +
        `x=(w-text_w)/2:y=(h-text_h)/2:` +
        `fontsize=h*0.07:fontcolor=white:` +
        `enable='between(t,${overlay.start},${overlay.end})'`
      );
    }

    await exec(FFMPEG, [
      "-y",
      "-i", baseVideo,
      "-vf", filters.length ? filters.join(",") : "null",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      processed
    ]);

    /* ---------- TRIM ---------- */

    let finalVideo = processed;
    const trim = parseTrim(prompt);

    if (trim) {
      const dur = await getDuration(processed);
      const start = Math.max(0, trim.start);
      const end = Math.min(trim.end, dur);

      await exec(FFMPEG, [
        "-y",
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

    /* ---------- SUBTITLES ---------- */

    if (wantsSubtitles(prompt)) {
      await exec(FFMPEG, [
        "-y",
        "-i", finalVideo,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        audio
      ]);

      await exec("python3", [
        "-m", "whisper",
        audio,
        "--model", "tiny",
        "--task", "translate",
        "--language", "en",
        "--output_format", "srt",
        "--output_dir", tmp
      ]);

      if (existsSync(srt)) {
        await exec(FFMPEG, [
          "-y",
          "-i", finalVideo,
          "-vf", `subtitles=${srt}`,
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-c:a", "copy",
          output
        ]);
      } else {
        await exec(FFMPEG, ["-y", "-i", finalVideo, "-c", "copy", output]);
      }
    } else {
      await exec(FFMPEG, ["-y", "-i", finalVideo, "-c", "copy", output]);
    }

    const buffer = await fs.promises.readFile(output);

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
