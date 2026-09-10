import Fastify, { type FastifyInstance } from "fastify";
import { all } from "@plumblinehq/plumbline-checks";
import type { Config } from "./config.js";
import { metrics, renderMetrics } from "./metrics.js";
import { badgeSvg } from "./badge.js";
import type {
  AnchorDetailRow,
  AnchorScoreRow,
  HistoryPoint,
  RunDetailRow,
  RunSummaryRow,
  StoredCheckResult,
} from "./store.js";

/**
 * The store surface the HTTP layer needs. The real Store satisfies this
 * structurally; route tests provide an in-memory fake, which is what keeps
 * the API testable without Postgres.
 */
export interface ApiStore {
  ready(): Promise<boolean>;
  listAnchorsWithScores(options: {
    network?: string;
    sep?: number;
    minScore?: number;
    sort: "name" | "score";
  }): Promise<AnchorScoreRow[]>;
  getAnchorDetail(homeDomain: string): Promise<AnchorDetailRow | null>;
  listRunSummaries(homeDomain: string, limit: number): Promise<RunSummaryRow[] | null>;
  getScoreHistory(homeDomain: string, days: number): Promise<HistoryPoint[] | null>;
  getRun(runId: string): Promise<RunDetailRow | null>;
  getOverallScore(homeDomain: string): Promise<number | null>;
  countAnchorsByNetwork(): Promise<Array<{ network: string; count: number }>>;
}

export interface AppOptions {
  store: ApiStore;
  config: Pick<Config, "rateLimitMax" | "rateLimitWindowSeconds" | "trustProxy">;
}

/**
 * Build the Fastify app: the routes below, plus the two cross-cutting
 * concerns every route shares — open CORS for GET (the whole point is that
 * other people consume this API) and a fixed-window per-IP rate limit.
 * Health and metrics endpoints are exempt from the rate limit so monitoring
 * probes can never trip it; OPTIONS preflights are exempt so browsers can
 * always reach the API.
 *
 * Routes are GET-only by construction: the only non-GET thing the app
 * accepts is OPTIONS, for CORS. There is no POST route to reach.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ trustProxy: options.config.trustProxy });
  const limiter = new FixedWindowLimiter(
    options.config.rateLimitMax,
    options.config.rateLimitWindowSeconds * 1000,
  );

  // --- cross-cutting: CORS -------------------------------------------------
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") {
      return reply
        .code(204)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
        .header("access-control-allow-headers", request.headers["access-control-request-headers"] ?? "*")
        .header("access-control-max-age", "86400")
        .send();
    }
    return undefined;
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("access-control-allow-origin", "*");
    return payload;
  });

  // --- cross-cutting: rate limiting ----------------------------------------
  const EXEMPT_FROM_RATE_LIMIT = new Set(["/healthz", "/readyz", "/metrics"]);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || EXEMPT_FROM_RATE_LIMIT.has(request.url.split("?")[0] ?? "")) {
      return undefined;
    }
    const result = limiter.check(request.ip, Date.now());
    if (!result.allowed) {
      return reply
        .code(429)
        .header("retry-after", String(result.retryAfterSeconds))
        .send({ error: "rate limit exceeded" });
    }
    return undefined;
  });

  // --- cross-cutting: request metrics ---------------------------------------
  app.addHook("onResponse", async (request, reply) => {
    const config = request.routeOptions.config as { routeId?: string };
    metrics.httpRequests.inc({ route: config.routeId ?? "other", status: String(reply.statusCode) });
  });

  // --- health and observability ---------------------------------------------
  app.get("/healthz", { config: { routeId: "healthz" } }, async () => ({ status: "ok" }));

  app.get("/readyz", { config: { routeId: "readyz" } }, async (_request, reply) => {
    const ready = await options.store.ready();
    if (!ready) {
      return reply.code(503).send({ status: "unavailable" });
    }
    return { status: "ready" };
  });

  app.get("/metrics", { config: { routeId: "metrics" } }, async (_request, reply) => {
    const counts = await options.store.countAnchorsByNetwork();
    const anchorSeries = counts.map(
      (row) => `plumbline_anchors_total{network="${row.network}"} ${row.count}`,
    );
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(renderMetrics(anchorSeries));
  });

  // --- the directory ---------------------------------------------------------
  app.get<{ Querystring: AnchorsQuery }>(
    "/api/anchors",
    { config: { routeId: "anchors_list" } },
    async (request, reply) => {
      const query = request.query;
      let network: string | undefined;
      if (query.network !== undefined) {
        if (query.network !== "pubnet" && query.network !== "testnet") {
          return reply.code(400).send({ error: `network must be "pubnet" or "testnet", got "${query.network}"` });
        }
        network = query.network;
      }
      let sep: number | undefined;
      if (query.sep !== undefined) {
        const value = Number.parseInt(query.sep, 10);
        if (!Number.isInteger(value) || value <= 0) {
          return reply.code(400).send({ error: `sep must be a positive integer, got "${query.sep}"` });
        }
        sep = value;
      }
      let minScore: number | undefined;
      if (query.min_score !== undefined) {
        const value = Number.parseFloat(query.min_score);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          return reply.code(400).send({ error: `min_score must be between 0 and 1, got "${query.min_score}"` });
        }
        minScore = value;
      }
      let sort: "name" | "score" = "name";
      if (query.sort !== undefined) {
        if (query.sort !== "name" && query.sort !== "score") {
          return reply.code(400).send({ error: `sort must be "name" or "score", got "${query.sort}"` });
        }
        sort = query.sort;
      }
      return options.store.listAnchorsWithScores({ network, sep, minScore, sort });
    },
  );

  app.get<{ Params: { homeDomain: string } }>(
    "/api/anchors/:homeDomain",
    { config: { routeId: "anchors_detail" } },
    async (request, reply) => {
      const detail = await options.store.getAnchorDetail(normalizeDomain(request.params.homeDomain));
      if (detail === null) {
        return reply.code(404).send({ error: `unknown anchor "${request.params.homeDomain}"` });
      }
      return { ...detail, latestRun: detail.latestRun === null ? null : enrichRun(detail.latestRun) };
    },
  );

  // --- run history and single runs -------------------------------------------
  app.get<{ Params: { homeDomain: string }; Querystring: { limit?: string } }>(
    "/api/anchors/:homeDomain/runs",
    { config: { routeId: "anchors_runs" } },
    async (request, reply) => {
      const limit = boundedInt(request.query.limit, 20, 1, 100, reply, "limit");
      if (limit === undefined) {
        return reply;
      }
      const runs = await options.store.listRunSummaries(normalizeDomain(request.params.homeDomain), limit);
      if (runs === null) {
        return reply.code(404).send({ error: `unknown anchor "${request.params.homeDomain}"` });
      }
      return runs;
    },
  );

  app.get<{ Params: { homeDomain: string }; Querystring: { days?: string } }>(
    "/api/anchors/:homeDomain/history",
    { config: { routeId: "anchors_history" } },
    async (request, reply) => {
      const days = boundedInt(request.query.days, 30, 1, 365, reply, "days");
      if (days === undefined) {
        return reply;
      }
      const history = await options.store.getScoreHistory(normalizeDomain(request.params.homeDomain), days);
      if (history === null) {
        return reply.code(404).send({ error: `unknown anchor "${request.params.homeDomain}"` });
      }
      return history;
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId",
    { config: { routeId: "runs_detail" } },
    async (request, reply) => {
      const run = await options.store.getRun(request.params.runId);
      if (run === null) {
        return reply.code(404).send({ error: `unknown run "${request.params.runId}"` });
      }
      return enrichRun(run);
    },
  );

  // --- the check catalogue ----------------------------------------------------
  app.get(
    "/api/checks",
    { config: { routeId: "checks_catalogue" } },
    async () =>
      all().map((check) => ({
        id: check.id,
        sep: check.sep,
        title: check.title,
        description: check.description,
        severity: check.severity,
        specRef: check.specRef,
        requires: check.requires,
      })),
  );

  // --- badges ------------------------------------------------------------------
  app.get<{ Params: { file: string } }>(
    "/badge/:file",
    { config: { routeId: "badge" } },
    async (request, reply) => {
      const file = request.params.file;
      if (!file.endsWith(".svg")) {
        return reply.code(404).send({ error: "not found" });
      }
      const homeDomain = file.slice(0, -4).toLowerCase();
      const score = await options.store.getOverallScore(homeDomain);
      return reply
        .header("content-type", "image/svg+xml; charset=utf-8")
        .header("cache-control", "public, max-age=3600")
        .send(badgeSvg(homeDomain, score));
    },
  );

  return app;
}

interface AnchorsQuery {
  network?: string;
  sep?: string;
  min_score?: string;
  sort?: string;
}

/** Domains are case-insensitive and stored lowercase; normalise the param. */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase();
}

/**
 * Parse an integer query parameter with a default, clamping out-of-range
 * values silently — a consumer asking for `limit=500` gets the cap, not an
 * error, and asking for `days=0` gets the floor. Non-integers are rejected
 * with a 400, because a typo should be visible, not silently interpreted.
 */
function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  reply: { code(status: number): { send(payload: unknown): unknown } },
  name: string,
): number | undefined {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    reply.code(400).send({ error: `${name} must be an integer, got "${raw}"` });
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

/** Stored results carry no title; add it from the pinned checks catalogue. */
const titleById = new Map(all().map((check) => [check.id, check]));

function enrichRun(run: RunDetailRow): RunDetailRow {
  return { ...run, results: run.results.map(enrichResult) };
}

function enrichResult(result: StoredCheckResult): StoredCheckResult & { title: string } {
  return { ...result, title: titleById.get(result.checkId)?.title ?? result.checkId };
}

/**
 * A fixed-window per-key limiter. In-memory only, which is the honest scope
 * for a single-instance deployment: a fleet would need a shared store, and
 * pretending otherwise in the code would be worse than stating it. Expired
 * buckets are swept when the map grows so a flood of distinct IPs cannot
 * grow memory without bound.
 */
class FixedWindowLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  readonly #max: number;
  readonly #windowMs: number;

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  check(
    key: string,
    now: number,
  ): { allowed: boolean; retryAfterSeconds: number } {
    if (this.#buckets.size > 10_000) {
      for (const [bucketKey, bucket] of this.#buckets) {
        if (bucket.resetAt <= now) {
          this.#buckets.delete(bucketKey);
        }
      }
    }
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count < this.#max) {
      bucket.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
}