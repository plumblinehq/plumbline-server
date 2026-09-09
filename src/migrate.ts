/**
 * The migration runner.
 *
 * Deliberately minimal: reads `migrations/*.sql` in filename order, skips the
 * ones already applied, and applies each inside a transaction recorded in
 * `schema_migrations`. No down migrations — forward-only with restore from
 * backup is the honest trade for a monitoring store this size, and a fake
 * down script is worse than none.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/** The sql client; the store and the runner share this type. */
export type Sql = postgres.Sql;

export async function runMigrations(sql: Sql, dir?: string): Promise<number> {
  const migrationsDir = dir ?? fileURLToPath(new URL("../migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  const applied = new Set(
    (await sql`SELECT version FROM schema_migrations`).map((row) => row.version),
  );

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const body = await readFile(`${migrationsDir}/${file}`, "utf8");
    await sql.begin(async (tx) => {
      // postgres.js interpolates the file body as a single parameter, so the
      // migration SQL is never parsed as multiple statements in an unsafe
      // way; a failure rolls the whole file back.
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
    count += 1;
  }
  return count;
}

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("src/migrate.ts");
if (isDirectRun) {
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const sql = postgres(config.databaseUrl, { max: 1 });
  try {
    const applied = await runMigrations(sql);
    console.log(`migrations applied: ${applied}`);
  } finally {
    await sql.end();
  }
}
