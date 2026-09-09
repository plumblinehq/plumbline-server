import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("fails fast when DATABASE_URL is empty", () => {
    expect(() => loadConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("applies the documented defaults", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/test" });
    expect(config).toMatchObject({
      databaseUrl: "postgres://localhost/test",
      scanIntervalSeconds: 6 * 60 * 60,
      scanJitterFraction: 0.2,
      scanConcurrency: 4,
      runTimeoutSeconds: 600,
    });
  });

  it("rejects non-numeric or non-positive integers", () => {
    const base = { DATABASE_URL: "postgres://localhost/test" };
    expect(() => loadConfig({ ...base, SCAN_CONCURRENCY: "four" })).toThrow(/SCAN_CONCURRENCY/);
    expect(() => loadConfig({ ...base, SCAN_CONCURRENCY: "0" })).toThrow(/SCAN_CONCURRENCY/);
    expect(() => loadConfig({ ...base, SCAN_JITTER: "1.5" })).toThrow(/SCAN_JITTER/);
  });
});
