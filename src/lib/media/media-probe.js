import { execFile } from "child_process";
import { promisify } from "util";
import {
  MAX_INPUT_DIMENSION,
  MAX_INPUT_PIXELS,
  MAX_VIDEO_DURATION_SECONDS
} from "@/lib/media/media-config";

const exec = promisify(execFile);

export class MediaProbeError extends Error {}

function parseFrameRate(value) {
  const [numerator, denominator] = String(value || "").split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

export async function probeVideoFile(inputPath) {
  let stdout;
  try {
    ({ stdout } = await exec("ffprobe", [
      "-v", "error", "-show_entries",
      "format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate:stream_side_data=rotation:stream_tags=rotate",
      "-of", "json", inputPath
    ], { maxBuffer: 1024 * 1024 }));
  } catch {
    throw new MediaProbeError("Unable to read the uploaded video");
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new MediaProbeError("Unable to read the uploaded video");
  }

  const videoStream = data.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number.parseFloat(data.format?.duration);
  if (!videoStream || !Number.isFinite(duration) || duration <= 0) {
    throw new MediaProbeError("The uploaded file must contain a readable video stream");
  }

  const codedWidth = Number(videoStream.width);
  const codedHeight = Number(videoStream.height);
  if (!Number.isInteger(codedWidth) || !Number.isInteger(codedHeight) || codedWidth < 2 || codedHeight < 2) {
    throw new MediaProbeError("The uploaded video has unsupported dimensions");
  }
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new MediaProbeError("Each video must be 10 minutes or shorter");
  }
  if (codedWidth > MAX_INPUT_DIMENSION || codedHeight > MAX_INPUT_DIMENSION || codedWidth * codedHeight > MAX_INPUT_PIXELS) {
    throw new MediaProbeError("The uploaded video resolution is not supported");
  }

  const sideDataRotation = videoStream.side_data_list?.find((data) => Number.isFinite(Number(data.rotation)))?.rotation;
  const rotation = Number(sideDataRotation ?? videoStream.tags?.rotate ?? 0);
  const isQuarterTurn = Number.isFinite(rotation) && Math.abs(rotation) % 180 === 90;
  const width = isQuarterTurn ? codedHeight : codedWidth;
  const height = isQuarterTurn ? codedWidth : codedHeight;

  const audioStream = data.streams.find((stream) => stream.codec_type === "audio");
  return {
    duration,
    width,
    height,
    codedWidth,
    codedHeight,
    rotation: Number.isFinite(rotation) ? rotation : 0,
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream.codec_name || null,
    audioCodec: audioStream?.codec_name || null,
    frameRate: parseFrameRate(videoStream.r_frame_rate),
    container: data.format?.format_name || null
  };
}
