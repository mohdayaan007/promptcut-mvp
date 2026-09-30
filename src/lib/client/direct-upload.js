const JOB_STORAGE_KEY = "cliponaut-active-job";

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function jobHeaders(accessToken) { return { "x-cliponaut-job-token": accessToken }; }

export async function uploadAndQueueJob({ videos, prompt, exportQuality, signal, onProgress, onSession }) {
  const session = await requestJson("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ files: videos.map((file) => ({ name: file.name, size: file.size, type: file.type || "video/mp4" })) }),
    signal
  });
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
        });
        for (const part of signed.parts) {
          const start = (part.partNumber - 1) * session.partSize;
          const chunk = file.slice(start, Math.min(file.size, start + session.partSize));
          const response = await fetch(part.url, { method: "PUT", body: chunk, signal });
          if (!response.ok) throw new Error("A video part could not be uploaded");
          const eTag = response.headers.get("etag");
          if (!eTag) throw new Error("The upload service did not confirm a video part");
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
    });
  } catch (error) {
    await fetch(`/api/uploads/${session.id}/abort`, { method: "POST", headers: jobHeaders(session.accessToken) }).catch(() => {});
    throw error;
  }
}

export async function getJobStatus(session, signal) {
  return requestJson(`/api/jobs/${session.id}`, { headers: jobHeaders(session.accessToken), signal });
}

export function saveActiveJob(session) { localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(session)); }
export function loadActiveJob() {
  try { return JSON.parse(localStorage.getItem(JOB_STORAGE_KEY) || "null"); } catch { return null; }
}
export function clearActiveJob() { localStorage.removeItem(JOB_STORAGE_KEY); }
