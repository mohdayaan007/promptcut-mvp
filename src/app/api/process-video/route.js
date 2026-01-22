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

function parseOverlay(prompt) {
  // Example: "Add title: My Day at 0:05"
  const match = prompt.match(/add title:\s*(.+?)\s*at\s*(\d+):(\d+)/i);
  if (!match) return null;

  const text = match[1].trim();
  const start = parseInt(match[2]) * 60 + parseInt(match[3]);
  const end = start + 3;

  return { text, start, end };
}

async function getDuration(filePath) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);

  return parseFloat(stdout.trim());
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file1 = formData.get("video1");
    const file2 = formData.get("video2");
    const prompt = formData.get("prompt") || "";

    if (!file1 || !file2) {
      return Response.json({ error: "Missing files" }, { status: 400 });
    }

    const sizeMB1 = file1.size / (1024 * 1024);
    const sizeMB2 = file2.size / (1024 * 1024);

    if (sizeMB1 > MAX_SIZE_MB || sizeMB2 > MAX_SIZE_MB) {
      return Response.json({ error: "File too large" }, { status: 400 });
    }

    const tmpDir = path.join(os.tmpdir(), `promptcut-${Date.now()}`);
    if (!existsSync(tmpDir)) await mkdir(tmpDir);

    const p1 = path.join(tmpDir, "a.mp4");
    const p2 = path.join(tmpDir, "b.mp4");
    const listFile = path.join(tmpDir, "list.txt");
    const merged = path.join(tmpDir, "merged.mp4");
    const output = path.join(tmpDir, "output.mp4");

    await writeFile(p1, Buffer.from(await file1.arrayBuffer()));
    await writeFile(p2, Buffer.from(await file2.arrayBuffer()));
    await writeFile(listFile, `file '${p1}'\nfile '${p2}'\n`);

    const d1 = await getDuration(p1);
    const d2 = await getDuration(p2);

    if (d1 > MAX_DURATION_SEC || d2 > MAX_DURATION_SEC) {
      return Response.json({ error: "Video too long" }, { status: 400 });
    }

    // Normalize + merge
    await exec("ffmpeg", [
      "-y",
      "-i", p1,
      "-vf", "scale=1280:-2,fps=30",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      path.join(tmpDir, "n1.mp4")
    ]);

    await exec("ffmpeg", [
      "-y",
      "-i", p2,
      "-vf", "scale=1280:-2,fps=30",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      path.join(tmpDir, "n2.mp4")
    ]);

    await writeFile(
      listFile,
      `file '${path.join(tmpDir, "n1.mp4")}'\nfile '${path.join(tmpDir, "n2.mp4")}'\n`
    );

    await exec("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      merged
    ]);

    const overlay = parseOverlay(prompt);

    let filter = "format=gray";

    if (overlay) {
      const safeText = overlay.text.replace(/'/g, "\\'");
      filter += `,drawtext=text='${safeText}':x=(w-text_w)/2:y=h*0.15:fontsize=h*0.07:fontcolor=white:enable='between(t,${overlay.start},${overlay.end})'`;
    }

    await exec("ffmpeg", [
      "-y",
      "-i", merged,
      "-vf", filter,
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
    return Response.json(
      { error: "Processing failed" },
      { status: 500 }
    );
  }
}
