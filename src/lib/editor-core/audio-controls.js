const AUDIO_FADE_DURATION = 1;

function exactVolumeFactor(prompt = "") {
  const match = prompt.match(/\b(?:reduce|set|make|change|turn)\s+(?:the\s+)?(?:audio\s+)?volume\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*%/i);
  return match ? Number(match[1]) / 100 : null;
}

function requestsQuieterVolume(text) {
  return /\b(?:make|set)\s+(?:the\s+)?(?:audio|volume)\s+(?:quieter|lower)\b/i.test(text)
    || /\b(?:lower|decrease|reduce)\s+(?:the\s+)?(?:audio\s+)?volume\b/i.test(text)
    || /\bturn\s+(?:the\s+)?(?:audio\s+)?volume\s+down\b/i.test(text);
}

function requestsLouderVolume(text) {
  return /\b(?:make|set)\s+(?:the\s+)?(?:audio|volume)\s+(?:louder|higher)\b/i.test(text)
    || /\b(?:increase|raise)\s+(?:the\s+)?(?:audio\s+)?volume\b/i.test(text)
    || /\bturn\s+(?:the\s+)?(?:audio\s+)?volume\s+up\b/i.test(text);
}

/** Extracts only the intentionally small, server-owned 3B-C audio vocabulary. */
export function extractAudioControlIntent(prompt = "") {
  const text = String(prompt);
  const controls = {};

  if (/\bmute\s+(?:the\s+)?(?:video|audio)\b/i.test(text)) {
    controls.volume = { type: "audio_volume", factor: 0 };
  } else {
    const exactFactor = exactVolumeFactor(text);
    if (exactFactor !== null) {
      controls.volume = { type: "audio_volume", factor: exactFactor };
    } else if (requestsQuieterVolume(text)) {
      controls.volume = { type: "audio_volume", factor: 0.5 };
    } else if (requestsLouderVolume(text)) {
      controls.volume = { type: "audio_volume", factor: 1.5 };
    }
  }

  const audioFade = text.match(/\bfade\s+(?:the\s+)?audio\s+(in\s+and\s+out|out|in)\b/i)?.[1]?.toLowerCase();
  if (audioFade) {
    controls.fade = {
      type: "audio_fade",
      mode: audioFade === "in and out" ? "both" : audioFade,
      duration: AUDIO_FADE_DURATION
    };
  }

  return Object.keys(controls).length ? controls : null;
}

export function requestsAudioControls(prompt = "") {
  return extractAudioControlIntent(prompt) !== null;
}

/** Replaces AI-proposed audio controls only when the prompt authorizes deterministic 3B-C intent. */
export function reconcileAudioControls(plan, prompt = "") {
  const intent = extractAudioControlIntent(prompt);
  if (!intent) return plan;
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  const retained = operations.filter((operation) => {
    if (["audio_volume", "audio_fade"].includes(operation?.type)) return false;
    // Explicit audio-only language must never become the legacy audiovisual fade.
    return !(intent.fade && operation?.type === "fade");
  });
  return {
    ...plan,
    operations: [...retained, ...(intent.volume ? [intent.volume] : []), ...(intent.fade ? [intent.fade] : [])]
  };
}
