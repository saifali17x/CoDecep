import { describe, it, expect } from "vitest";
import {
  formatTypedRatio,
  typedRatioPercent,
  isTypedRatioClamped,
  authorshipSeverity,
  TYPED_RATIO_DISPLAY_MAX,
} from "./metricColors";

// The DISPLAY cap on the typed share. `typedRatio` is typed characters over
// final program length, so it exceeds 1.0 honestly — auto-closed brackets the
// student overtypes, and re-typing or heavily editing a section, author more
// characters than survive in the submitted file. "103% typed" is arithmetically
// correct and reads as a bug.
//
// The cap is DISPLAY ONLY: the stored ratio and the flag are untouched, and the
// metric only ever flags a share that is too LOW, so clamping the top end can
// never change a verdict in either direction.

describe("typed-ratio display cap", () => {
  it("shows an ordinary ratio unchanged", () => {
    expect(formatTypedRatio(0.19)).toBe("19% typed");
    expect(formatTypedRatio(0.875)).toBe("88% typed");
    expect(typedRatioPercent(0.5)).toBe(50);
  });

  it("caps a ratio above 1.0 at 100%, never 103%", () => {
    expect(formatTypedRatio(1.03)).toBe("100% typed");
    expect(formatTypedRatio(2.5)).toBe("100% typed");
    expect(typedRatioPercent(1.02)).toBe(100);
  });

  it("shows exactly 100% for exactly 1.0, without calling it clamped", () => {
    expect(formatTypedRatio(TYPED_RATIO_DISPLAY_MAX)).toBe("100% typed");
    expect(isTypedRatioClamped(1)).toBe(false);
    expect(isTypedRatioClamped(1.0001)).toBe(true);
  });

  it("never shows a negative share", () => {
    expect(formatTypedRatio(-0.2)).toBe("0% typed");
  });

  it("returns null when there is no usable number, so callers can fall back", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "0.5"]) {
      expect(formatTypedRatio(v)).toBeNull();
      expect(typedRatioPercent(v)).toBeNull();
    }
  });
});

describe("authorshipSeverity — verdict is unchanged by the cap", () => {
  it("a clamped ratio still reads as a pass, and explains the cap", () => {
    const sev = authorshipSeverity(false, 1.03);
    expect(sev.level).toBe("green");
    expect(sev.label).toContain("100% typed");
    expect(sev.label).not.toContain("103");
    expect(sev.label).toContain("capped at 100%");
  });

  it("an ordinary pass carries no clamp note", () => {
    const sev = authorshipSeverity(false, 0.9);
    expect(sev.level).toBe("green");
    expect(sev.label).toBe("90% typed — no flag");
  });

  it("a flagged low share is untouched and still reads as flagged for review", () => {
    const sev = authorshipSeverity(true, 0);
    expect(sev.level).toBe("red");
    expect(sev.label).toContain("0% typed");
    expect(sev.label).toContain("flagged for review");
    // Constraint 7: a signal for a human, never an accusation.
    expect(sev.label).not.toMatch(/cheat|proves|guarantee/i);
  });

  it("still reports insufficient data when there is no ratio and no flag", () => {
    expect(authorshipSeverity(null, null).level).toBe("grey");
    expect(authorshipSeverity(null, null).label).toContain("insufficient data");
  });
});
