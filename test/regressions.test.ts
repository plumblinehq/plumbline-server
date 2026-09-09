import type { Result, Severity, Status } from "@plumblinehq/plumbline-checks";
import { describe, expect, it } from "vitest";
import { detectRegressions } from "../src/regressions.js";

function result(checkId: string, status: Status, severity: Severity = "error"): Result {
  return {
    checkId,
    sep: 1,
    title: checkId,
    status,
    severity,
    message: "message",
    specRef: "SEP-1 §Specification",
    evidence: [],
    durationMs: 1,
  };
}

describe("detectRegressions", () => {
  it("detects an error-severity check moving pass to fail", () => {
    const regressions = detectRegressions(
      [result("sep1.a", "pass")],
      [result("sep1.a", "fail")],
    );
    expect(regressions).toEqual([{ checkId: "sep1.a" }]);
  });

  it("ignores a check that was already failing", () => {
    const regressions = detectRegressions(
      [result("sep1.a", "fail")],
      [result("sep1.a", "fail")],
    );
    expect(regressions).toEqual([]);
  });

  it("ignores warnings and info", () => {
    const regressions = detectRegressions(
      [result("sep1.w", "pass", "warning"), result("sep1.i", "pass", "info")],
      [result("sep1.w", "fail", "warning"), result("sep1.i", "fail", "info")],
    );
    expect(regressions).toEqual([]);
  });

  it("ignores a new check failing with no previous pass", () => {
    const regressions = detectRegressions([], [result("sep1.a", "fail")]);
    expect(regressions).toEqual([]);
  });

  it("ignores checks that skipped in either run", () => {
    const regressions = detectRegressions(
      [result("sep1.a", "skip")],
      [result("sep1.a", "fail")],
    );
    expect(regressions).toEqual([]);
  });
});
