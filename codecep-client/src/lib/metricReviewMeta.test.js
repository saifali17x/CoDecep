import { describe, it, expect } from "vitest";
import {
  BEHAVIORAL_METRICS,
  isBehavioralMetric,
  judgmentIndex,
  judgmentKey,
  predictedFlagOfRow,
} from "./metricReviewMeta";

describe("which metrics offer a review control", () => {
  it("offers one for each behavioral metric", () => {
    expect(BEHAVIORAL_METRICS).toEqual(["metricA", "metricB", "metricC", "authorship"]);
    for (const m of BEHAVIORAL_METRICS) expect(isBehavioralMetric(m)).toBe(true);
  });

  it("offers NONE for factual records", () => {
    // Tab-outs, pastes and construct checks either happened or did not. An
    // instructor disagreeing with one is reporting a bug, not calibrating a
    // threshold — the server rejects these too.
    for (const m of ["astAudit", "TAB_OUT", "ILLEGAL_PASTE", "AST_VIOLATION", "merged", "tier1"]) {
      expect(isBehavioralMetric(m)).toBe(false);
    }
  });
});

describe("predictedFlagOfRow — what the metric SAID", () => {
  it("reads an explicit flag", () => {
    expect(predictedFlagOfRow({ authorship: { flag: true } }, "authorship")).toBe(true);
    expect(predictedFlagOfRow({ metricB: { flag: false } }, "metricB")).toBe(false);
  });

  it("derives Metric A from the run count when no boolean is stored", () => {
    // Matches the severity colouring: <= 1 run is the flagged case.
    expect(predictedFlagOfRow({ metricA: { runCount: 0 } }, "metricA")).toBe(true);
    expect(predictedFlagOfRow({ metricA: { runCount: 1 } }, "metricA")).toBe(true);
    expect(predictedFlagOfRow({ metricA: { runCount: 5 } }, "metricA")).toBe(false);
  });

  it("prefers Metric A's explicit flag over the derived one", () => {
    expect(predictedFlagOfRow({ metricA: { flag: false, runCount: 0 } }, "metricA")).toBe(false);
  });

  it("reports false rather than throwing on missing data", () => {
    expect(predictedFlagOfRow(null, "authorship")).toBe(false);
    expect(predictedFlagOfRow({}, "metricC")).toBe(false);
    expect(predictedFlagOfRow({ metricA: {} }, "metricA")).toBe(false);
  });
});

describe("judgment indexing", () => {
  it("keys a session-level judgment on the empty scope, matching storage", () => {
    expect(judgmentKey(null, "metricC")).toBe("::metricC");
    expect(judgmentKey("task2", "authorship")).toBe("task2::authorship");
  });

  it("indexes saved rows so each control renders where it was left", () => {
    const idx = judgmentIndex([
      { taskId: null, metric: "authorship", judgment: "accurate" },
      { taskId: "task2", metric: "metricC", judgment: "inaccurate" },
    ]);
    expect(idx[judgmentKey(null, "authorship")]).toBe("accurate");
    expect(idx[judgmentKey("task2", "metricC")]).toBe("inaccurate");
  });

  it("keeps one instructor's judgments per (task, metric) distinct", () => {
    // The same metric judged on two different tasks must not collide.
    const idx = judgmentIndex([
      { taskId: "task1", metric: "authorship", judgment: "accurate" },
      { taskId: "task2", metric: "authorship", judgment: "inaccurate" },
    ]);
    expect(idx["task1::authorship"]).toBe("accurate");
    expect(idx["task2::authorship"]).toBe("inaccurate");
  });

  it("handles an empty or missing list", () => {
    expect(judgmentIndex([])).toEqual({});
    expect(judgmentIndex(undefined)).toEqual({});
  });
});
