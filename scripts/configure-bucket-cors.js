import { configureDirectUploadCors } from "@/lib/jobs/storage";

configureDirectUploadCors().then(() => {
  console.log("Bucket CORS configured for Cliponaut production and localhost development.");
}).catch(() => {
  console.error("Unable to configure Bucket CORS. Verify the STORAGE_* service variables and Bucket URL style.");
  process.exitCode = 1;
});
