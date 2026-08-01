import { describe, it, expect } from "vitest";
import { buildReplay, diffTexts, FALLBACK_LEAD_IN_MS } from "./replayEngine";

// Helper: build a flush-window snapshot entry.
const snap = (flushedAt: number, codeSnapshot: string, eventCount: number) => ({
  flushedAt,
  codeSnapshot,
  eventCount,
});
const ev = (
  timestamp: number,
  actionType: string,
  charDelta: number,
  extra: Record<string, unknown> = {},
) => ({
  timestamp,
  timeSinceLastKeystrokeMs: 100,
  actionType,
  charDelta,
  textLength: 0,
  ...extra,
});

describe("diffTexts", () => {
  it("expresses a change as prefix + inserted/removed + suffix", () => {
    const d = diffTexts("hello world", "hello brave world");
    expect(d.prefix + d.inserted + d.suffix).toBe("hello brave world");
    expect(d.prefix + d.removed + d.suffix).toBe("hello world");
  });
});

describe("buildReplay — endpoints", () => {
  it("textAt before start is the initial text; textAt(end) is the final snapshot", () => {
    const target = "int a = 1;";
    const events = [1000, 2000, 3000, 4000, 5000].map((t) => ev(t, "type", 2));
    const r = buildReplay(
      { snapshots: [snap(6000, target, 5)], events, startedAt: 1000, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.textAt(-1)).toBe("");
    // Session 22: the timeline starts when the exam was OPENED, so there is a
    // real window before the first keystroke where the document is still empty.
    expect(r.textAt(0)).toBe("");
    expect(r.textAt(999)).toBe("");
    expect(r.textAt(r.totalDurationMs)).toBe(target);
    expect(r.textAt(r.totalDurationMs + 99999)).toBe(target);
  });

  it("empty session (no events) is graceful", () => {
    const r = buildReplay({ snapshots: [], events: [] }, { initialText: "x" });
    expect(r.totalDurationMs).toBe(0);
    expect(r.textAt(0)).toBe("x");
    expect(r.pasteMarks).toEqual([]);
  });
});

describe("buildReplay — paste detection", () => {
  it("reports a paste mark at the right time and the chunk appears at once", () => {
    // 2 typed chars, then a 30-char paste, then 2 more typed chars → 34 chars.
    const target = "x".repeat(34);
    const events = [
      ev(1000, "type", 2),
      ev(2000, "paste", 30, { provenance: "external" }),
      ev(3000, "type", 2),
    ];
    const r = buildReplay(
      { snapshots: [snap(4000, target, 3)], events, startedAt: 1000, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.pasteMarks).toHaveLength(1);
    const mark = r.pasteMarks[0];
    expect(mark.t).toBe(2000); // relative to openedAt, not to the first event
    expect(mark.charCount).toBe(30);
    expect(mark.provenance).toBe("external");
    // The paste is DISCRETE: text length jumps by ~30 in one frame.
    const before = r.textAt(mark.t - 1).length;
    const after = r.textAt(mark.t).length;
    expect(after - before).toBeGreaterThanOrEqual(29);
    // The mark's range matches the jump.
    expect(mark.rangeEnd - mark.rangeStart).toBe(after - before);
  });

  it("small paste-classified events below the threshold get no mark", () => {
    const events = [ev(1000, "type", 2), ev(2000, "paste", 6)];
    const r = buildReplay(
      { snapshots: [snap(3000, "abcdefgh", 2)], events, startedAt: 1000, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.pasteMarks).toHaveLength(0);
  });
});

// ── Session 22 (part 2): a pasted-everything session must be WATCHABLE ─────
// Root cause this guards: the timeline used to start at the first keystroke,
// so a first-event paste was already on screen at t=0 (never seen arriving),
// and when it was the ONLY event totalDurationMs was 0 and the player showed
// its "no keystroke activity" empty state instead of the replay.
describe("buildReplay — first-event paste visibility", () => {
  const program = "int main() { return 0; }";

  it("gives a paste-everything session a real timeline instead of duration 0", () => {
    const events = [ev(10_000, "paste", program.length, { provenance: "external" })];
    const r = buildReplay(
      { snapshots: [snap(30_000, program, 1)], events, openedAt: 3_000 },
      { initialText: "" },
    );
    expect(r.totalDurationMs).toBe(7_000); // 10s first event − 3s opened
    expect(r.pasteMarks).toHaveLength(1);
  });

  it("opens on an empty document and shows the pasted block arriving", () => {
    const events = [ev(10_000, "paste", program.length, { provenance: "external" })];
    const r = buildReplay(
      { snapshots: [snap(30_000, program, 1)], events, openedAt: 3_000 },
      { initialText: "" },
    );
    const mark = r.pasteMarks[0];
    // Empty right up to the paste moment, whole program immediately after.
    expect(r.textAt(0)).toBe("");
    expect(r.textAt(mark.t - 1)).toBe("");
    expect(r.textAt(mark.t)).toBe(program);
    // ...and the highlighted range covers what arrived.
    expect(mark.rangeStart).toBe(0);
    expect(mark.rangeEnd).toBe(program.length);
  });

  it("treats a long lead-in as a skippable idle gap", () => {
    const events = [ev(60_000, "paste", program.length, { provenance: "external" })];
    const r = buildReplay(
      { snapshots: [snap(70_000, program, 1)], events, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ start: 0, end: 60_000 });
  });

  it("falls back to a synthetic lead-in when openedAt is missing or unusable", () => {
    const events = [ev(10_000, "paste", program.length, { provenance: "external" })];
    const noOpenedAt = buildReplay(
      { snapshots: [snap(30_000, program, 1)], events },
      { initialText: "" },
    );
    expect(noOpenedAt.totalDurationMs).toBe(FALLBACK_LEAD_IN_MS);
    expect(noOpenedAt.textAt(0)).toBe("");
    // Clock skew: openedAt after the first event is ignored, not trusted.
    const skewed = buildReplay(
      { snapshots: [snap(30_000, program, 1)], events, openedAt: 20_000 },
      { initialText: "" },
    );
    expect(skewed.totalDurationMs).toBe(FALLBACK_LEAD_IN_MS);
  });
});

describe("buildReplay — idle gaps", () => {
  it("flags a large inter-keystroke gap", () => {
    const events = [
      ev(1000, "type", 3),
      ev(61000, "type", 3, { timeSinceLastKeystrokeMs: 60000 }),
    ];
    const r = buildReplay(
      { snapshots: [snap(62000, "abcdef", 2)], events, startedAt: 1000, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].durationMs).toBe(60000);
  });
});

describe("buildReplay — deletions", () => {
  it("text shrinks where delete events occur", () => {
    const events = [ev(1000, "delete", -3), ev(2000, "delete", -3)];
    const r = buildReplay(
      { snapshots: [snap(3000, "hello", 2)], events, startedAt: 1000, openedAt: 0 },
      { initialText: "hello world" },
    );
    expect(r.textAt(-1)).toBe("hello world");
    expect(r.textAt(0)).toBe("hello world"); // before the first delete
    expect(r.textAt(1000)).toBe("hello wo"); // 3 of the 6 changed chars removed
    expect(r.textAt(r.totalDurationMs)).toBe("hello");
  });
});

describe("buildReplay — monotonic across snapshot boundaries", () => {
  it("is exact at each snapshot boundary and stable as T increases", () => {
    const s1 = "int main() {}";
    const s2 = "int main() {\n  return 0;\n}";
    const events = [
      ...[1000, 2000, 3000].map((t) => ev(t, "type", Math.ceil(s1.length / 3))),
      ...[31000, 32000, 33000].map((t) => ev(t, "type", 5)),
    ];
    const r = buildReplay(
      { snapshots: [snap(30000, s1, 3), snap(60000, s2, 3)], events, startedAt: 1000, openedAt: 0 },
      { initialText: "" },
    );
    // Exact at the first snapshot boundary (last frame of window 1):
    expect(r.textAt(3000)).toBe(s1); // rel t of 3rd event = 3000-0
    // Exact at the end:
    expect(r.textAt(r.totalDurationMs)).toBe(s2);
    // Stable/consistent: same T twice gives the same text; text at increasing
    // T never regresses to an earlier segment's partial state.
    let prevLen = -1;
    for (let t = 0; t <= r.totalDurationMs; t += 500) {
      const a = r.textAt(t);
      expect(r.textAt(t)).toBe(a);
      expect(a.length).toBeGreaterThanOrEqual(prevLen >= 0 ? Math.min(prevLen, s1.length) : -1);
      prevLen = a.length;
    }
  });
});
