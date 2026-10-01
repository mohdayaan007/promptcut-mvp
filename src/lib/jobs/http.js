export class PublicRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function jsonError(error, fallbackStatus = 500) {
  const isPublic = error instanceof PublicRequestError;
  return Response.json({ error: isPublic ? error.message : "Unable to complete this request" }, { status: isPublic ? error.status : fallbackStatus });
}

export function jobToken(req) {
  return req.headers.get("x-cliponaut-job-token") || new URL(req.url).searchParams.get("token") || "";
}

export function safeJobResponse(job, extra = {}) {
  return {
    id: job.id,
    status: job.status,
    error: job.status === "failed" ? job.errorMessage : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...extra
  };
}

export function safeSourceMetadata(sources = []) {
  return sources
    .map(({ index, name, type, size }) => ({ index, name, type, size }))
    .sort((left, right) => left.index - right.index);
}
