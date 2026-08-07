import { describe, it, expect } from "vitest";
import {
  METRIC_INFO,
  TIER1_INFO,
  ALERT_TYPE_INFO,
  metricInfo,
  metricPlainName,
  alertPlainName,
  describeMetric,
  describeTier1,
} from "./metricLabels";
import { BEHAVIORAL_METRICS } from "./metricReviewMeta";
import { TASK_METRIC_KEYS } from "./taskReport";

// The point of this module is that ONE wording reaches every surface. These
// tests guard the two ways that can quietly stop being true: a metric the UI
// renders that has no entry here, and wording that drifts into asserting
// misconduct rather than flagging for review (Constraint 7).

describe("coverage — every metric the UI renders has plain-language wording", () => {
  it("covers every behavioral metric that accepts a review judgment", () => {
    for (const key of BEHAVIORAL_METRICS) {
      expect(METRIC_INFO[key], `missing label for ${key}`).toBeTruthy();
    }
  });

  it("covers every column of the per-task report, plus the merged signal", () => {
    for (const key of [...TASK_METRIC_KEYS, "merged"]) {
      expect(METRIC_INFO[key], `missing label for ${key}`).toBeTruthy();
    }
  });

  it("covers all three Tier-1 alert types, keyed both ways", () => {
    expect(Object.keys(TIER1_INFO).sort()).toEqual([
      "astViolation",
      "illegalPaste",
      "tabOut",
    ]);
    expect(Object.keys(ALERT_TYPE_INFO).sort()).toEqual([
      "AST_VIOLATION",
      "ILLEGAL_PASTE",
      "TAB_OUT",
    ]);
  });
});

describe("shape — plain name, description and technical name are all present", () => {
  for (const [key, info] of Object.entries(METRIC_INFO)) {
    it(`${key} has a plain name, a short name, a description and a technical name`, () => {
      expect(info.plain.length).toBeGreaterThan(0);
      expect(info.short.length).toBeGreaterThan(0);
      // A description that does not describe is the failure this whole change
      // exists to fix, so it must be a sentence, not a word.
      expect(info.desc.length).toBeGreaterThan(40);
      expect(info.tech.length).toBeGreaterThan(0);
      // The technical name is kept, not replaced — that is the rigor half of
      // the requirement and the thing most likely to be "tidied away" later.
      expect(info.tech).not.toEqual(info.plain);
    });
  }
});

describe("framing — probabilistic, never accusatory (Constraint 7)", () => {
  const FORBIDDEN = /\b(cheat|cheated|cheating|proves?|proven|guarantee[ds]?|undeniabl)/i;
  const all = [...Object.values(METRIC_INFO), ...Object.values(TIER1_INFO)];

  for (const info of all) {
    it(`"${info.plain}" avoids asserting misconduct`, () => {
      expect(`${info.plain} ${info.desc}`).not.toMatch(FORBIDDEN);
    });
  }

  it("hedges the inference metrics rather than stating a conclusion", () => {
    for (const key of ["metricA", "metricB", "metricC"]) {
      expect(METRIC_INFO[key].desc).toMatch(/may indicate/i);
    }
    expect(METRIC_INFO.authorship.desc).toMatch(/flagged for review/i);
  });

  it("describes Tier-1 events as observations, since they are factual records", () => {
    // These are not inferences, so they must not borrow inference wording —
    // that distinction is what keeps review judgments off them.
    expect(TIER1_INFO.tabOut.desc).toMatch(/not by itself misconduct/i);
  });
});

describe("lookups", () => {
  it("returns the entry for a known metric and null otherwise", () => {
    expect(metricInfo("authorship")).toBe(METRIC_INFO.authorship);
    expect(metricInfo("nope")).toBeNull();
  });

  it("falls back to the raw key so an unknown metric still renders", () => {
    expect(metricPlainName("metricC")).toBe("Typing rhythm");
    expect(metricPlainName("metricZ")).toBe("metricZ");
    expect(alertPlainName("TAB_OUT")).toBe("Left the exam screen");
    expect(alertPlainName("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("describeMetric / describeTier1 — the shared tooltip", () => {
  it("carries the plain name, the description, this session's verdict and the technical name", () => {
    const out = describeMetric("metricC", "CV 0.09 — robotic rhythm (flagged for review)");
    expect(out).toContain("Typing rhythm");
    expect(out).toContain(METRIC_INFO.metricC.desc);
    expect(out).toContain("CV 0.09");
    expect(out).toContain(METRIC_INFO.metricC.tech);
  });

  it("omits the verdict line when there is no verdict", () => {
    const out = describeMetric("metricA");
    expect(out).toContain("Testing & iteration");
    expect(out).not.toContain("This session:");
  });

  it("degrades to the verdict alone for an unknown key", () => {
    expect(describeMetric("metricZ", "flagged")).toBe("flagged");
    expect(describeTier1("nope", "1 recorded")).toBe("1 recorded");
  });

  it("describes a Tier-1 counter the same way", () => {
    const out = describeTier1("illegalPaste", "2 recorded — flagged for review");
    expect(out).toContain("Pasted from outside");
    expect(out).toContain("2 recorded");
    expect(out).toContain("ILLEGAL_PASTE");
  });
});
