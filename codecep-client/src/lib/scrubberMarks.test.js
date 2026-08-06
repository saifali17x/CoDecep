import { describe, it, expect } from "vitest";
import { buildTickMarks, tickKindsPresent, TICK_KINDS } from "./scrubberMarks";
import { summariseViolationList, describeViolationList, nodeTypeFromDetail } from "./astReport";

// A timeline that opened at epoch 1000 and ran for 60s.
const START = 1000;
const DURATION = 60_000;

const base = { startTime: START, totalDurationMs: DURATION };

describe("buildTickMarks", () => {
  it("places paste ticks from the replay's own relative times", () => {
    const ticks = buildTickMarks({
      ...base,
      pasteMarks: [{ t: 30_000, charCount: 52, provenance: "external" }],
    });
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ kind: "paste", variant: "external", t: 30_000, pct: 50 });
    expect(ticks[0].title).toContain("+52 chars");
    expect(ticks[0].title).toContain("00:30");
  });

  it("distinguishes internal from external pastes", () => {
    const ticks = buildTickMarks({
      ...base,
      pasteMarks: [
        { t: 0, charCount: 10, provenance: "internal" },
        { t: 10, charCount: 10, provenance: "external" },
        { t: 20, charCount: 10 }, // unknown provenance defaults to external
      ],
    });
    expect(ticks.map((t) => t.variant)).toEqual(["internal", "external", "external"]);
  });

  it("converts ABSOLUTE tier-1 timestamps into timeline-relative positions", () => {
    // A tab-out 15s after the timeline origin sits at 25% of a 60s timeline.
    const ticks = buildTickMarks({
      ...base,
      tier1Events: [{ type: "TAB_OUT", timestamp: START + 15_000, detail: null }],
    });
    expect(ticks[0]).toMatchObject({ kind: "tabout", t: 15_000, pct: 25, persistent: true });
    expect(ticks[0].title).toContain("00:15");
    expect(ticks[0].title).toContain("left the exam screen");
  });

  it("marks tab-outs persistent and every other kind not", () => {
    const ticks = buildTickMarks({
      ...base,
      pasteMarks: [{ t: 1000, charCount: 5 }],
      tier1Events: [
        { type: "TAB_OUT", timestamp: START + 2000 },
        { type: "AST_VIOLATION", timestamp: START + 3000, detail: "Used for_statement (line 12) in main.cpp" },
      ],
    });
    const byKind = Object.fromEntries(ticks.map((t) => [t.kind, t.persistent]));
    expect(byKind).toEqual({ paste: false, tabout: true, ast: false });
    expect(TICK_KINDS.tabout.toggleable).toBe(true);
  });

  it("recovers the node type for an AST tick's tooltip", () => {
    const ticks = buildTickMarks({
      ...base,
      tier1Events: [
        { type: "AST_VIOLATION", timestamp: START + 6000, detail: "Used for_statement (line 12) in Task 1 / main.cpp" },
      ],
    });
    expect(ticks[0].nodeType).toBe("for_statement");
    expect(ticks[0].title).toContain("for_statement");
    expect(ticks[0].title).toContain("not permitted for this week");
  });

  it("falls back to the raw detail when the node type cannot be recovered", () => {
    const ticks = buildTickMarks({
      ...base,
      tier1Events: [{ type: "AST_VIOLATION", timestamp: START, detail: "something unparseable" }],
    });
    expect(ticks[0].nodeType).toBeNull();
    expect(ticks[0].title).toContain("something unparseable");
  });

  it("does NOT double-mark pastes from the tier-1 log", () => {
    // ILLEGAL_PASTE is already represented by the replay's pasteMarks.
    const ticks = buildTickMarks({
      ...base,
      pasteMarks: [{ t: 5000, charCount: 80, provenance: "external" }],
      tier1Events: [{ type: "ILLEGAL_PASTE", timestamp: START + 5000 }],
    });
    expect(ticks).toHaveLength(1);
    expect(ticks[0].kind).toBe("paste");
  });

  it("clamps events outside the keystroke window instead of dropping them", () => {
    // A tab-out before the first keystroke and one after the last still
    // happened — hiding them would be the wrong kind of tidy.
    const ticks = buildTickMarks({
      ...base,
      tier1Events: [
        { type: "TAB_OUT", timestamp: START - 99_000 },
        { type: "TAB_OUT", timestamp: START + DURATION + 99_000 },
      ],
    });
    expect(ticks.map((t) => t.t)).toEqual([0, DURATION]);
    expect(ticks.map((t) => t.pct)).toEqual([0, 100]);
  });

  it("returns nothing for a zero-length timeline rather than dividing by zero", () => {
    const ticks = buildTickMarks({
      startTime: START,
      totalDurationMs: 0,
      pasteMarks: [{ t: 0, charCount: 10 }],
      tier1Events: [{ type: "TAB_OUT", timestamp: START }],
    });
    expect(ticks).toEqual([]);
  });

  it("treats a NULL tier-1 log as 'not recorded' — no ticks, no crash", () => {
    const ticks = buildTickMarks({ ...base, pasteMarks: [{ t: 1, charCount: 1 }], tier1Events: null });
    expect(ticks.every((t) => t.kind === "paste")).toBe(true);
  });

  it("ignores malformed entries without discarding the good ones", () => {
    const ticks = buildTickMarks({
      ...base,
      pasteMarks: [null, { t: "nope" }, { t: 1000, charCount: 3 }],
      tier1Events: [{ type: "TAB_OUT" }, { timestamp: START + 1 }, { type: "TAB_OUT", timestamp: START + 2000 }],
    });
    expect(ticks).toHaveLength(2);
  });

  it("sorts every tick by time regardless of source", () => {
    const ticks = buildTickMarks({
      ...base,
      pasteMarks: [{ t: 40_000, charCount: 1 }, { t: 5000, charCount: 1 }],
      tier1Events: [
        { type: "TAB_OUT", timestamp: START + 20_000 },
        { type: "AST_VIOLATION", timestamp: START + 1000, detail: "Used for_statement (line 3)" },
      ],
    });
    expect(ticks.map((t) => t.t)).toEqual([1000, 5000, 20_000, 40_000]);
  });
});

describe("tickKindsPresent", () => {
  it("offers a legend entry only for kinds actually on the timeline", () => {
    const ticks = buildTickMarks({
      ...base,
      pasteMarks: [{ t: 1000, charCount: 1 }],
      tier1Events: [{ type: "TAB_OUT", timestamp: START + 2000 }],
    });
    expect(tickKindsPresent(ticks).map((k) => k.key)).toEqual(["paste", "tabout"]);
  });

  it("returns nothing for an empty timeline", () => {
    expect(tickKindsPresent([])).toEqual([]);
    expect(tickKindsPresent(null)).toEqual([]);
  });
});

describe("astReport", () => {
  it("de-duplicates findings by construct + line but keeps the raw total", () => {
    const s = summariseViolationList([
      { nodeType: "for_statement", line: 12 },
      { nodeType: "for_statement", line: 12 },
      { nodeType: "while_statement", line: 15 },
    ]);
    expect(s.distinct).toBe(2);
    expect(s.total).toBe(3);
  });

  it("describes findings as construct + line", () => {
    expect(
      describeViolationList([
        { nodeType: "for_statement", line: 12 },
        { nodeType: "while_statement", line: 15 },
      ]),
    ).toBe("for_statement (line 12), while_statement (line 15)");
  });

  it("caps the list and counts the remainder", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ nodeType: "for_statement", line: i + 1 }));
    expect(describeViolationList(many)).toContain("and 4 more");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(describeViolationList([])).toBe("no disallowed constructs");
    expect(describeViolationList(null)).toBe("no disallowed constructs");
  });

  it("reads the node type back out of both alert detail formats", () => {
    expect(nodeTypeFromDetail("Used for_statement (line 12) in main.cpp")).toEqual({
      nodeType: "for_statement",
      line: 12,
    });
    // Pre-Fix-2 wording, so old sessions still get a useful tooltip.
    expect(nodeTypeFromDetail("6 violation(s) in main.cpp: while_statement")).toEqual({
      nodeType: "while_statement",
      line: null,
    });
    expect(nodeTypeFromDetail("nonsense")).toBeNull();
    expect(nodeTypeFromDetail(null)).toBeNull();
  });
});
