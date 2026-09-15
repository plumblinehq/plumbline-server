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
      scanConcurrency: 4,
      runTimeoutSeconds: 600,
      port: 3000,
      host: "0.0.0.0",
      rateLimitMax: 300,
      rateLimitWindowSeconds: 60,
      regressionWebhookUrl: undefined,
      alertCooldownSeconds: 24 * 60 * 60,
      trustProxy: false,
    });
  });

  it("parses the HTTP server settings", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      PORT: "8080",
      HOST: "127.0.0.1",
      RATE_LIMIT_MAX: "50",
      RATE_LIMIT_WINDOW: "10",
      ALERT_COOLDOWN: "3600",
      TRUST_PROXY: "true",
      REGRESSION_WEBHOOK_URL: "https://hooks.example.com/abc",
    });
    expect(config).toMatchObject({
      port: 8080,
      host: "127.0.0.1",
      rateLimitMax: 50,
      rateLimitWindowSeconds: 10,
      alertCooldownSeconds: 3600,
      trustProxy: true,
      regressionWebhookUrl: "https://hooks.example.com/abc",
    });
  });

  it("rejects a webhook URL that is not a URL", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://localhost/test", REGRESSION_WEBHOOK_URL: "not-a-url" }),
    ).toThrow(/REGRESSION_WEBHOOK_URL/);
  });

  it("accepts RATE_LIMIT_MAX=0 as the documented disable value", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/test", RATE_LIMIT_MAX: "0" });
    expect(config.rateLimitMax).toBe(0);
  });

  it("rejects a negative RATE_LIMIT_MAX", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://localhost/test", RATE_LIMIT_MAX: "-1" }),
    ).toThrow(/RATE_LIMIT_MAX/);
  });

  it("rejects non-boolean TRUST_PROXY values", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost/test", TRUST_PROXY: "maybe" })).toThrow(
      /TRUST_PROXY/,
    );
  });

  it("rejects non-numeric or non-positive integers", () => {
    const base = { DATABASE_URL: "postgres://localhost/test" };
    expect(() => loadConfig({ ...base, SCAN_CONCURRENCY: "four" })).toThrow(/SCAN_CONCURRENCY/);
    expect(() => loadConfig({ ...base, SCAN_CONCURRENCY: "0" })).toThrow(/SCAN_CONCURRENCY/);
    expect(() => loadConfig({ ...base, RUN_TIMEOUT: "-1" })).toThrow(/RUN_TIMEOUT/);
  });
});
