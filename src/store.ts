import { VERSION } from "@plumblinehq/plumbline-checks";
import postgres from "postgres";
import type { Result } from "@plumblinehq/plumbline-checks";
import type { Scores } from "./scoring.js";
import type { Sql } from "./migrate.js";

/**
 * The Postgres store. Thin and explicit: every query the server runs lives
 * here so the schema is auditable from one file. `checks_lib_version` is
 * stamped from the checks package's own VERSION export — the provenance the
 * whole history depends on.
 *
 * Ids are TypeScript strings, not numbers or bigints: BIGSERIAL is an int8
 * column and postgres.js returns int8 as a string so that ids beyond
 * Number.MAX_SAFE_INTEGER survive, and its parameter type does not accept
 * bigint. The string boundary is what the driver actually produces and
 * consumes.
 */
export class Store {
  readonly #sql: Sql;

  constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { max: 10 });
  }

  /** Raw client for the migration runner and health checks. */
  get sql(): Sql {
    return this.#sql;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }

  async ready(): Promise<boolean> {
    try {
      await this.#sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async upsertAnchor(input: {
    homeDomain: string;
    network: "pubnet" | "testnet";
    displayName?: string;
  }): Promise<string> {
    const rows = await this.#sql`
        INSERT INTO anchors (home_domain, network, display_name)
        VALUES (${input.homeDomain}, ${input.network}, ${input.displayName ?? null})
        ON CONFLICT (home_domain) DO UPDATE
        SET network = EXCLUDED.network,
            display_name = COALESCE(EXCLUDED.display_name, anchors.display_name)
        RETURNING id`;
    return rows[0]!.id;
  }

  async listAnchors(options: { enabledOnly?: boolean } = {}): Promise<
    Array<{
      id: string;
      homeDomain: string;
      network: string;
      displayName: string | null;
      enabled: boolean;
      optedOut: boolean;
    }>
  > {
    const rows = options.enabledOnly
      ? await this.#sql`
          SELECT id, home_domain, network, display_name, enabled, opted_out
          FROM anchors WHERE enabled = TRUE AND opted_out = FALSE`
      : await this.#sql`
          SELECT id, home_domain, network, display_name, enabled, opted_out
          FROM anchors`;
    return rows.map((row) => ({
      id: row.id,
      homeDomain: row.home_domain,
      network: row.network,
      displayName: row.display_name,
      enabled: row.enabled,
      optedOut: row.opted_out,
    }));
  }

  async startRun(input: { anchorId: string }): Promise<string> {
    const rows = await this.#sql`
        INSERT INTO runs (anchor_id, started_at, checks_lib_version, status)
        VALUES (${input.anchorId}, now(), ${VERSION}, 'running')
        RETURNING id`;
    return rows[0]!.id;
  }

  async completeRun(input: { runId: string; scores: Scores }): Promise<void> {
    await this.#sql`
        UPDATE runs
        SET finished_at = now(),
            overall_score = ${input.scores.overall},
            status = 'complete'
        WHERE id = ${input.runId}`;
  }

  async abortRun(runId: string): Promise<void> {
    // A run that exceeds its timeout is marked aborted, not silently
    // dropped — a missing run and a failed run must be distinguishable.
    await this.#sql`
        UPDATE runs
        SET finished_at = now(),
            status = 'aborted'
        WHERE id = ${runId} AND status = 'running'`;
  }

  async saveResults(input: {
    runId: string;
    results: Result[];
    scores: Scores;
  }): Promise<void> {
    const rows = input.results.map((result) => ({
      run_id: input.runId,
      check_id: result.checkId,
      sep: result.sep,
      status: result.status,
      severity: result.severity,
      message: result.message,
      spec_ref: result.specRef,
      evidence: JSON.stringify(result.evidence),
      duration_ms: result.durationMs,
    }));
    await this.#sql`
        INSERT INTO check_results ${this.#sql(rows)}`;
    const gradeRows = input.scores.grades.map((grade) => ({
      run_id: input.runId,
      sep: grade.sep,
      score: grade.score,
      applicable: grade.applicable,
    }));
    if (gradeRows.length > 0) {
      await this.#sql`
        INSERT INTO sep_grades ${this.#sql(gradeRows)}`;
    }
  }

  async recordRegressions(input: {
    anchorId: string;
    runId: string;
    regressions: Array<{ checkId: string }>;
  }): Promise<string[]> {
    if (input.regressions.length === 0) {
      return [];
    }
    const rows = input.regressions.map((regression) => ({
      anchor_id: input.anchorId,
      run_id: input.runId,
      check_id: regression.checkId,
    }));
    const inserted = await this.#sql`
        INSERT INTO regressions ${this.#sql(rows)}
        RETURNING id`;
    return inserted.map((row) => row.id);
  }

  /**
   * The most recent complete run's results for an anchor, flattened for the
   * regression comparison. An anchor's first run has none.
   */
  async previousRunResults(anchorId: string): Promise<Result[]> {
    const rows = await this.#sql`
        SELECT r.check_id, r.sep, r.severity, r.status, r.message, r.spec_ref, r.duration_ms
        FROM runs run
        JOIN check_results r ON r.run_id = run.id
        WHERE run.anchor_id = ${anchorId}
          AND run.status = 'complete'
          AND run.id = (SELECT MAX(id) FROM runs WHERE anchor_id = ${anchorId} AND status = 'complete')
          AND r.status IN ('pass', 'fail')`;
    return rows.map((row) => ({
      checkId: row.check_id,
      sep: row.sep,
      title: "",
      status: row.status,
      severity: row.severity,
      message: row.message ?? "",
      specRef: row.spec_ref ?? "",
      evidence: [],
      durationMs: row.duration_ms ?? 0,
    }));
  }
}
