#!/usr/bin/env python3
"""Founder-local MKL adapter.

This script uses the separately installed GPL-3.0 ``color-matcher`` package
only in the local founder evaluation environment. It is excluded from Docker
build context and is not a customer or production runtime dependency.
"""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from color_matcher import ColorMatcher

WIDTH, HEIGHT = 640, 360
FRAME_BYTES = WIDTH * HEIGHT * 3
SAMPLE_RATIOS = (0.10, 0.30, 0.50, 0.70, 0.90)


def run(args, capture=False):
    return subprocess.check_output(args) if capture else subprocess.check_call(args)


def probe(path):
    value = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,width,height", "-of", "json", str(path)], True))
    duration = float(value["format"]["duration"])
    video = next((entry for entry in value.get("streams", []) if entry.get("codec_type") == "video"), None)
    rate = video.get("avg_frame_rate") if video else "0/0"
    numerator, denominator = (float(part) for part in rate.split("/", 1))
    width, height = (int(video.get(key, 0)) if video else 0 for key in ("width", "height"))
    if not np.isfinite(duration) or duration <= 0 or denominator == 0 or numerator <= 0 or width < 2 or height < 2:
        raise RuntimeError("unreadable video timing")
    return duration, numerator / denominator, width, height


def frame(path, timestamp):
    raw = run(["ffmpeg", "-v", "error", "-ss", str(timestamp), "-i", str(path), "-frames:v", "1", "-vf", f"scale={WIDTH}:{HEIGHT}", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], True)
    if len(raw) != FRAME_BYTES:
        raise RuntimeError("unexpected sample frame size")
    return np.frombuffer(raw, dtype=np.uint8).reshape(HEIGHT, WIDTH, 3).copy()


def mosaic(path, duration):
    return np.concatenate([frame(path, duration * ratio) for ratio in SAMPLE_RATIOS], axis=0).astype(np.float64)


def transformation(source_samples, reference_samples):
    matcher = ColorMatcher()
    # Same evaluator and MKL method used by the original acceptance comparison.
    matcher.transfer(src=source_samples, ref=reference_samples, method="mkl")
    matrix = np.asarray(matcher.transfer_mat, dtype=np.float64)
    source_mean = np.asarray(matcher.mu_r[:, 0], dtype=np.float64)
    reference_mean = np.asarray(matcher.mu_z[:, 0], dtype=np.float64)
    if matrix.shape != (3, 3) or source_mean.shape != (3,) or reference_mean.shape != (3,) or not (np.isfinite(matrix).all() and np.isfinite(source_mean).all() and np.isfinite(reference_mean).all()):
        raise RuntimeError("non-finite MKL transform")
    rank = np.linalg.matrix_rank(matrix)
    condition = float(np.linalg.cond(matrix))
    if rank != 3 or not np.isfinite(condition) or condition > 1e12:
        raise RuntimeError("degenerate MKL covariance transform")

    def apply(image):
        # Keep the original ColorMatcher MKL evaluator authoritative. Running
        # it on the decoded source frame preserves source detail instead of
        # discarding it before the colour transfer.
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            matcher = ColorMatcher()
            transformed = np.asarray(matcher.transfer(src=image.astype(np.float64), ref=reference_samples, method="mkl"), dtype=np.float64)
        frame_matrix = np.asarray(matcher.transfer_mat, dtype=np.float64)
        frame_source_mean = np.asarray(matcher.mu_r[:, 0], dtype=np.float64)
        frame_reference_mean = np.asarray(matcher.mu_z[:, 0], dtype=np.float64)
        frame_condition = float(np.linalg.cond(frame_matrix))
        if frame_matrix.shape != (3, 3) or frame_source_mean.shape != (3,) or frame_reference_mean.shape != (3,) or not (np.isfinite(frame_matrix).all() and np.isfinite(frame_source_mean).all() and np.isfinite(frame_reference_mean).all()) or np.linalg.matrix_rank(frame_matrix) != 3 or not np.isfinite(frame_condition) or frame_condition > 1e12:
            raise RuntimeError("invalid MKL frame covariance transform")
        if transformed.shape != image.shape or not np.isfinite(transformed).all():
            raise RuntimeError("non-finite MKL frame output")
        return np.clip(transformed, 0, 255).astype(np.uint8)
    return apply, condition


def render(source, destination, fps, width, height, transform):
    silent = destination.with_suffix(".silent.mp4")
    frame_bytes = width * height * 3
    decoder = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(source), "-an", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], stdout=subprocess.PIPE)
    encoder = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{width}x{height}", "-framerate", str(fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p", str(silent)], stdin=subprocess.PIPE)
    frames = 0
    try:
        while True:
            raw = decoder.stdout.read(frame_bytes)
            if not raw:
                break
            if len(raw) != frame_bytes:
                raise RuntimeError("partial source frame")
            image = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
            result = transform(image)
            if not np.isfinite(result).all():
                raise RuntimeError("non-finite encoded frame")
            encoder.stdin.write(result.tobytes())
            frames += 1
    finally:
        if encoder.stdin:
            encoder.stdin.close()
        decoder.wait(); encoder.wait()
    if decoder.returncode or encoder.returncode or frames < 1:
        raise RuntimeError("MKL encoding failed")
    # Preserve compatible source AAC bit-for-bit and avoid a second lossy
    # encode of the completed MKL visual stream.
    run(["ffmpeg", "-y", "-v", "error", "-i", str(silent), "-i", str(source), "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", str(destination)])
    silent.unlink(missing_ok=True)
    return frames


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    source, reference, output, report = (Path(value) for value in (args.source, args.reference, args.output, args.report))
    source_duration, fps, width, height = probe(source)
    reference_duration, _, _, _ = probe(reference)
    transform, condition = transformation(mosaic(source, source_duration), mosaic(reference, reference_duration))
    output.parent.mkdir(parents=True, exist_ok=True)
    frames = render(source, output, fps, width, height, transform)
    report.write_text(json.dumps({"version": "founder-mkl-evaluation/1", "status": "ok", "frameCount": frames, "matrixFinite": True, "outputFinite": True, "matrixCondition": condition}), encoding="utf-8")


if __name__ == "__main__":
    main()
