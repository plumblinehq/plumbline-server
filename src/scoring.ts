import type { Result } from "@plumblinehq/plumbline-checks";

/**
 * Per-SEP and overall scores, per plumbline-architecture.md §5.3:
 *
 *   sep_score = passed_error_checks / applicable_error_checks
 *
 * Warnings and info do not affect the score; they surface in the UI as notes.
 * `skip` results are excluded from the denominator. An anchor that does not
 * declare TRANSFER_SERVER_SEP0024 is not penalised for failing SEP-24 — that
 * SEP is simply not applicable, and every one of its checks skips. A scoring
 * function that punishes anchors for not implementing optional SEPs is wrong.
 */
export interface SepGrade {
  sep: number;
  score: number;
  applicable: boolean;
}

export interface Scores {
  overall: number;
  grades: SepGrade[];
}

export function scoreRun(results: Result[]): Scores {
  const bySep = new Map<number, { passed: number; applicable: number }>();
  for (const result of results) {
    if (result.severity !== "error") {
      continue;
    }
    let bucket = bySep.get(result.sep);
    if (bucket === undefined) {
      bucket = { passed: 0, applicable: 0 };
      bySep.set(result.sep, bucket);
    }
    if (result.status === "fail") {
      bucket.applicable += 1;
    } else if (result.status === "pass") {
      bucket.applicable += 1;
      bucket.passed += 1;
    }
    // `skip` and Plumbline's own `error` never enter the denominator: a skip
    // means not applicable (or a prerequisite failed, which the prerequisite's
    // own failure already covers), and an `error` is our failure, not the
    // anchor's.
  }

  const grades: SepGrade[] = [...bySep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sep, bucket]) => ({
      sep,
      score: bucket.applicable === 0 ? 0 : bucket.passed / bucket.applicable,
      applicable: bucket.applicable > 0,
    }));

  const applicableGrades = grades.filter((g) => g.applicable);
  const overall =
    applicableGrades.length === 0
      ? 0
      : applicableGrades.reduce((sum, g) => sum + g.score, 0) / applicableGrades.length;

  return { overall, grades };
}
