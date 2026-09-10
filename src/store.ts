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
 * consumes. NUMERIC scores come back as strings for the same reason and are
 * converted with Number() at the boundary, and timestamptz comes back as a
 * Date, normalised to ISO strings so the JSON the API emits is stable.
 */

/** A per-SEP grade from a run. */
export interface SepGrade {
  sep: number;
  score: number;
  applicable: boolean;
}

/** An anchor with the score of its latest complete run, for the directory. */
export interface AnchorScoreRow {
  id: string;
  homeDomain: string;
  network: string;
  displayName: string | null;
  optedOut: boolean;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastRunStatus: "complete" | "aborted" | null;
  overallScore: number | null;
  grades: SepGrade[];
}

/** One stored check result; titles are added at serve time from the catalogue. */
export interface StoredCheckResult {
  checkId: string;
  sep: number;
  status: string;
  severity: string;
  message: string;
  specRef: string;
  evidence: unknown;
  durationMs: number | null;
}

/** A run summary row for the run-history endpoint. */
export interface RunSummaryRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  overallScore: number | null;
  checksLibVersion: string;
  counts: { pass: number; fail: number; skip: number; error: number };
}

/** One point of the score-over-time chart. */
export interface HistoryPoint {
  runId: string;
  startedAt: string;
  overallScore: number | null;
  grades: SepGrade[];
}

/** A full run with its grades and results, for the run endpoints. */
export interface RunDetailRow {
  id: string;
  anchorId: string;
  homeDomain: string;
  network: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  overallScore: number | null;
  checksLibVersion: string;
  grades: SepGrade[];
  results: StoredCheckResult[];
}

/** An anchor with its latest complete run, for the detail endpoint. */
export interface AnchorDetailRow {
  id: string;
  homeDomain: string;
  network: string;
  displayName: string | null;
  addedAt: string;
  optedOut: boolean;
  optOutNote: string | null;
  latestRun: RunDetailRow | null;
}
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

  /**
   * The directory query: every enabled, non-opted-out anchor with the score
   * of its latest complete run and that run's per-SEP grades. Filtering by
   * `sep` keeps anchors with an applicable grade for that SEP (an anchor
   * that does not implement a SEP must not be penalised or even listed for
   * it); `minScore` compares against the overall score, or against the
   * selected SEP's score when `sep` is also given. Sorting by score puts
   * unscanned anchors last.
   */
  async listAnchorsWithScores(options: {
    network?: string;
    sep?: number;
    minScore?: number;
    sort: "name" | "score";
  }): Promise<AnchorScoreRow[]> {
    const networkClause =
      options.network === undefined ? this.#sql`` : this.#sql`AND a.network = ${options.network}`;
    const rows = await this.#sql`
        SELECT a.id, a.home_domain, a.network, a.display_name, a.opted_out,
               r.id AS run_id, r.started_at, r.finished_at, r.overall_score, r.status
        FROM anchors a
        LEFT JOIN LATERAL (
            SELECT id, started_at, finished_at, overall_score, status
            FROM runs
            WHERE anchor_id = a.id AND status = 'complete'
            ORDER BY started_at DESC
            LIMIT 1
        ) r ON TRUE
        WHERE a.enabled = TRUE AND a.opted_out = FALSE ${networkClause}`;

    const runIds = rows
      .map((row) => row.run_id)
      .filter((id): id is string => id !== null);
    const gradesByRun = new Map<string, SepGrade[]>();
    if (runIds.length > 0) {
      const gradeRows = await this.#sql`
          SELECT run_id, sep, score, applicable
          FROM sep_grades WHERE run_id IN ${this.#sql(runIds)}
          ORDER BY sep`;
      for (const row of gradeRows) {
        const runId = row.run_id as string;
        const list = gradesByRun.get(runId) ?? [];
        list.push({ sep: row.sep, score: Number(row.score), applicable: row.applicable });
        gradesByRun.set(runId, list);
      }
    }

    const anchors: AnchorScoreRow[] = rows.map((row) => ({
      id: row.id,
      homeDomain: row.home_domain,
      network: row.network,
      displayName: row.display_name,
      optedOut: row.opted_out,
      lastRunId: row.run_id,
      lastRunAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
      lastRunStatus: row.status === null ? null : row.status,
      overallScore: row.overall_score === null ? null : Number(row.overall_score),
      grades: row.run_id === null ? [] : (gradesByRun.get(row.run_id) ?? []),
    }));

    let filtered = anchors;
    if (options.sep !== undefined) {
      filtered = filtered.filter((anchor) =>
        anchor.grades.some((grade) => grade.sep === options.sep && grade.applicable),
      );
    }
    if (options.minScore !== undefined) {
      filtered = filtered.filter((anchor) => {
        const score =
          options.sep === undefined
            ? anchor.overallScore
            : (anchor.grades.find((grade) => grade.sep === options.sep)?.score ?? null);
        return score !== null && score >= options.minScore!;
      });
    }
    const scoreOf = (anchor: AnchorScoreRow): number => {
      if (options.sep !== undefined) {
        return anchor.grades.find((grade) => grade.sep === options.sep)?.score ?? -1;
      }
      return anchor.overallScore ?? -1;
    };
    if (options.sort === "score") {
      filtered.sort(
        (a, b) => scoreOf(b) - scoreOf(a) || a.homeDomain.localeCompare(b.homeDomain),
      );
    } else {
      filtered.sort((a, b) => a.homeDomain.localeCompare(b.homeDomain));
    }
    return filtered;
  }

  /** Anchor detail with its latest complete run, or null when unknown. */
  async getAnchorDetail(homeDomain: string): Promise<AnchorDetailRow | null> {
    const anchorRows = await this.#sql`
        SELECT id, home_domain, network, display_name, added_at, enabled, opted_out, opt_out_note
        FROM anchors WHERE home_domain = ${homeDomain}`;
    const anchor = anchorRows[0];
    if (anchor === undefined) {
      return null;
    }
    const runRows = await this.#sql`
        SELECT id, started_at, finished_at, status, overall_score, checks_lib_version
        FROM runs
        WHERE anchor_id = ${anchor.id} AND status = 'complete'
        ORDER BY started_at DESC LIMIT 1`;
    const run = runRows[0];
    return {
      id: anchor.id,
      homeDomain: anchor.home_domain,
      network: anchor.network,
      displayName: anchor.display_name,
      addedAt: new Date(anchor.added_at).toISOString(),
      optedOut: anchor.opted_out,
      optOutNote: anchor.opt_out_note,
      latestRun: run === undefined ? null : await this.#runDetail(anchor.id, anchor.home_domain, anchor.network, run),
    };
  }

  /**
   * Run summaries for an anchor, newest first. Returns null when the anchor
   * is unknown (so the route can 404) and [] when it simply has no runs.
   */
  async listRunSummaries(homeDomain: string, limit: number): Promise<RunSummaryRow[] | null> {
    const rows = await this.#sql`
        SELECT a.id AS anchor_id, r.id, r.started_at, r.finished_at, r.status,
               r.overall_score, r.checks_lib_version,
               COUNT(cr.id) FILTER (WHERE cr.status = 'pass') AS pass_count,
               COUNT(cr.id) FILTER (WHERE cr.status = 'fail') AS fail_count,
               COUNT(cr.id) FILTER (WHERE cr.status = 'skip') AS skip_count,
               COUNT(cr.id) FILTER (WHERE cr.status = 'error') AS error_count
        FROM anchors a
        LEFT JOIN runs r ON r.anchor_id = a.id
        LEFT JOIN check_results cr ON cr.run_id = r.id
        WHERE a.home_domain = ${homeDomain}
        GROUP BY a.id, r.id, r.started_at, r.finished_at, r.status, r.overall_score, r.checks_lib_version
        ORDER BY r.started_at DESC NULLS LAST
        LIMIT ${limit}`;
    if (rows.length === 0) {
      return null;
    }
    if (rows[0]!.id === null) {
      return [];
    }
    return rows.map((row) => ({
      id: row.id,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
      status: row.status,
      overallScore: row.overall_score === null ? null : Number(row.overall_score),
      checksLibVersion: row.checks_lib_version,
      counts: {
        pass: Number(row.pass_count),
        fail: Number(row.fail_count),
        skip: Number(row.skip_count),
        error: Number(row.error_count),
      },
    }));
  }

  /**
   * Complete runs in the last `days`, oldest first, for the score chart.
   * Returns null when the anchor is unknown, [] when it has no runs in the
   * window.
   */
  async getScoreHistory(homeDomain: string, days: number): Promise<HistoryPoint[] | null> {
    const rows = await this.#sql`
        SELECT r.id, r.started_at, r.overall_score
        FROM runs r JOIN anchors a ON a.id = r.anchor_id
        WHERE a.home_domain = ${homeDomain} AND r.status = 'complete'
          AND r.started_at >= now() - make_interval(secs => ${days * 24 * 60 * 60})
        ORDER BY r.started_at ASC`;
    if (rows.length === 0) {
      const exists = await this.#sql`SELECT 1 FROM anchors WHERE home_domain = ${homeDomain}`;
      return exists.length === 0 ? null : [];
    }
    const runIds = rows.map((row) => row.id);
    const gradeRows = await this.#sql`
        SELECT run_id, sep, score, applicable
        FROM sep_grades WHERE run_id IN ${this.#sql(runIds)}
        ORDER BY sep`;
    const gradesByRun = new Map<string, SepGrade[]>();
    for (const row of gradeRows) {
      const runId = row.run_id as string;
      const list = gradesByRun.get(runId) ?? [];
      list.push({ sep: row.sep, score: Number(row.score), applicable: row.applicable });
      gradesByRun.set(runId, list);
    }
    return rows.map((row) => ({
      runId: row.id,
      startedAt: new Date(row.started_at).toISOString(),
      overallScore: row.overall_score === null ? null : Number(row.overall_score),
      grades: gradesByRun.get(row.id) ?? [],
    }));
  }

  /** A single run with its grades and results, or null when unknown. */
  async getRun(runId: string): Promise<RunDetailRow | null> {
    const rows = await this.#sql`
        SELECT r.id, r.anchor_id, r.started_at, r.finished_at, r.status,
               r.overall_score, r.checks_lib_version, a.home_domain, a.network
        FROM runs r JOIN anchors a ON a.id = r.anchor_id
        WHERE r.id = ${runId}`;
    const run = rows[0];
    if (run === undefined) {
      return null;
    }
    return this.#runDetail(run.anchor_id as string, run.home_domain, run.network, run);
  }

  /** The latest complete run's overall score for the badge, or null. */
  async getOverallScore(homeDomain: string): Promise<number | null> {
    const rows = await this.#sql`
        SELECT r.overall_score
        FROM runs r JOIN anchors a ON a.id = r.anchor_id
        WHERE a.home_domain = ${homeDomain} AND r.status = 'complete'
        ORDER BY r.started_at DESC LIMIT 1`;
    const row = rows[0];
    return row === undefined || row.overall_score === null ? null : Number(row.overall_score);
  }

  /** Enabled, non-opted-out anchors per network, for the /metrics scrape. */
  async countAnchorsByNetwork(): Promise<Array<{ network: string; count: number }>> {
    const rows = await this.#sql`
        SELECT network, COUNT(*)::int AS count
        FROM anchors WHERE enabled = TRUE AND opted_out = FALSE
        GROUP BY network ORDER BY network`;
    return rows.map((row) => ({ network: row.network, count: row.count }));
  }

  /**
   * Mark every still-`running` run as `aborted`. A run is only ever in
   * flight inside one process; at boot nothing of ours is scanning, so any
   * `running` row is a crash or a kill left behind — an orphaned run and an
   * aborted run must look the same, not like a run that is still going.
   * Returns the number of runs recovered.
   */
  async recoverOrphanedRuns(): Promise<number> {
    const rows = await this.#sql`
        UPDATE runs SET status = 'aborted', finished_at = now()
        WHERE status = 'running' RETURNING id`;
    return rows.length;
  }

  /**
   * Whether the same regression was already detected within the cooldown
   * window, for webhook suppression. `beforeRunId` excludes the run that
   * just recorded it, so the alert fires for a fresh transition and stays
   * silent while the anchor stays broken.
   */
  async recentRegression(
    anchorId: string,
    checkId: string,
    cooldownSeconds: number,
    beforeRunId: string,
  ): Promise<boolean> {
    const rows = await this.#sql`
        SELECT 1 FROM regressions
        WHERE anchor_id = ${anchorId} AND check_id = ${checkId}
          AND run_id <> ${beforeRunId}
          AND detected_at >= now() - make_interval(secs => ${cooldownSeconds})
        LIMIT 1`;
    return rows.length > 0;
  }

  /** Assemble a full run row: grades, results, normalised timestamps. */
  async #runDetail(
    anchorId: string,
    homeDomain: string,
    network: string,
    run: Record<string, unknown>,
  ): Promise<RunDetailRow> {
    const runId = run.id as string;
    const [gradeRows, resultRows] = await Promise.all([
      this.#sql`
          SELECT sep, score, applicable FROM sep_grades
          WHERE run_id = ${runId} ORDER BY sep`,
      this.#sql`
          SELECT check_id, sep, status, severity, message, spec_ref, evidence, duration_ms
          FROM check_results WHERE run_id = ${runId} ORDER BY check_id`,
    ]);
    return {
      id: run.id as string,
      anchorId,
      homeDomain,
      network,
      startedAt: new Date(run.started_at as Date).toISOString(),
      finishedAt: run.finished_at === null ? null : new Date(run.finished_at as Date).toISOString(),
      status: run.status as string,
      overallScore: run.overall_score === null ? null : Number(run.overall_score),
      checksLibVersion: run.checks_lib_version as string,
      grades: gradeRows.map((row) => ({
        sep: row.sep,
        score: Number(row.score),
        applicable: row.applicable,
      })),
      results: resultRows.map((row) => ({
        checkId: row.check_id,
        sep: row.sep,
        status: row.status,
        severity: row.severity,
        message: row.message ?? "",
        specRef: row.spec_ref ?? "",
        evidence: row.evidence as unknown,
        durationMs: row.duration_ms,
      })),
    };
  }
}
