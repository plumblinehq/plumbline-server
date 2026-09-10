#!/usr/bin/env node
/**
 * The server entrypoint. Loads configuration (failing fast on a missing
 * DATABASE_URL), applies pending migrations so a fresh deployment comes up
 * schema-complete, starts the scheduler, and serves the HTTP API. The one
 * process runs both halves deliberately: a scanner without an API to read it
 * is invisible, and an API without a scanner serves stale rows forever.
 */
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { Scanner } from "./scanner.js";
import { Store } from "./store.js";
import { buildApp } from "./server.js";
import { createRegressionNotifier } from "./webhook.js";

const config = loadConfig();
const store = new Store(config.databaseUrl);
const notifier = createRegressionNotifier(config.regressionWebhookUrl);
const scanner = new Scanner(store, config, undefined, notifier);
const app = buildApp({ store, config });

try {
  const applied = await runMigrations(store.sql);
  if (applied > 0) {
    console.log(`migrations applied: ${applied}`);
  }
  scanner.startScheduler();
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