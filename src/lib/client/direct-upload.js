const JOB_STORAGE_KEY = "cliponaut-active-job";
const EDITING_SESSION_STORAGE_KEY = "cliponaut-editing-session";
export const UNDO_STATE_VERSION = 1;
export const ACTIVE_JOB_STATUSES = ["uploading", "queued", "analyzing", "rendering"];
const PART_UPLOAD_MAX_ATTEMPTS = 3;
const PART_UPLOAD_RETRY_DELAYS_MS = [500, 1_000];

async function requestJson(url, options = {}, fetchFn = fetch) {
  const response = await fetchFn(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function jobHeaders(accessToken) { return { "x-cliponaut-job-token": accessToken }; }

function browserStorage(storage) {
  if (storage) return storage;
  return typeof localStorage === "undefined" ? null : localStorage;
}

function validSession(session) {
  return Boolean(session && typeof session.id === "string" && typeof session.accessToken === "string");
}

function safeSources(sources) {
  return Array.isArray(sources)
    ? sources.map(({ index, name, type, size }) => ({ index, name, type, size })).sort((left, right) => left.index - right.index)
    : [];
}

function safePrompt(prompt) {
  return typeof prompt === "string" && prompt.trim() ? prompt.trim().slice(0, 2_000) : undefined;
}

function withPrompt(state, prompt) {
  const safe = safePrompt(prompt);
  return safe ? { ...state, prompt: safe } : state;
}

export function emptyUndoState() {
  return { version: UNDO_STATE_VERSION, active: null, current: null, previous: null, terminal: null };
}

function safeSuccessfulState(state) {
  if (!state || typeof state !== "object") return null;
  if (state.kind === "original") return { kind: "original", sources: safeSources(state.sources) };
  if (state.kind === "job" && validSession(state.session)) {
    return withPrompt({ kind: "job", session: { id: state.session.id, accessToken: state.session.accessToken }, sources: safeSources(state.sources) }, state.prompt);
  }
  return null;
}

function safeTerminalState(state) {
  if (!state || !["failed", "cancelled"].includes(state.status) || !validSession(state.session)) return null;
  return {
    session: { id: state.session.id, accessToken: state.session.accessToken },
    status: state.status,
    error: safePrompt(state.error),
    sources: safeSources(state.sources)
  };
}

function normalizeUndoState(value) {
  if (validSession(value) && value.version === undefined) {
    return { state: { ...emptyUndoState(), active: { id: value.id, accessToken: value.accessToken } }, migrated: true };
  }
  if (!value || value.version !== UNDO_STATE_VERSION) return { state: emptyUndoState(), migrated: false };
  return {
    state: {
      version: UNDO_STATE_VERSION,
      active: validSession(value.active) ? withPrompt({ id: value.active.id, accessToken: value.active.accessToken }, value.active.prompt) : null,
      current: safeSuccessfulState(value.current),
      previous: safeSuccessfulState(value.previous),
      terminal: safeTerminalState(value.terminal)
    },
    migrated: false
  };
}

export function loadUndoState(storage) {
  const target = browserStorage(storage);
  if (!target) return emptyUndoState();
  try {
    const { state, migrated } = normalizeUndoState(JSON.parse(target.getItem(JOB_STORAGE_KEY) || "null"));
    if (migrated) target.setItem(JOB_STORAGE_KEY, JSON.stringify(state));
    return state;
  } catch {
    return emptyUndoState();
  }
}

export function saveUndoState(state, storage) {
  const target = browserStorage(storage);
  const normalized = normalizeUndoState(state).state;
  if (target) target.setItem(JOB_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function setUndoActiveJob(state, session, prompt) {
  const normalized = normalizeUndoState(state).state;
  return { ...normalized, active: validSession(session) ? withPrompt({ id: session.id, accessToken: session.accessToken }, prompt) : null, terminal: null };
}

export function discardUndoActiveJob(state) {
  return { ...normalizeUndoState(state).state, active: null };
}

export function promoteSuccessfulJob(state, session, sources, prompt) {
  const normalized = normalizeUndoState(state).state;
  const nextCurrent = withPrompt({ kind: "job", session: { id: session.id, accessToken: session.accessToken }, sources: safeSources(sources) }, prompt ?? normalized.active?.prompt);
  return {
    version: UNDO_STATE_VERSION,
    active: null,
    current: nextCurrent,
    previous: normalized.current || { kind: "original", sources: safeSources(sources) },
    terminal: null
  };
}

export function consumeUndo(state) {
  const normalized = normalizeUndoState(state).state;
  if (!normalized.previous) return normalized;
  return { ...normalized, active: null, current: normalized.previous, previous: null, terminal: null };
}

/** Persists only the latest authoritative terminal presentation, never history. */
export function recordTerminalJob(state, session, job) {
  const normalized = normalizeUndoState(state).state;
  const terminal = safeTerminalState({ session, status: job?.status, error: job?.error, sources: job?.sources });
  return { ...normalized, active: null, terminal };
}

export function clearTerminalJob(state) {
  return { ...normalizeUndoState(state).state, terminal: null };
}

export function invalidateUndoPrevious(state) {
  return { ...normalizeUndoState(state).state, previous: null };
}

export function resolveUndoRestoration(state, job) {
  const normalized = normalizeUndoState(state).state;
  if (job?.status === "completed" && typeof job.outputUrl === "string" && job.outputUrl) {
    return { outcome: "restored", state: consumeUndo(normalized) };
  }
  if (job?.status === "completed") {
    return { outcome: "unavailable", state: invalidateUndoPrevious(normalized) };
  }
  return { outcome: "retry", state: normalized };
}

export function shouldShowUndoControl({ current }) {
  return Boolean(current);
}

/** Returns the enabled Undo anchor reconstructed from persisted successful state. */
export function getInitialUndoAnchor(state) {
  const { state: normalized } = normalizeUndoState(state);
  const current = normalized.current;
  if (current?.kind !== "job" || !normalized.previous) return null;

  return {
    jobId: current.session.id,
    prompt: current.prompt,
    consumed: false,
  };
}

/** Lets a committed client-side restoring state reach the browser before work continues. */
export function waitForBrowserPaint(requestFrame) {
  const schedule = requestFrame || (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback) => Promise.resolve().then(callback));

  return new Promise((resolve) => {
    schedule(() => schedule(resolve));
  });
}

/** Finds the successful user turn that owns the one available Undo action. */
export function findUndoTurnIndex(messages, anchor) {
  if (!Array.isArray(messages)) return -1;
  const { jobId, prompt } = anchor || {};
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (jobId ? message.jobId === jobId : prompt && message.text === prompt) return index;
  }
  return -1;
}

export function undoPreviewMode({ isRestoring, current, localVideoCount }) {
  if (isRestoring) return "restoring";
  if (current?.kind === "original" && localVideoCount === 1) return "original-source";
  return "normal";
}

/**
 * A local original needs two presentation barriers: one before its Blob preview
 * mounts, then one after it reports ready while it is still covered. A restored
 * job remains media-ready driven as before.
 */
export function undoMediaReadyAction({ isRestoring, restoringOriginal, originalPreviewArmed, originalReadyForReveal = false }) {
  if (!isRestoring) return "ignore";
  if (!restoringOriginal) return "complete";
  if (!originalPreviewArmed) return "ignore";
  return originalReadyForReveal ? "complete" : "wait-for-reveal-paint";
}

export function canCompleteUndoMediaRestoration(options) {
  return undoMediaReadyAction(options) === "complete";
}

export function shouldScheduleUndoOriginalReveal(options, revealScheduled = false) {
  return undoMediaReadyAction(options) === "wait-for-reveal-paint" && !revealScheduled;
}

export function describeUndoRestoration({ current, previous }) {
  const quote = (prompt) => {
    const value = String(prompt).trim();
    return `“${/[.!?]$/.test(value) ? value : `${value}.`}”`;
  };
  if (previous?.kind === "original") {
    const restored = previous.sources.length === 1 ? "Restored your original upload." : "Restored your original uploads.";
    return current?.prompt ? `${restored} Undid: ${quote(current.prompt)}` : restored;
  }
  if (previous?.prompt && current?.prompt) return `Restored previous edit: ${quote(previous.prompt)} Undid: ${quote(current.prompt)}`;
  if (current?.prompt) return `Restored your previous edit. Undid: ${quote(current.prompt)}`;
  return "Restored your previous edit.";
}

function abortError() {
  const error = new Error("The upload was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function retryDelay(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryablePartStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export class PartUploadError extends Error {
  constructor({ kind, status = null }) {
    super(kind === "network"
      ? "A video part could not be uploaded because of a network error. Please try again."
      : kind === "confirmation"
        ? "The upload service did not confirm a video part. Please try again."
        : `A video part could not be uploaded (HTTP ${status}). Please try again.`);
    this.name = "PartUploadError";
    this.kind = kind;
    this.status = status;
  }
}

/** Uploads one signed multipart part with bounded transient retry and no progress side effects. */
export async function uploadPartWithRetry({ url, chunk, signal, fetchFn = fetch, sleepFn = retryDelay }) {
  let lastError;
  for (let attempt = 0; attempt < PART_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetchFn(url, { method: "PUT", body: chunk, signal });
      if (response.ok) {
        const eTag = response.headers.get("etag");
        if (!eTag) throw new PartUploadError({ kind: "confirmation" });
        return eTag;
      }
      lastError = new PartUploadError({ kind: "http", status: response.status });
      if (!isRetryablePartStatus(response.status)) throw lastError;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      if (error instanceof PartUploadError) {
        lastError = error;
        if (error.kind === "confirmation" || !isRetryablePartStatus(error.status)) throw error;
      } else {
        lastError = new PartUploadError({ kind: "network" });
      }
    }
    if (attempt < PART_UPLOAD_MAX_ATTEMPTS - 1) {
      await sleepFn(PART_UPLOAD_RETRY_DELAYS_MS[attempt], signal);
      throwIfAborted(signal);
    }
  }
  throw lastError;
}

async function uploadMultipartFile({ session, file, fileIndex, kind = "source", signal, fetchFn, sleepFn, onPartUploaded }) {
  const upload = kind === "reference" ? session.referenceUpload : session.uploads.find((entry) => entry.index === fileIndex);
  if (!upload) throw new Error("Upload session did not include the selected file");
  const partCount = Math.ceil(file.size / session.partSize);
  const parts = [];
  for (let firstPart = 1; firstPart <= partCount; firstPart += 8) {
    const partNumbers = Array.from({ length: Math.min(8, partCount - firstPart + 1) }, (_, offset) => firstPart + offset);
    const signed = await requestJson(`/api/uploads/${session.id}/parts`, {
      method: "POST", headers: jobHeaders(session.accessToken), body: JSON.stringify({ ...(kind === "reference" ? { kind } : { fileIndex }), partNumbers }), signal
    }, fetchFn);
    for (const part of signed.parts) {
      const start = (part.partNumber - 1) * session.partSize;
      const chunk = file.slice(start, Math.min(file.size, start + session.partSize));
      const eTag = await uploadPartWithRetry({ url: part.url, chunk, signal, fetchFn, ...(sleepFn ? { sleepFn } : {}) });
      parts.push({ partNumber: part.partNumber, eTag });
      onPartUploaded?.(chunk.size);
    }
  }
  return { key: upload.key, uploadId: upload.uploadId, parts };
}

export async function uploadAndQueueJob({ videos, referenceImage = null, prompt, exportQuality, signal, onProgress, onSession, fetchFn = fetch, sleepFn }) {
  const session = await requestJson("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ files: videos.map((file) => ({ name: file.name, size: file.size, type: file.type || "video/mp4" })), reference: referenceImage ? { name: referenceImage.name, size: referenceImage.size, type: referenceImage.type } : null }),
    signal
  }, fetchFn);
  onSession?.({ id: session.id, accessToken: session.accessToken });
  const completedFiles = [];
  let uploadedBytes = 0;
  const totalBytes = videos.reduce((total, file) => total + file.size, 0) + (referenceImage?.size || 0);
  try {
    for (const [fileIndex, file] of videos.entries()) {
      completedFiles.push(await uploadMultipartFile({ session, file, fileIndex, signal, fetchFn, sleepFn, onPartUploaded: (size) => { uploadedBytes += size; onProgress?.({ uploadedBytes, totalBytes }); } }));
    }
    const completedReference = referenceImage ? await uploadMultipartFile({ session, file: referenceImage, kind: "reference", signal, fetchFn, sleepFn, onPartUploaded: (size) => { uploadedBytes += size; onProgress?.({ uploadedBytes, totalBytes }); } }) : null;
    return await requestJson(`/api/uploads/${session.id}/complete`, {
      method: "POST", headers: jobHeaders(session.accessToken),
      body: JSON.stringify({ prompt, exportQuality, files: completedFiles, ...(completedReference ? { reference: completedReference } : {}) }), signal
    }, fetchFn);
  } catch (error) {
    await fetchFn(`/api/uploads/${session.id}/abort`, { method: "POST", headers: jobHeaders(session.accessToken) }).catch(() => {});
    throw error;
  }
}

export async function getJobStatus(session, signal) {
  return requestJson(`/api/jobs/${session.id}`, { headers: jobHeaders(session.accessToken), signal });
}

export async function cancelJob(session, signal) {
  return requestJson(`/api/jobs/${session.id}/cancel`, {
    method: "POST", headers: jobHeaders(session.accessToken), signal
  });
}

export function loadEditingSession(storage) {
  const target = browserStorage(storage);
  if (!target) return null;
  try {
    const value = JSON.parse(target.getItem(EDITING_SESSION_STORAGE_KEY) || "null");
    return value && typeof value.id === "string" && typeof value.accessToken === "string" && Number.isInteger(value.version) ? value : null;
  } catch { return null; }
}
export function saveEditingSession(session, storage) {
  const target = browserStorage(storage);
  if (target && session) target.setItem(EDITING_SESSION_STORAGE_KEY, JSON.stringify(session));
  return session;
}
export function clearEditingSession(storage) { browserStorage(storage)?.removeItem(EDITING_SESSION_STORAGE_KEY); }
export async function submitConversationTurn(session, prompt, signal) {
  const response = await requestJson(`/api/editing-sessions/${session.id}`, {
    method: "POST", headers: { "x-cliponaut-session-token": session.accessToken },
    body: JSON.stringify({ prompt, expectedVersion: session.version }), signal
  });
  return { job: { id: response.id, accessToken: response.accessToken }, session: { ...session, version: response.version }, confirmation: response.confirmation };
}

export function isActiveJobStatus(status) { return ACTIVE_JOB_STATUSES.includes(status); }
export function isRecoverableJobStatus(status) { return isActiveJobStatus(status) || status === "completed"; }

/** Terminal attempts are presented independently from retained Undo history. */
export function terminalAttemptPresentation(job) {
  const cancelled = job?.status === "cancelled";
  return Object.freeze({
    status: "error",
    resultUrl: null,
    error: cancelled
      ? "This edit was cancelled."
      : job?.error || "We couldn’t complete that edit."
  });
}

/** Prevents an older polling or restoration response from replacing a newer attempt. */
export function isCurrentPresentationAttempt(attempt, currentAttempt) {
  return Number.isInteger(attempt) && attempt === currentAttempt;
}

/** Legacy active-job helpers preserve current recovery callers while retaining undo state. */
export function saveActiveJob(session, prompt) { return saveUndoState(setUndoActiveJob(loadUndoState(), session, prompt)); }
export function loadActiveJob() { return loadUndoState().active; }
export function clearActiveJob() { return saveUndoState(discardUndoActiveJob(loadUndoState())); }
export function clearUndoState(storage) {
  const target = browserStorage(storage);
  if (target) target.removeItem(JOB_STORAGE_KEY);
}
