import {
  RateLimitedHttpClient,
  VERSION,
  consoleLogger,
  run,
  type Env,
  type Logger,
  type Network,
  type Result,
} from "@plumblinehq/plumbline-checks";
import type { Config } from "./config.js";
import { detectRegressions, type Regression } from "./regressions.js";
import { scoreRun, type Scores } from "./scoring.js";
import type { Store } from "./store.js";
import type { RegressionNotifier, RegressionNotification } from "./webhook.js";

/**
 * The scanner, per plumbline-architecture.md §6.2: every enabled anchor is
 * scanned on a jittered interval so runs do not stampede, a small worker pool
 * bounds concurrency, and per-host serialisation guarantees two scans never
 * hit the same anchor host at once — that last part is enforced inside the
 * checks package's RateLimitedHttpClient, which is why one client is shared
 * across every scan rather than one per anchor.
 */
export interface ScanOutcome {
  anchorId: string;
  homeDomain: string;
  runId: string | undefined;
  status: "complete" | "aborted";
  results: Result[];
  scores: Scores | undefined;
  regressions: Regression[];
}

export class Scanner {
  readonly #store: Store;
  readonly #config: Config;
  readonly #http: RateLimitedHttpClient;
  readonly #logger: Logger;
  readonly #notify: RegressionNotifier;

  constructor(
    store: Store,
    config: Config,
    logger: Logger = consoleLogger,
    notify: RegressionNotifier = () => undefined,
  ) {
    this.#store = store;
    this.#config = config;
    this.#logger = logger;
    this.#notify = notify;
    // One client for the whole process: its per-host gates serialise requests
    // per anchor host no matter how many runs are in flight.
    this.#http = new RateLimitedHttpClient({ logger });
  }

  /**
   * Scans one anchor: opens a run row, runs the checks, persists results and
   * grades, detects regressions against the previous complete run. Any
   * failure — including a run exceeding RUN_TIMEOUT — marks the run aborted
   * rather than dropping it; a missing run and a failed run must be
   * distinguishable in the history.
   */
  async scanAnchor(input: {
    anchorId: string;
    homeDomain: string;
    network: string;
  }): Promise<ScanOutcome> {
    const { anchorId, homeDomain } = input;
    const network: Network = input.network === "testnet" ? "testnet" : "pubnet";
    const runId = await this.#store.startRun({ anchorId });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`run ${runId} for ${homeDomain} exceeded its timeout`)),
        this.#config.runTimeoutSeconds * 1000,
      ).unref();
    });
    try {
      const env: Env = {
        homeDomain,
        network,
        http: this.#http,
        now: () => new Date(),
        logger: this.#logger,
      };
      const results = await Promise.race([
        run(env, { seps: [1, 10] }),
        timeout,
      ]);
      const scores = scoreRun(results);
      await this.#store.saveResults({ runId, results, scores });
      await this.#store.completeRun({ runId, scores });
      const previous = await this.#store.previousRunResults(anchorId);
      const regressions = detectRegressions(previous, results);
      await this.#store.recordRegressions({ anchorId, runId, regressions });
      await this.#emitRegressions({
        anchorId,
        homeDomain,
        network: input.network,
        runId,
        regressions,
        results,
        scores,
      });
      this.#logger.info(
        `scan ${homeDomain}: run ${runId} complete, score ${scores.overall.toFixed(3)}, ${regressions.length} regression(s)`,
      );
      return { anchorId, homeDomain, runId, status: "complete", results, scores, regressions };
    } catch (cause) {
      await this.#store.abortRun(runId);
      this.#logger.error(
        `scan ${homeDomain}: run ${runId} aborted — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return { anchorId, homeDomain, runId, status: "aborted", results: [], scores: undefined, regressions: [] };
    }
  }

  /**
   * Emit webhook alerts for regressions, suppressing repeats of the same
   * regression within ALERT_COOLDOWN: the first pass → fail transition alerts,
   * and the alert stays quiet while the anchor stays broken rather than
   * paging on every six-hour scan. Every regression is still recorded in the
   * regressions table — suppression is about alerting, not bookkeeping.
   */
  async #emitRegressions(input: {
    anchorId: string;
    homeDomain: string;
    network: string;
    runId: string;
    regressions: Regression[];
    results: Result[];
    scores: Scores;
  }): Promise<void> {
    if (input.regressions.length === 0) {
      return;
    }
    const resultById = new Map(input.results.map((result) => [result.checkId, result]));
    const fresh: RegressionNotification["regressions"] = [];
    for (const regression of input.regressions) {
      const suppressed = await this.#store.recentRegression(
        input.anchorId,
        regression.checkId,
        this.#config.alertCooldownSeconds,
        input.runId,
      );
      if (suppressed) {
        continue;
      }
      const result = resultById.get(regression.checkId);
      fresh.push({
        checkId: regression.checkId,
        title: result?.title ?? regression.checkId,
        message: result?.message ?? "",
        specRef: result?.specRef ?? "",
      });
    }
    if (fresh.length > 0) {
      this.#notify({
        homeDomain: input.homeDomain,
        network: input.network,
        runId: input.runId,
        checksLibVersion: VERSION,
        overallScore: input.scores.overall,
        regressions: fresh,
      });
    }
  }

  /**
   * One pass over every enabled, non-opted-out anchor, running at most
   * SCAN_CONCURRENCY scans at once. Used by the one-shot scan command and by
   * the scheduler's tick.
   */
  async scanOnce(): Promise<ScanOutcome[]> {
    const anchors = await this.#store.listAnchors({ enabledOnly: true });
    const outcomes: ScanOutcome[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(this.#config.scanConcurrency, anchors.length) },
      async () => {
        for (;;) {
          const anchor = anchors[cursor];
          cursor += 1;
          if (anchor === undefined) {
            return;
          }
          outcomes.push(
            await this.scanAnchor({
              anchorId: anchor.id,
              homeDomain: anchor.homeDomain,
              network: anchor.network,
            }),
          );
        }
      },
    );
    await Promise.all(workers);
    return outcomes.sort((a, b) => (a.anchorId < b.anchorId ? -1 : 1));
  }

  /**
   * The scheduler loop: scans everything once, then re-schedules each anchor
   * independently at SCAN_INTERVAL with ±(SCAN_JITTER × SCAN_INTERVAL)
   * jitter, per architecture §6.2. Independent timers keep one slow anchor
   * from delaying everyone else.
   */
  startScheduler(): void {
    const interval = this.#config.scanIntervalSeconds * 1000;
    const jitter = this.#config.scanJitterFraction * interval;
    void (async () => {
      for (;;) {
        const startedAt = Date.now();
        await this.scanOnce();
        const elapsed = Date.now() - startedAt;
        const wait = Math.max(0, interval - elapsed) + (Math.random() * 2 - 1) * jitter;
        this.#logger.info(
          `scan pass finished in ${Math.round(elapsed / 1000)}s; next pass in ${Math.round(wait / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait).unref());
      }
    })();
  }
}
