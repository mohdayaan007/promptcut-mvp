export const COLOR_PRESETS = {
  // Neutral monochrome conversion that preserves the existing output.
  bw: ["hue=s=0"],
  // Cooler shadows and warm highlights create a restrained movie-grade contrast curve.
  cinematic: [
  "eq=contrast=1.14:saturation=1.06:brightness=-0.01"
],
  // A gentle amber lift in highlights keeps warmth flattering rather than yellow.
  warm: [
    "eq=contrast=1.06:saturation=1.04:brightness=0.01",
    "colorbalance=rs=0.01:bs=-0.015:rh=0.045:gh=0.015:bh=-0.055:pl=1"
  ],
  // Clean, cool whites with a subtle cyan bias in the darker parts of the image.
  blue: [
    "eq=contrast=1.08:saturation=1.03:brightness=0.005",
    "colorbalance=rs=-0.015:gs=0.01:bs=0.04:rm=-0.005:bm=0.015:pl=1"
  ],
  // A crisp cool grade with deeper cyan shadows and restrained saturation.
  cool: [
    "eq=contrast=1.1:saturation=1.01:brightness=0",
    "colorbalance=rs=-0.02:gs=0.005:bs=0.055:rm=-0.01:bm=0.025:pl=1"
  ],
  // Golden highlights and restrained midtone warmth for an upscale commercial feel.
  gold: [
    "eq=contrast=1.08:saturation=1.06:brightness=0.01",
    "colorbalance=rm=0.015:gm=0.005:bm=-0.015:rh=0.05:gh=0.025:bh=-0.06:pl=1"
  ],
  // A crimson highlight/midtone bias enriches reds without tinting the full frame.
  red: [
    "eq=contrast=1.09:saturation=1.04",
    "colorbalance=rm=0.015:bm=-0.01:rh=0.04:gh=-0.005:bh=-0.02:pl=1"
  ],
  // A modest green lift with blue support gives foliage an emerald-teal freshness.
  green: [
    "eq=contrast=1.06:saturation=1.05:brightness=0.005",
    "colorbalance=rm=-0.01:gm=0.025:bm=0.01:gh=0.015:bh=0.01:pl=1"
  ],
  // Lifted blacks, reduced saturation, and warm highlights produce a soft vintage film feel.
  retro: [
    "eq=contrast=0.92:saturation=0.84:brightness=0.03",
    "colorbalance=rs=0.015:bs=-0.015:rh=0.035:gh=0.01:bh=-0.04:pl=1"
  ],
  // Balanced contrast, subtle warmth, and organic greens retain a natural documentary image.
  documentary: [
    "eq=contrast=1.04:saturation=1.02:brightness=0.005",
    "colorbalance=rm=0.008:gm=0.012:bm=-0.005:rh=0.015:gh=0.01:bh=-0.01:pl=1"
  ],
  // A controlled saturation and contrast increase for colorful travel and lifestyle footage.
  vibrant: [
    "eq=contrast=1.1:saturation=1.16:brightness=0.01",
    "colorbalance=rh=0.01:gh=0.01:bh=0.005:pl=1"
  ]
};
