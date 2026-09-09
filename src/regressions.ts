import type { Result } from "@plumblinehq/plumbline-checks";

/**
 * Regression detection, per plumbline-architecture.md §6.3: a regression is
 * an `error`-severity check that moved pass → fail between consecutive
 * complete runs of the same anchor. Warnings and info deliberately do not
 * alert, and an anchor's first-ever run can contain no regression because it
 * has no previous run to regress from.
 */
export interface Regression {
  checkId: string;
}

export function detectRegressions(previous: Result[], current: Result[]): Regression[] {
  const previousStatus = new Map(previous.map((r) => [r.checkId, r.status]));
  const regressions: Regression[] = [];
  for (const result of current) {
    if (result.severity !== "error" || result.status !== "fail") {
      continue;
    }
    if (previousStatus.get(result.checkId) === "pass") {
      regressions.push({ checkId: result.checkId });
    }
  }
  return regressions;
}
