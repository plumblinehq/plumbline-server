/**
 * The scheduled scan. This is the command the `Scan` workflow
 * (`.github/workflows/scan.yml`) runs on an interval: it applies migrations,
 * recovers runs orphaned by an interrupted pass, seeds the reviewed anchor
 * list, and runs one scan pass.
 *
 * It takes a Postgres advisory lock for its whole duration. The checks
 * package serialises requests per host within one process, so two scans
 * running at once would put two requests in flight against the same anchor —
 * exactly what the politeness boundary forbids. The lock makes that
 * impossible even if a scheduled run starts while a slow pass is still going,
 * or if someone runs this command by hand mid-pass.
 */
import postgres from "postgres";

import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { Scanner } from "./scanner.js";
import { loadSeedLists } from "./seed.js";
import { Store } from "./store.js";
import { createRegressionNotifier } from "./webhook.js";

/** "plumbline" as an integer: the advisory-lock key every scanner shares. */
const SCAN_LOCK_ID = 0x706c756d;

const config = loadConfig();
const store = new Store(config.databaseUrl);
// A dedicated single connection holds the lock; the store keeps its own pool.
const lockClient = postgres(config.databaseUrl, { max: 1 });

const lockRows = await lockClient`SELECT pg_try_advisory_lock(${SCAN_LOCK_ID}) AS locked`;
if (lockRows[0]?.locked !== true) {
  console.log("another scan already holds the lock; exiting without scanning");
  await lockClient.end();
  await store.close();
  process.exit(0);
}

const notifier = createRegressionNotifier(config.regressionWebhookUrl);
const scanner = new Scanner(store, config, undefined, notifier);

try {
  // Migrations run before anything touches the tables — on a fresh database
  // the seed upserts would otherwise hit nonexistent relations.
  const applied = await runMigrations(store.sql);
  if (applied > 0) {
    console.log(`migrations applied: ${applied}`);
  }
  // We hold the scan lock, so nothing else is scanning: a run still marked
  // `running` was interrupted, and must read as aborted, not as still going.
  const recovered = await store.recoverOrphanedRuns();
  if (recovered > 0) {
    console.log(`recovered ${recovered} orphaned run(s)`);
  }
  const seeds = await loadSeedLists();
  const optedOut = new Set(seeds.optOuts.map((o) => o.homeDomain));
  for (const anchor of seeds.anchors) {
    if (optedOut.has(anchor.homeDomain)) {
      console.log(`seed ${anchor.homeDomain}: opted out, skipping`);
      continue;
    }
    await store.upsertAnchor({
      homeDomain: anchor.homeDomain,
      network: anchor.network,
      displayName: anchor.displayName,
    });
  }
  const outcomes = await scanner.scanOnce();
  const complete = outcomes.filter((o) => o.status === "complete").length;
  const aborted = outcomes.length - complete;
  console.log(`scan pass done: ${complete} complete, ${aborted} aborted`);
} finally {
  await store.close();
  await lockClient.end();
}
