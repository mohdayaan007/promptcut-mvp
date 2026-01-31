import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { execFile, execSync } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * 🔑 CRITICAL FIX
 * Resolve ffmpeg / ffprobe absolute paths at runtime
 * This works reliably on Railway + Nixpacks
 */
const FFMPEG = execSync("which ffmpeg").toString().trim();
const FFPROBE = execSync("which ffprobe").toString().trim();

export const runtime = "nodejs";

/* -------------------- HELPERS -------------------- */

async function normalize(input, output) {
  await exec(FFMPEG, [
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
    await normalize(input, output);

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
    console.error("FFMPEG ERROR:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
