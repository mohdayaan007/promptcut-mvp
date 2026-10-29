import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { closeJobStorePool, migrateEditJobs, reserveRenderCapacity } from "@/lib/jobs/job-store";

const integration = process.env.DATABASE_URL ? test : test.skip;
integration("PostgreSQL render reservations serialize capacity and isolate subscribers", async () => {
  process.env.DODO_TEST_CLIPONAUT_PRODUCT_ID = "cliponaut-product";
  process.env.PAID_RENDER_ALLOWANCE = "15";
  await migrateEditJobs(); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query("DELETE FROM render_quota_reservations; DELETE FROM dodo_subscriptions; DELETE FROM subscriber_identities;");
    for (const id of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) await db.query("INSERT INTO subscriber_identities (id,email) VALUES ($1,$2)", [id, `${id}@example.test`]);
    for (const [sub, owner] of [["sub-a","11111111-1111-4111-8111-111111111111"],["sub-b","22222222-2222-4222-8222-222222222222"]]) await db.query("INSERT INTO dodo_subscriptions (dodo_subscription_id,product_id,subscriber_id,ownership_provenance,status,billing_period_start,billing_period_end) VALUES ($1,'cliponaut-product',$2,'verified','active',now()-interval '1 day',now()+interval '29 days')", [sub, owner]);
    const owner = "11111111-1111-4111-8111-111111111111";
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveRenderCapacity(owner)));
    assert.equal(results.filter(Boolean).length, 15);
    assert.equal((await db.query("SELECT count(*)::int count FROM render_quota_reservations WHERE subscriber_id=$1 AND state='reserved'", [owner])).rows[0].count, 15);
    assert.equal(await reserveRenderCapacity(owner), null);
    assert.ok(await reserveRenderCapacity("22222222-2222-4222-8222-222222222222"));
    await db.query("UPDATE dodo_subscriptions SET ownership_provenance='unverified' WHERE dodo_subscription_id='sub-b'");
    assert.equal(await reserveRenderCapacity("22222222-2222-4222-8222-222222222222"), null);
  } finally { await db.end(); await closeJobStorePool(); }
});
