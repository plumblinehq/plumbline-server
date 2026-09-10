import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type ApiStore } from "../src/server.js";
import { metrics } from "../src/metrics.js";
import type { AnchorDetailRow, AnchorScoreRow } from "../src/store.js";

function makeConfig(
  overrides: Partial<{ rateLimitMax: number; rateLimitWindowSeconds: number; trustProxy: boolean }> = {},
) {
  return { rateLimitMax: 1000, rateLimitWindowSeconds: 60, trustProxy: false, ...overrides };
}

function fakeStore(overrides: Partial<ApiStore> = {}): ApiStore {
  return {
    ready: async () => true,
    listAnchorsWithScores: async () => [],
    getAnchorDetail: async () => null,
    listRunSummaries: async () => null,
    getScoreHistory: async () => null,
    getRun: async () => null,
    getOverallScore: async () => null,
    countAnchorsByNetwork: async () => [],
    ...overrides,
  };
}

const anclapRow: AnchorScoreRow = {
  id: "1",
  homeDomain: "anclap.com",
  network: "pubnet",
  displayName: "Anclap",
  optedOut: false,
  lastRunId: "10",
  lastRunAt: "2026-09-10T00:00:00.000Z",
  lastRunStatus: "complete",
  overallScore: 0.83,
  grades: [
    { sep: 1, score: 0.9, applicable: true },
    { sep: 10, score: 0.75, applicable: true },
  ],
};

const mykoboRow: AnchorScoreRow = {
  ...anclapRow,
  id: "2",
  homeDomain: "mykobo.co",
  displayName: "Mykobo",
  overallScore: 0.4,
};

const anclapDetail: AnchorDetailRow = {
  id: "1",
  homeDomain: "anclap.com",
  network: "pubnet",
  displayName: "Anclap",
  addedAt: "2026-09-01T00:00:00.000Z",
  optedOut: false,
  optOutNote: null,
  latestRun: {
    id: "10",
    anchorId: "1",
    homeDomain: "anclap.com",
    network: "pubnet",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:00:10.000Z",
    status: "complete",
    overallScore: 0.83,
    checksLibVersion: "0.2.3",
    grades: [{ sep: 1, score: 0.9, applicable: true }],
    results: [
      {
        checkId: "sep1.toml-cors",
        sep: 1,
        status: "pass",
        severity: "error",
        message: "Access-Control-Allow-Origin: * is set.",
        specRef: "SEP-1 §Specification, CORS",
        evidence: [],
        durationMs: 12,
      },
    ],
  },
};

beforeEach(() => {
  metrics.reset();
});

describe("health and observability routes", () => {
  it("serves /healthz", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("serves /readyz when the database is reachable", async () => {
    const app = buildApp({ store: fakeStore({ ready: async () => true }), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("reports 503 from /readyz when the database is down", async () => {
    const app = buildApp({ store: fakeStore({ ready: async () => false }), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
  });

  it("serves Prometheus text from /metrics with live anchor counts", async () => {
    const store = fakeStore({
      countAnchorsByNetwork: async () => [
        { network: "testnet", count: 1 },
        { network: "pubnet", count: 4 },
      ],
    });
    const app = buildApp({ store, config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain('plumbline_anchors_total{network="pubnet"} 4');
    expect(response.body).toContain('plumbline_anchors_total{network="testnet"} 1');
  });

  it("counts requests per route in /metrics", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/api/checks" });
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.body).toContain('plumbline_http_requests_total{route="healthz",status="200"} 2');
    expect(response.body).toContain('plumbline_http_requests_total{route="checks_catalogue",status="200"} 1');
  });
});

describe("CORS", () => {
  it("adds Access-Control-Allow-Origin: * to every response", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("answers OPTIONS preflights with the allowed methods", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/anchors",
      headers: { "access-control-request-method": "GET" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-methods"]).toBe("GET, HEAD, OPTIONS");
    expect(response.headers["access-control-max-age"]).toBe("86400");
  });
});

describe("rate limiting", () => {
  it("rejects requests past the per-IP limit with retry-after", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig({ rateLimitMax: 2 }) });
    await app.inject({ method: "GET", url: "/api/checks" });
    await app.inject({ method: "GET", url: "/api/checks" });
    const third = await app.inject({ method: "GET", url: "/api/checks" });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "rate limit exceeded" });
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("exempts health and metrics endpoints from the rate limit", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig({ rateLimitMax: 1 }) });
    const first = await app.inject({ method: "GET", url: "/healthz" });
    const second = await app.inject({ method: "GET", url: "/healthz" });
    const metricsResponse = await app.inject({ method: "GET", url: "/metrics" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(metricsResponse.statusCode).toBe(200);
  });
});

describe("GET /api/anchors", () => {
  it("returns the anchors from the store, sorted by name by default", async () => {
    const store = fakeStore({
      listAnchorsWithScores: async () => [mykoboRow, anclapRow],
    });
    const app = buildApp({ store, config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/anchors" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([mykoboRow, anclapRow]);
  });

  it("passes the network, sep, min_score and sort filters to the store", async () => {
    const listAnchorsWithScores = vi.fn(async () => []);
    const store = fakeStore({ listAnchorsWithScores });
    const app = buildApp({ store, config: makeConfig() });
    await app.inject({ method: "GET", url: "/api/anchors?network=testnet&sep=10&min_score=0.5&sort=score" });
    expect(listAnchorsWithScores).toHaveBeenCalledWith({
      network: "testnet",
      sep: 10,
      minScore: 0.5,
      sort: "score",
    });
  });

  it.each([
    ["network=banana", /network/],
    ["sep=zero", /sep/],
    ["min_score=2", /min_score/],
    ["sort=popularity", /sort/],
  ])("rejects %s with a 400", async (query, message) => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: `/api/anchors?${query}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(message);
  });
});

describe("GET /api/anchors/:homeDomain", () => {
  it("returns the anchor detail with result titles from the catalogue", async () => {
    const store = fakeStore({ getAnchorDetail: async () => anclapDetail });
    const app = buildApp({ store, config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/anchors/anclap.com" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.homeDomain).toBe("anclap.com");
    expect(body.latestRun.results[0].title).toBe("stellar.toml sets Access-Control-Allow-Origin: *");
  });

  it("404s for an unknown anchor", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/anchors/ghost.example" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain("unknown anchor");
  });
});

describe("run history and single-run routes", () => {
  it("lists runs for an anchor with a clamped limit", async () => {
    const listRunSummaries = vi.fn(async () => []);
    const store = fakeStore({ listRunSummaries });
    const app = buildApp({ store, config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/anchors/anclap.com/runs?limit=1000" });
    expect(response.statusCode).toBe(200);
    expect(listRunSummaries).toHaveBeenCalledWith("anclap.com", 100);
  });

  it("404s run history for an unknown anchor", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/anchors/ghost.example/runs" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a non-integer limit or days value", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const runs = await app.inject({ method: "GET", url: "/api/anchors/anclap.com/runs?limit=abc" });
    const history = await app.inject({ method: "GET", url: "/api/anchors/anclap.com/history?days=nope" });
    expect(runs.statusCode).toBe(400);
    expect(history.statusCode).toBe(400);
  });

  it("serves the score history with the default window", async () => {
    const getScoreHistory = vi.fn(async () => []);
    const store = fakeStore({ getScoreHistory });
    const app = buildApp({ store, config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/anchors/anclap.com/history" });
    expect(response.statusCode).toBe(200);
    expect(getScoreHistory).toHaveBeenCalledWith("anclap.com", 30);
  });

  it("serves a single run with result titles from the catalogue", async () => {
    const store = fakeStore({
      getRun: async () => ({
        id: "10",
        anchorId: "1",
        homeDomain: "anclap.com",
        network: "pubnet",
        startedAt: "2026-09-10T00:00:00.000Z",
        finishedAt: "2026-09-10T00:00:10.000Z",
        status: "complete",
        overallScore: 0.83,
        checksLibVersion: "0.2.3",
        grades: [{ sep: 1, score: 0.9, applicable: true }],
        results: [
          {
            checkId: "sep1.toml-cors",
            sep: 1,
            status: "pass",
            severity: "error",
            message: "ok",
            specRef: "SEP-1 §Specification, CORS",
            evidence: [],
            durationMs: 12,
          },
        ],
      }),
    });
    const app = buildApp({ store, config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/runs/10" });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].title).toBe("stellar.toml sets Access-Control-Allow-Origin: *");
  });

  it("404s for an unknown run", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/runs/9999" });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/checks", () => {
  it("serves the catalogue with spec references, sorted by id", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/api/checks" });
    expect(response.statusCode).toBe(200);
    const checks = response.json() as Array<Record<string, unknown>>;
    expect(checks.length).toBeGreaterThan(50);
    expect(checks[0]!.id).toBe("sep1.accounts-valid");
    const cors = checks.find((check) => check.id === "sep1.toml-cors");
    expect(cors?.specRef).toBe("SEP-1 §Specification, CORS");
    expect(cors?.severity).toBe("error");
    for (const check of checks) {
      expect(check).toHaveProperty("id");
      expect(check).toHaveProperty("sep");
      expect(check).toHaveProperty("title");
      expect(check).toHaveProperty("description");
      expect(check).toHaveProperty("severity");
      expect(check).toHaveProperty("specRef");
      expect(check).toHaveProperty("requires");
    }
  });
});

describe("GET /badge/:homeDomain.svg", () => {
  it("serves a cached SVG with the anchor's score", async () => {
    const store = fakeStore({ getOverallScore: async () => 0.83 });
    const app = buildApp({ store, config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/badge/anclap.com.svg" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.body).toContain("83%");
    expect(response.body).toContain('fill="#97CA00"');
  });

  it("renders no data for an anchor without a complete run", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/badge/fresh.example.com.svg" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("no data");
    expect(response.body).toContain('fill="#555"');
  });

  it("404s anything that is not an .svg file", async () => {
    const app = buildApp({ store: fakeStore(), config: makeConfig() });
    const response = await app.inject({ method: "GET", url: "/badge/anclap.com.png" });
    expect(response.statusCode).toBe(404);
  });
});