import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutBucketCorsCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { copyFile, mkdir, readFile, rm, stat } from "fs/promises";
import path from "path";

let client;
const FOUNDER_LOCAL_OUTPUT = /^jobs\/([0-9a-f-]{36})\/output\/cliponaut\.mp4$/i;
const FOUNDER_LOCAL_KEYS = new Set([
  "founder-reference-style/v1/reference-rve1.mp4",
  "founder-reference-style/v1/reference-rve3.mp4",
  "founder-reference-style/v1/reference-rve5.mp4",
  "founder-reference-style/v1/source.mp4",
  "founder-reference-style/v1/manifest-founder-rve1-moved-to-blore.json",
  "founder-reference-style/v1/manifest-founder-rve3-put-myself-out.json",
  "founder-reference-style/v1/manifest-founder-rve5-film-yourself.json",
  "founder-reference-style/v1/style-profile-founder-rve1-moved-to-blore.json",
  "founder-reference-style/v1/style-profile-founder-rve3-put-myself-out.json",
  "founder-reference-style/v1/style-profile-founder-rve5-film-yourself.json"
]);

/**
 * This filesystem adapter is deliberately narrower than the S3 interface.
 * It exists solely for the loopback founder harness and cannot activate in a
 * production process. Public uploads and normal jobs continue to require S3.
 */
export function founderLocalStorageRoot() {
  if (process.env.NODE_ENV === "production" || process.env.FOUNDER_REFERENCE_STYLE_LOCAL_MODE !== "true") return null;
  const root = process.env.FOUNDER_REFERENCE_STYLE_LOCAL_ROOT;
  if (!root || !path.isAbsolute(root)) return null;
  return path.resolve(root);
}
function localPath(key, { output = false } = {}) {
  const root = founderLocalStorageRoot();
  const isOutput = FOUNDER_LOCAL_OUTPUT.test(key);
  if (!root || (!FOUNDER_LOCAL_KEYS.has(key) && !(output && isOutput))) throw new Error("Storage is unavailable");
  const destination = path.resolve(root, key);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Storage is unavailable");
  return destination;
}
function localOutputId(key) { return key.match(FOUNDER_LOCAL_OUTPUT)?.[1] || null; }
function storageConfig() {
  const required = ["STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_REGION", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error("Storage is unavailable");
  return { bucket: process.env.STORAGE_BUCKET, endpoint: process.env.STORAGE_ENDPOINT, region: process.env.STORAGE_REGION, credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY }, forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true" };
}
function s3() { if (!client) { const { bucket, ...config } = storageConfig(); client = new S3Client(config); } return client; }
function bucket() { return storageConfig().bucket; }
export function sourceObjectKey(jobId, index) { return `jobs/${jobId}/sources/${index}`; }
export function referenceObjectKey(jobId, reference = null) { return `jobs/${jobId}/reference/${reference?.kind === "video" ? "video" : "image"}`; }
export function outputObjectKey(jobId) { return `jobs/${jobId}/output/cliponaut.mp4`; }
export const DIRECT_UPLOAD_CORS = {
  CORSRules: [{
    AllowedOrigins: ["https://cliponaut.com", "http://localhost:3000"],
    AllowedMethods: ["GET", "HEAD", "PUT"],
    AllowedHeaders: ["content-type"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600
  }]
};
export async function configureDirectUploadCors() {
  await s3().send(new PutBucketCorsCommand({ Bucket: bucket(), CORSConfiguration: DIRECT_UPLOAD_CORS }));
}
export async function beginMultipartUpload({ key, contentType }) { const result = await s3().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType })); if (!result.UploadId) throw new Error("Unable to start upload"); return result.UploadId; }
export async function createPartUploadUrls({ key, uploadId, partNumbers }) { return Promise.all(partNumbers.map(async (partNumber) => ({ partNumber, url: await getSignedUrl(s3(), new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 900 }) }))); }
export async function completeMultipartUpload({ key, uploadId, parts }) { await s3().send(new CompleteMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } })); }
export async function abortMultipartUpload({ key, uploadId }) { if (uploadId) await s3().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId })); }
export async function headObject(key) { return s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key })); }
export async function downloadObject(key, destination) {
  if (founderLocalStorageRoot()) { await copyFile(/*turbopackIgnore: true*/ localPath(key), destination); return; }
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key })); if (!response.Body) throw new Error("Stored source is unavailable"); await pipeline(response.Body, createWriteStream(destination));
}
/** Read a bounded server-owned staging document. It is never exposed to browser callers. */
export async function readFounderStagingJson(key) {
  if (!/^founder-reference-style\/v1\/(?:manifest|style-profile)(?:-[a-z0-9-]+)?\.json$/.test(key)) throw new Error("Invalid founder staging document");
  if (founderLocalStorageRoot()) return JSON.parse(await readFile(/*turbopackIgnore: true*/ localPath(key), "utf8"));
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!response.Body) throw new Error("Founder staging document is unavailable");
  const chunks = []; let length = 0;
  for await (const chunk of response.Body) { const value = Buffer.from(chunk); length += value.length; if (length > 64 * 1024) throw new Error("Founder staging document is too large"); chunks.push(value); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function uploadOutput(key, inputPath) {
  if (founderLocalStorageRoot()) { const destination = localPath(key, { output: true }); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(inputPath, /*turbopackIgnore: true*/ destination); return; }
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: createReadStream(inputPath), ContentType: "video/mp4" }));
}
export async function signedDownloadUrl(key) {
  if (founderLocalStorageRoot()) { const id = localOutputId(key); if (!id) throw new Error("Storage is unavailable"); return `/api/founder-test/reference-style/output/${id}`; }
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentType: "video/mp4" }), { expiresIn: 900 });
}
export async function founderLocalOutputStream(key) {
  const destination = localPath(key, { output: true }); await stat(/*turbopackIgnore: true*/ destination); return createReadStream(/*turbopackIgnore: true*/ destination);
}
export async function deleteObjects(keys) {
  if (founderLocalStorageRoot()) { await Promise.all(keys.filter(Boolean).map((key) => rm(/*turbopackIgnore: true*/ localPath(key, { output: true }), { force: true }).catch(() => {}))); return; }
  const objects = keys.filter(Boolean).map((Key) => ({ Key })); if (objects.length) await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: objects, Quiet: true } }));
}
