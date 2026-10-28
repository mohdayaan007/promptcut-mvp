/** A completed job owns one confirmation, including after history hydration. */
export function recordConversationCompletion(messages, jobId, confirmation) {
  const message = { role: "assistant", text: confirmation || "Your edit is ready.", jobId };
  const existing = messages.findIndex((entry) => entry.role === "assistant" && entry.jobId === jobId);
  if (existing < 0) return [...messages, message];
  return messages.map((entry, index) => index === existing ? message : entry);
}

export function retainedPreviewLabel(status, duration) {
  if (!["uploading", "queued", "analyzing", "rendering", "error"].includes(status)) return null;
  return `Previous edit${Number.isFinite(duration) && duration > 0 ? ` (${Math.round(duration)}s)` : ""}`;
}
