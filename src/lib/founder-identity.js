import crypto from "crypto";

/** Explicit, server-only Google-subject digests; malformed configuration grants nobody access. */
export function founderSubjectDigests() {
  const value = process.env.FOUNDER_GOOGLE_SUBJECT_SHA256_ALLOWLIST;
  if (typeof value !== "string" || !value.trim()) return [];
  const entries = value.split(",").map(entry => entry.trim());
  return entries.every(entry => /^[a-f0-9]{64}$/.test(entry)) ? [...new Set(entries)] : [];
}

export function isFounderSubjectDigest(digest) {
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return false;
  return founderSubjectDigests().some(expected => crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(digest, "hex")));
}
