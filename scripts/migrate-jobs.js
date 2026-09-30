import { migrateEditJobs } from "@/lib/jobs/job-store";

migrateEditJobs().then(() => console.log("Edit-jobs schema is ready.")).catch((error) => {
  console.error("Unable to migrate edit-jobs schema:", error.message);
  process.exitCode = 1;
});
