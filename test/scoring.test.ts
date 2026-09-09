import type { Result, Severity, Status } from "@plumblinehq/plumbline-checks";
import { describe, expect, it } from "vitest";
import { scoreRun } from "../src/scoring.js";

function result(checkId: string, sep: number, status: Status, severity: Severity): Result {
  return {
    checkId,
    sep,
    title: checkId,
    status,
    severity,
    message: "message",
    specRef: "SEP-1 §Specification",
    evidence: [],
    durationMs: 1,
  };
}

describe("scoreRun", () => {
  it("scores a SEP as passed over applicable error checks", () => {
    const scores = scoreRun([
      result("sep1.a", 1, "pass", "error"),
      result("sep1.b", 1, "pass", "error"),
      result("sep1.c", 1, "fail", "error"),
    ]);
    expect(scores.grades).toEqual([{ sep: 1, score: 2 / 3, applicable: true }]);
    expect(scores.overall).toBeCloseTo(2 / 3);
  });

  it("counts warnings and info in neither the numerator nor the denominator", () => {
    const scores = scoreRun([
      result("sep1.a", 1, "fail", "warning"),
      result("sep1.b", 1, "pass", "info"),
    ]);
    // No error-severity checks exist, so nothing is applicable and the SEP
    // contributes no grade at all.
    expect(scores.grades).toEqual([]);
    expect(scores.overall).toBe(0);
  });

  it("excludes skips from the denominator", () => {
    const scores = scoreRun([
      result("sep1.a", 1, "pass", "error"),
      result("sep1.b", 1, "skip", "error"),
    ]);
    expect(scores.grades).toEqual([{ sep: 1, score: 1, applicable: true }]);
  });

  it("excludes Plumbline's own errors from the score", () => {
    const scores = scoreRun([result("sep1.a", 1, "error", "error")]);
    expect(scores.grades).toEqual([{ sep: 1, score: 0, applicable: false }]);
  });

  it("leaves SEPs with no applicable checks out of the overall score", () => {
    const scores = scoreRun([
      result("sep1.a", 1, "pass", "error"),
      result("sep10.a", 10, "skip", "error"),
    ]);
    expect(scores.grades).toEqual([
      { sep: 1, score: 1, applicable: true },
      { sep: 10, score: 0, applicable: false },
    ]);
    expect(scores.overall).toBe(1);
  });

  it("averages per-SEP scores for the overall score", () => {
    const scores = scoreRun([
      result("sep1.a", 1, "pass", "error"),
      result("sep1.b", 1, "fail", "error"),
      result("sep10.a", 10, "pass", "error"),
    ]);
    expect(scores.overall).toBeCloseTo(0.75);
  });

  it("returns zero overall when nothing is applicable", () => {
    const scores = scoreRun([result("sep1.a", 1, "skip", "error")]);
    expect(scores.overall).toBe(0);
  });
});
