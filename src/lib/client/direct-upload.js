const JOB_STORAGE_KEY = "cliponaut-active-job";
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

export async function uploadAndQueueJob({ videos, prompt, exportQuality, signal, onProgress, onSession, fetchFn = fetch, sleepFn }) {
  const session = await requestJson("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ files: videos.map((file) => ({ name: file.name, size: file.size, type: file.type || "video/mp4" })) }),
    signal
  }, fetchFn);
  onSession?.({ id: session.id, accessToken: session.accessToken });
  const completedFiles = [];
  let uploadedBytes = 0;
  const totalBytes = videos.reduce((total, file) => total + file.size, 0);
  try {
    for (const [fileIndex, file] of videos.entries()) {
      const upload = session.uploads.find((entry) => entry.index === fileIndex);
      const partCount = Math.ceil(file.size / session.partSize);
      const parts = [];
      for (let firstPart = 1; firstPart <= partCount; firstPart += 8) {
        const partNumbers = Array.from({ length: Math.min(8, partCount - firstPart + 1) }, (_, offset) => firstPart + offset);
        const signed = await requestJson(`/api/uploads/${session.id}/parts`, {
          method: "POST", headers: jobHeaders(session.accessToken), body: JSON.stringify({ fileIndex, partNumbers }), signal
        }, fetchFn);
        for (const part of signed.parts) {
          const start = (part.partNumber - 1) * session.partSize;
          const chunk = file.slice(start, Math.min(file.size, start + session.partSize));
          const eTag = await uploadPartWithRetry({ url: part.url, chunk, signal, fetchFn, ...(sleepFn ? { sleepFn } : {}) });
          parts.push({ partNumber: part.partNumber, eTag });
          uploadedBytes += chunk.size;
          onProgress?.({ uploadedBytes, totalBytes });
        }
      }
      completedFiles.push({ key: upload.key, uploadId: upload.uploadId, parts });
    }
    return await requestJson(`/api/uploads/${session.id}/complete`, {
      method: "POST", headers: jobHeaders(session.accessToken),
      body: JSON.stringify({ prompt, exportQuality, files: completedFiles }), signal
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

export function isActiveJobStatus(status) { return ACTIVE_JOB_STATUSES.includes(status); }
export function isRecoverableJobStatus(status) { return isActiveJobStatus(status) || status === "completed"; }

export function saveActiveJob(session) { localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(session)); }
export function loadActiveJob() {
  try { return JSON.parse(localStorage.getItem(JOB_STORAGE_KEY) || "null"); } catch { return null; }
}
export function clearActiveJob() { localStorage.removeItem(JOB_STORAGE_KEY); }
