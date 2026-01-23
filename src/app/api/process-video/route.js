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

/* -----------------------------
   Prompt Parsers
-------------------------------- */

function parseOverlay(prompt) {
  const match = prompt.match(/add title:\s*(.+?)\s*at\s*(\d+):(\d+)/i);
  if (!match) return null;

  const text = match[1].trim();
  const start = parseInt(match[2]) * 60 + parseInt(match[3]);
  const end = start + 3;

  return { text, start, end };
}

function detectColorStyle(prompt) {
  const p = prompt.toLowerCase();

  if (p.match(/warm|golden|sunset|yellow|cozy/)) return "warm";
  if (p.match(/cool|blue|cold|icy/)) return "cool";
  if (p.match(/cinematic|film|movie|netflix/)) return "cinematic";
  if (p.match(/vintage|retro|old|nostalgic/)) return "vintage";
  if (p.match(/nature|green|forest|earthy/)) return "nature";

  return null;
}

/* -----------------------------
   FFmpeg Helpers
-------------------------------- */

async function getDuration(filePath) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);

  return parseFloat(stdout.trim());
}

function colorFilter(style) {
  switch (style) {
    case "warm":
      return "eq=contrast=1.05:saturation=1.2:brightness=0.03";
    case "cool":
      return "eq=contrast=1.05:saturation=0.9:brightness=-0.02";
    case "cinematic":
      return "eq=contrast=1.15:saturation=1.1,curves=smooth";
    case "vintage":
      return "eq=saturation=0.7:brightness=0.04";
    case "nature":
      return "eq=saturation=1.25:contrast=1.05";
    default:
      return null;
  }
}

/* -----------------------------
   API Route
-------------------------------- */

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file1 = formData.get("video1");
    const file2 = formData.get("video2");
    const prompt = formData.get("prompt") || "";

    if (!file1) {
      return Response.json({ error: "Missing video" }, { status: 400 });
    }

    const files = [file1, file2].filter(Boolean);

    for (const f of files) {
      if (f.size / (1024 * 1024) > MAX_SIZE_MB) {
        return Response.json({ error: "File too large" }, { status: 400 });
      }
    }

    const tmpDir = path.join(os.tmpdir(), `promptcut-${Date.now()}`);
    if (!existsSync(tmpDir)) await mkdir(tmpDir);

    const normalized = [];

    for (let i = 0; i < files.length; i++) {
      const src = path.join(tmpDir, `src${i}.mp4`);
      const norm = path.join(tmpDir, `n${i}.mp4`);

      await writeFile(src, Buffer.from(await files[i].arrayBuffer()));

      const d = await getDuration(src);
      if (d > MAX_DURATION_SEC) {
        return Response.json({ error: "Video too long" }, { status: 400 });
      }

      await exec("ffmpeg", [
        "-y",
        "-i", src,
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        norm
      ]);

      normalized.push(norm);
    }

    let merged = normalized[0];

    if (normalized.length === 2) {
      const list = path.join(tmpDir, "list.txt");
      const out = path.join(tmpDir, "merged.mp4");

      await writeFile(
        list,
        normalized.map(f => `file '${f}'`).join("\n")
      );

      await exec("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", list,
        "-c", "copy",
        out
      ]);

      merged = out;
    }

    const overlay = parseOverlay(prompt);
    const colorStyle = detectColorStyle(prompt);
    console.log("Detected color style:", colorStyle);

    let filters = [];

    const color = colorFilter(colorStyle);
    if (color) filters.push(color);

    if (overlay) {
      const safeText = overlay.text.replace(/'/g, "\\'");
      filters.push(
        `drawtext=text='${safeText}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=h*0.07:fontcolor=white:enable='between(t,${overlay.start},${overlay.end})'`
      );
    }

    const output = path.join(tmpDir, "output.mp4");

    await exec("ffmpeg", [
      "-y",
      "-i", merged,
      ...(filters.length ? ["-vf", filters.join(",")] : []),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      output
    ]);

    const buffer = await import("fs").then(fs =>
      fs.promises.readFile(output)
    );

    return new Response(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": "attachment; filename=promptcut.mp4"
      }
    });

  } catch (err) {
    console.error(err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}
