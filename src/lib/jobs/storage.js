import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutBucketCorsCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client;
function storageConfig() {
  const required = ["STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_REGION", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error("Storage is unavailable");
  return { bucket: process.env.STORAGE_BUCKET, endpoint: process.env.STORAGE_ENDPOINT, region: process.env.STORAGE_REGION, credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY }, forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true" };
}
function s3() { if (!client) { const { bucket, ...config } = storageConfig(); client = new S3Client(config); } return client; }
function bucket() { return storageConfig().bucket; }
export function sourceObjectKey(jobId, index) { return `jobs/${jobId}/sources/${index}`; }
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
export async function downloadObject(key, destination) { const response = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key })); if (!response.Body) throw new Error("Stored source is unavailable"); await pipeline(response.Body, createWriteStream(destination)); }
export async function uploadOutput(key, inputPath) { await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: createReadStream(inputPath), ContentType: "video/mp4" })); }
export async function signedDownloadUrl(key) { return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentType: "video/mp4" }), { expiresIn: 900 }); }
export async function deleteObjects(keys) { const objects = keys.filter(Boolean).map((Key) => ({ Key })); if (objects.length) await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: objects, Quiet: true } })); }
