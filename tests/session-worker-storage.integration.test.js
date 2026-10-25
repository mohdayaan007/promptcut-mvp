import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for this integration test");
if (!process.env.S3_TEST_ENDPOINT) throw new Error("S3_TEST_ENDPOINT is required for this integration test");
const execFileAsync = promisify(execFile);
const bucket = "cliponaut-test";

function jsonRequest(url, body, token) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-cliponaut-job-token": token } : {}) }, body: JSON.stringify(body) });
}
function sessionRequest(url, body, token) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-cliponaut-session-token": token }, body: JSON.stringify(body) });
}
function waitForCompleted(getStatus, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(async () => {
      try {
        const job = await getStatus();
        if (job.status === "completed") { clearInterval(timer); resolve(job); }
        else if (["failed", "cancelled"].includes(job.status)) { clearInterval(timer); reject(new Error(`worker ended ${job.status}: ${job.error || "unknown"}`)); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`worker timed out in ${job.status}`)); }
      } catch (error) { clearInterval(timer); reject(error); }
    }, 250);
  });
}

function waitForTerminal(getStatus, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(async () => {
      try {
        const job = await getStatus();
        if (["completed", "failed", "cancelled"].includes(job.status)) { clearInterval(timer); resolve(job); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`worker timed out in ${job.status}`)); }
      } catch (error) { clearInterval(timer); reject(error); }
    }, 250);
  });
}

test("storage upload, worker rendering, signed download, history, rejection, and follow-up render", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cliponaut-storage-worker-"));
  const scratchDirectory = path.join(root, "scratch");
  const sourcePath = path.join(root, "source.mp4");
  let worker;
  try {
    Object.assign(process.env, {
      STORAGE_BUCKET: bucket, STORAGE_ENDPOINT: process.env.S3_TEST_ENDPOINT,
      STORAGE_REGION: "us-east-1", STORAGE_ACCESS_KEY_ID: "S3RVER", STORAGE_SECRET_ACCESS_KEY: "S3RVER",
      STORAGE_FORCE_PATH_STYLE: "true", JOB_SCRATCH_DIRECTORY: scratchDirectory, JOB_POLL_INTERVAL_MS: "100", JOB_WORKER_CONCURRENCY: "1"
    });
    const { CreateBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
    await new S3Client({ endpoint: process.env.S3_TEST_ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" }, forcePathStyle: true }).send(new CreateBucketCommand({ Bucket: bucket }));
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-pix_fmt", "yuv420p", sourcePath]);
    const source = await readFile(sourcePath);
    const store = await import("@/lib/jobs/job-store");
    await store.migrateEditJobs();
    const uploads = await import("@/app/api/uploads/route");
    const parts = await import("@/app/api/uploads/[id]/parts/route");
    const complete = await import("@/app/api/uploads/[id]/complete/route");
    const jobRoute = await import("@/app/api/jobs/[id]/route");
    const sessionRoute = await import("@/app/api/editing-sessions/[id]/route");

    const started = await uploads.POST(jsonRequest("http://localhost/api/uploads", { files: [{ name: "source.mp4", size: source.length, type: "video/mp4" }] }));
    assert.equal(started.status, 201);
    const upload = await started.json();
    const signedParts = await parts.POST(jsonRequest(`http://localhost/api/uploads/${upload.id}/parts`, { fileIndex: 0, partNumbers: [1] }, upload.accessToken), { params: Promise.resolve({ id: upload.id }) });
    assert.equal(signedParts.status, 200);
    const [{ url }] = (await signedParts.json()).parts;
    const put = await fetch(url, { method: "PUT", body: source });
    assert.equal(put.status, 200);
    const eTag = put.headers.get("etag");
    assert.ok(eTag, "presigned multipart PUT returns an ETag");
    const queuedResponse = await complete.POST(jsonRequest(`http://localhost/api/uploads/${upload.id}/complete`, {
      prompt: "Make this video black and white.", exportQuality: "standard",
      files: [{ key: upload.uploads[0].key, uploadId: upload.uploads[0].uploadId, parts: [{ partNumber: 1, eTag }] }]
    }, upload.accessToken), { params: Promise.resolve({ id: upload.id }) });
    assert.equal(queuedResponse.status, 200);
    const queued = await queuedResponse.json();
    assert.ok(queued.session?.accessToken, "upload completion creates a private editing session");

    worker = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/cliponaut-worker.js"], { cwd: process.cwd(), env: process.env, stdio: "ignore" });
    const getJob = async (session) => (await jobRoute.GET(new Request(`http://localhost/api/jobs/${session.id}`, { headers: { "x-cliponaut-job-token": session.accessToken } }), { params: Promise.resolve({ id: session.id }) })).json();
    const first = await waitForCompleted(() => getJob({ id: upload.id, accessToken: upload.accessToken }));
    assert.ok(first.outputUrl, "completed initial edit has a signed download URL");
    const firstDownload = await fetch(first.outputUrl);
    assert.equal(firstDownload.status, 200);
    const firstOutput = Buffer.from(await firstDownload.arrayBuffer());
    assert.ok(firstOutput.length > 1_000);

    const rejected = await sessionRoute.POST(sessionRequest(`http://localhost/api/editing-sessions/${queued.session.id}`, { prompt: "Make it amazing somehow", expectedVersion: 1 }, queued.session.accessToken), { params: Promise.resolve({ id: queued.session.id }) });
    assert.equal(rejected.status, 422, "unsupported turn is rejected with an actionable client error without creating a version");
    assert.match((await rejected.json()).error, /couldn’t safely/i);

    // Force a real worker failure after the follow-up is queued. The temporary
    // source deletion simulates storage loss; the preserved v1 MP4 remains
    // downloadable and restoring the original object lets v3 continue from it.
    // Pause rather than terminate the worker so the job remains queued while
    // the fixture removes the source object. This models a storage failure
    // after acceptance without racing the worker's next poll.
    worker.kill("SIGSTOP");
    const failingFollowup = await sessionRoute.POST(sessionRequest(`http://localhost/api/editing-sessions/${queued.session.id}`, { prompt: "Replace that with the cinematic style.", expectedVersion: 1 }, queued.session.accessToken), { params: Promise.resolve({ id: queued.session.id }) });
    assert.equal(failingFollowup.status, 200);
    const failedSession = await failingFollowup.json();
    const { DeleteObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const testS3 = new S3Client({ endpoint: process.env.S3_TEST_ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" }, forcePathStyle: true });
    await testS3.send(new DeleteObjectCommand({ Bucket: bucket, Key: upload.uploads[0].key }));
    worker.kill("SIGCONT");
    const failed = await waitForTerminal(() => getJob(failedSession));
    assert.equal(failed.status, "failed", "a queued worker job can fail after acceptance");
    const retainedFirst = await fetch(first.outputUrl);
    assert.equal(retainedFirst.status, 200, "a failed follow-up does not remove the prior signed download");
    assert.deepEqual(Buffer.from(await retainedFirst.arrayBuffer()), firstOutput, "the prior playable MP4 remains intact after failure");
    await testS3.send(new PutObjectCommand({ Bucket: bucket, Key: upload.uploads[0].key, Body: source, ContentType: "video/mp4" }));

    const followup = await sessionRoute.POST(sessionRequest(`http://localhost/api/editing-sessions/${queued.session.id}`, { prompt: "Replace that with the cinematic style.", expectedVersion: failedSession.version }, queued.session.accessToken), { params: Promise.resolve({ id: queued.session.id }) });
    assert.equal(followup.status, 200);
    const secondSession = await followup.json();
    const second = await waitForCompleted(() => getJob({ id: secondSession.id, accessToken: secondSession.accessToken }));
    const secondDownload = await fetch(second.outputUrl);
    const secondOutput = Buffer.from(await secondDownload.arrayBuffer());
    assert.equal(secondDownload.status, 200);
    assert.ok(secondOutput.length > 1_000);
    assert.notDeepEqual(secondOutput.subarray(0, 512), firstOutput.subarray(0, 512), "follow-up is independently rendered");

    const historyResponse = await sessionRoute.GET(new Request(`http://localhost/api/editing-sessions/${queued.session.id}`, { headers: { "x-cliponaut-session-token": queued.session.accessToken } }), { params: Promise.resolve({ id: queued.session.id }) });
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.deepEqual(history.history.map((entry) => entry.status), ["completed", "failed", "completed"]);
    assert.ok(history.history.filter((entry) => entry.status === "completed").every((entry) => entry.outputUrl), "refresh history supplies signed completed versions");
    const outputPath = path.join(root, "second-signed.mp4");
    await writeFile(outputPath, secondOutput);
    assert.ok((await stat(outputPath)).size > 1_000);
    const storage = await import("@/lib/jobs/storage");
    const directOutputPath = path.join(root, "second-direct.mp4");
    await storage.downloadObject(storage.outputObjectKey(secondSession.id), directOutputPath);
    const directProbe = JSON.parse((await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=format_name:stream=codec_type", "-of", "json", directOutputPath])).stdout);
    assert.match(directProbe.format.format_name, /mp4/, "worker uploaded a valid MP4 object");
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=format_name:stream=codec_type", "-of", "json", outputPath]);
    const probe = JSON.parse(stdout);
    assert.match(probe.format.format_name, /mp4/);
    assert.ok(probe.streams.some((stream) => stream.codec_type === "video"), "downloaded follow-up is playable video media");
  } finally {
    worker?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
