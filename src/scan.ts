/**
 * One-shot scan command: load the seed lists, apply the opt-outs, run one
 * scan pass, print a summary line per anchor. This is the command the Stage
 * 4 checkpoint runs — a real scan writing real rows to Postgres.
 */
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { loadSeedLists } from "./seed.js";
import { Scanner } from "./scanner.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(config.databaseUrl);
const scanner = new Scanner(store, config);

try {
  // Migrations run before anything touches the tables — on a fresh database
  // the seed upserts would otherwise hit nonexistent relations.
  const applied = await runMigrations(store.sql);
  if (applied > 0) {
    console.log(`migrations applied: ${applied}`);
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
}
