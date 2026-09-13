#!/usr/bin/env node
/**
 * The server entrypoint: load configuration (failing fast on a missing
 * DATABASE_URL), apply pending migrations so a fresh deployment comes up
 * schema-complete, and serve the HTTP API. The web service deliberately does
 * not scan.
 *
 * Scanning runs on a schedule from `.github/workflows/scan.yml`, which is
 * what makes the documented interval true. An in-process scheduler here only
 * ran while the host happened to be awake — on a plan whose web service
 * sleeps after inactivity the recorded history silently thinned out to
 * whenever someone happened to hit the API, while the README still claimed a
 * fixed interval. Moving the scan to its own scheduled job means the API can
 * sleep freely: it serves whatever the scheduler last wrote.
 */
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { Store } from "./store.js";
import { buildApp } from "./server.js";

const config = loadConfig();
const store = new Store(config.databaseUrl);
const app = buildApp({ store, config });

try {
  const applied = await runMigrations(store.sql);
  if (applied > 0) {
    console.log(`migrations applied: ${applied}`);
  }
  await app.listen({ host: config.host, port: config.port });
  console.log(`plumbline-server listening on http://${config.host}:${config.port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await store.close();
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  await app.close();
  await store.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));