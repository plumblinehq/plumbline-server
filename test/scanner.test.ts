import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@plumblinehq/plumbline-checks";

import type { Config } from "../src/config.js";
import { Scanner } from "../src/scanner.js";
import type { Store } from "../src/store.js";

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: "postgres://unused",
    scanIntervalSeconds: 60,
    scanJitterFraction: 0,
    scanConcurrency: 1,
    runTimeoutSeconds: 600,
    port: 3000,
    host: "0.0.0.0",
    rateLimitMax: 300,
    rateLimitWindowSeconds: 60,
    regressionWebhookUrl: undefined,
    alertCooldownSeconds: 24 * 60 * 60,
    trustProxy: false,
    ...overrides,
  };
}

function capturingLogger(errors: string[]): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: (message: string) => {
      errors.push(message);
    },
  };
}

describe("Scanner.startScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a failed pass and keeps the cadence instead of dying", async () => {
    let listAnchorsCalls = 0;
    const errors: string[] = [];
    const store = {
      async listAnchors() {
        listAnchorsCalls += 1;
        // The first pass fails the way a cold start does: the very first
        // query hits a database that is not answering yet.
        if (listAnchorsCalls === 1) {
          throw new Error("database is still waking up");
        }
        return [];
      },
    } as unknown as Store;

    const scanner = new Scanner(store, fakeConfig(), capturingLogger(errors));
    scanner.startScheduler();

    // Let the first pass fail, then advance a full interval: a second pass
    // proves the loop survived rather than rejecting out of existence.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(errors.some((message) => message.includes("scan pass failed"))).toBe(
      true,
    );
    expect(listAnchorsCalls).toBeGreaterThanOrEqual(2);
  });
});
