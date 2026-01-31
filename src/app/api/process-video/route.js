import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { execFile, execSync } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export const runtime = "nodejs";

/* -------------------- HELPERS -------------------- */

function resolveFFmpeg() {
  try {
    return execSync("which ffmpeg").toString().trim();
  } catch {
    throw new Error("ffmpeg not found at runtime");
  }
}

async function normalize(input, output, ffmpegPath) {
  await exec(ffmpegPath, [
    "-y",
    "-i", input,
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease," +
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    output
  ]);
}

/* -------------------- API -------------------- */

export async function POST(req) {
  try {
    // 🔑 Resolve ffmpeg ONLY at runtime
    const FFMPEG = resolveFFmpeg();

    const formData = await req.formData();
    const file = formData.get("video1");

    if (!file) {
      return Response.json({ error: "Missing video" }, { status: 400 });
    }

    const tmpDir = path.join(os.tmpdir(), `cliponaut-${Date.now()}`);
    if (!existsSync(tmpDir)) await mkdir(tmpDir);

    const input = path.join(tmpDir, "input.mp4");
    const output = path.join(tmpDir, "output.mp4");

    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    await normalize(input, output, FFMPEG);

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
    console.error("VIDEO ERROR:", err);
    return Response.json(
      { error: err.message || "Video processing failed" },
      { status: 500 }
    );
  }
}
