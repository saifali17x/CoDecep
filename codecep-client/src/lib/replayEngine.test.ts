import { describe, it, expect } from "vitest";
import {
  buildReplay,
  diffTexts,
  FALLBACK_LEAD_IN_MS,
  replayDataForTask,
  taskIdsInReplay,
} from "./replayEngine";

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

// ── Telemetry Capture v2 (Session 24) — exact, per-file reconstruction ───────
// These build sessions the way the v2 capture engine actually records them:
// every event carries the precise edit (rangeOffset / rangeLength /
// insertedText) plus the file it happened in, and every flush carries the whole
// workspace rather than one active buffer.

/** An exact-capture event. `o`/`d`/`t` mirror Monaco's change shape. */
const xev = (
  timestamp: number,
  fileName: string,
  o: number,
  d: number,
  t: string,
  extra: Record<string, unknown> = {},
) => ({
  timestamp,
  timeSinceLastKeystrokeMs: 100,
  actionType: d > t.length ? "delete" : "type",
  charDelta: t.length - d,
  textLength: 0,
  fileName,
  rangeOffset: o,
  rangeLength: d,
  insertedText: t,
  ...extra,
});

/** A flush carrying the whole workspace. */
const xsnap = (
  flushedAt: number,
  fileSnapshots: Record<string, string>,
  eventCount: number,
  active = Object.keys(fileSnapshots)[0],
) => ({
  flushedAt,
  codeSnapshot: fileSnapshots[active] ?? "",
  fileSnapshots,
  eventCount,
});

/** Type a string one character at a time into `file`, starting at `startOffset`. */
function typeOut(file: string, text: string, startTs: number, startOffset = 0) {
  return [...text].map((ch, i) => xev(startTs + i * 100, file, startOffset + i, 0, ch));
}

describe("buildReplay — exact capture (v2)", () => {
  it("reconstructs the final text byte-for-byte and reports exact:true", () => {
    const target = "int main() { return 0; }";
    const events = typeOut("main.cpp", target, 1000);
    const r = buildReplay(
      {
        snapshots: [xsnap(9000, { "main.cpp": target }, events.length)],
        events,
        openedAt: 0,
      },
      { initialText: "" },
    );
    expect(r.exact).toBe(true);
    expect(r.textAt(r.totalDurationMs)).toBe(target);
    // ...and every intermediate state is the real prefix, not an interpolation.
    expect(r.stateAt(r.frames[3].t).text).toBe(target.slice(0, 4));
    expect(r.stateAt(r.frames[10].t).text).toBe(target.slice(0, 11));
  });

  it("replays deletions exactly", () => {
    const events = [
      ...typeOut("main.cpp", "int xy = 1;", 1000),
      // backspace the 'y' (offset 5, one char removed)
      xev(2000, "main.cpp", 5, 1, ""),
    ];
    const final = "int x = 1;";
    const r = buildReplay(
      { snapshots: [xsnap(9000, { "main.cpp": final }, events.length)], events, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.exact).toBe(true);
    expect(r.textAt(r.totalDurationMs)).toBe(final);
  });

  it("tracks WHICH file is active over time and keeps each file's text separate", () => {
    const a = typeOut("main.cpp", "int main(){}", 1000);
    const b = typeOut("Student.h", "class S{};", 5000);
    const c = typeOut("main.cpp", "//x", 9000, 12);
    const events = [...a, ...b, ...c];
    const files = { "main.cpp": "int main(){}//x", "Student.h": "class S{};" };
    const r = buildReplay(
      { snapshots: [xsnap(20000, files, events.length)], events, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.exact).toBe(true);
    expect(r.files.sort()).toEqual(["Student.h", "main.cpp"]);

    // During the first burst the active file is main.cpp...
    expect(r.stateAt(r.frames[2].t).fileName).toBe("main.cpp");
    // ...during the second it is Student.h, and main.cpp's text is NOT shown.
    const mid = r.stateAt(r.frames[a.length + 3].t);
    expect(mid.fileName).toBe("Student.h");
    expect(mid.text).toBe("class S{}".slice(0, 4));
    // ...and the switch back is reflected again.
    expect(r.stateAt(r.frames[a.length + b.length + 1].t).fileName).toBe("main.cpp");
    // Final state of each file is exact.
    expect(r.finalFiles.get("main.cpp")).toBe(files["main.cpp"]);
    expect(r.finalFiles.get("Student.h")).toBe(files["Student.h"]);
  });

  it("reconstructs exactly across a flush boundary", () => {
    const first = typeOut("main.cpp", "int a=1;", 1000);
    const second = typeOut("main.cpp", "int b=2;", 5000, 8);
    const events = [...first, ...second];
    const r = buildReplay(
      {
        snapshots: [
          xsnap(4000, { "main.cpp": "int a=1;" }, first.length),
          xsnap(9000, { "main.cpp": "int a=1;int b=2;" }, second.length),
        ],
        events,
        openedAt: 0,
      },
      { initialText: "" },
    );
    expect(r.exact).toBe(true);
    expect(r.stateAt(r.frames[first.length - 1].t).text).toBe("int a=1;");
    expect(r.textAt(r.totalDurationMs)).toBe("int a=1;int b=2;");
  });

  it("carries the paste's REAL range and file, not an interpolated one", () => {
    const typed = typeOut("main.cpp", "int main(){", 1000);
    const blob = "\n    // pasted block that is comfortably over the mark threshold\n";
    const paste = xev(5000, "main.cpp", 11, 0, blob, {
      actionType: "paste",
      charDelta: blob.length,
      provenance: "external",
    });
    const events = [...typed, paste];
    const final = "int main(){" + blob;
    const r = buildReplay(
      { snapshots: [xsnap(9000, { "main.cpp": final }, events.length)], events, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.pasteMarks).toHaveLength(1);
    const [m] = r.pasteMarks;
    expect(m.fileName).toBe("main.cpp");
    expect(m.rangeStart).toBe(11);
    expect(m.rangeEnd).toBe(11 + blob.length);
    expect(m.provenance).toBe("external");
    // The pasted block is present all at once at its moment.
    expect(r.stateAt(m.t).text).toBe(final);
  });

  it("does not claim exactness when the edits disagree with the snapshot", () => {
    // A snapshot that the recorded edits cannot produce: the replay must heal
    // from the recorded truth and SAY it is not exact, never show a fiction.
    const events = typeOut("main.cpp", "abc", 1000);
    const r = buildReplay(
      {
        snapshots: [xsnap(9000, { "main.cpp": "totally different" }, events.length)],
        events,
        openedAt: 0,
      },
      { initialText: "" },
    );
    expect(r.exact).toBe(false);
    expect(r.inexactWindowCount).toBe(1);
    expect(r.textAt(r.totalDurationMs)).toBe("totally different");
  });

  it("falls back to the legacy engine when any event lacks exact data", () => {
    const events = [
      ...typeOut("main.cpp", "int a", 1000),
      ev(5000, "type", 3), // pre-v2 event: no rangeOffset/insertedText
    ];
    const r = buildReplay(
      { snapshots: [xsnap(9000, { "main.cpp": "int a=1;" }, events.length)], events, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.exact).toBe(false);
    expect(r.files).toEqual(["main.cpp"]);
    // Legacy path still anchors the endpoint on the snapshot.
    expect(r.textAt(r.totalDurationMs)).toBe("int a=1;");
  });

  it("exposes stateAt on legacy sessions too, so callers need no branch", () => {
    const events = [1000, 2000].map((t) => ev(t, "type", 2));
    const r = buildReplay(
      { snapshots: [snap(6000, "ab", 2)], events, openedAt: 0 },
      { initialText: "" },
    );
    expect(r.exact).toBe(false);
    expect(r.stateAt(r.totalDurationMs)).toEqual({ fileName: "main.cpp", text: "ab" });
  });
});

// ── Multi-task exams (Prompt 1) ─────────────────────────────────────────────
// Two tasks each own a main.cpp. The danger is that the replay treats them as
// ONE file — Task 2's edits would be applied to Task 1's text, producing a
// buffer that never existed. These pin the separation, and pin that a
// single-task session is not touched by any of it.
describe("buildReplay — multi-task sessions", () => {
  /** A flush carrying EVERY task's workspace. */
  const tsnap = (
    flushedAt: number,
    taskSnapshots: Record<string, Record<string, string>>,
    eventCount: number,
  ) => ({ flushedAt, codeSnapshot: "", fileSnapshots: null, taskSnapshots, eventCount });

  function typeInto(task: string, file: string, text: string, startTs: number) {
    return [...text].map((ch, i) =>
      xev(startTs + i * 100, file, i, 0, ch, { taskId: task }),
    );
  }

  it("keeps two tasks' main.cpp separate and stays exact", () => {
    const t1 = typeInto("task1", "main.cpp", "int a;", 1000);
    const t2 = typeInto("task2", "main.cpp", "double b;", 5000);
    const events = [...t1, ...t2];
    const r = buildReplay(
      {
        snapshots: [
          tsnap(
            30000,
            { task1: { "main.cpp": "int a;" }, task2: { "main.cpp": "double b;" } },
            events.length,
          ),
        ],
        events,
        openedAt: 0,
      },
      { initialText: "" },
    );
    // Qualified identity: neither task's program leaks into the other.
    expect(r.exact).toBe(true);
    expect(r.files).toEqual(["task1/main.cpp", "task2/main.cpp"]);
    expect(r.stateAt(r.totalDurationMs)).toEqual({
      fileName: "task2/main.cpp",
      text: "double b;",
    });
  });

  it("shows the student mid-way through Task 1, before Task 2 was opened", () => {
    const t1 = typeInto("task1", "main.cpp", "int a;", 1000);
    const t2 = typeInto("task2", "main.cpp", "double b;", 5000);
    const events = [...t1, ...t2];
    const r = buildReplay(
      {
        snapshots: [
          tsnap(
            30000,
            { task1: { "main.cpp": "int a;" }, task2: { "main.cpp": "double b;" } },
            events.length,
          ),
        ],
        events,
        openedAt: 0,
      },
      { initialText: "" },
    );
    // t=1300 is the 4th keystroke of Task 1 — "int " so far, Task 2 untouched.
    const state = r.stateAt(1300);
    expect(state.fileName).toBe("task1/main.cpp");
    expect(state.text).toBe("int ");
  });

  it("refuses to claim exactness for a multi-task window it cannot verify", () => {
    const events = typeInto("task1", "main.cpp", "int a;", 1000).concat(
      typeInto("task2", "main.cpp", "x", 5000),
    );
    const r = buildReplay(
      {
        // No taskSnapshots on the window: nothing to check the reconstruction
        // against, so the replay must say so rather than assume it is right.
        snapshots: [xsnap(30000, { "main.cpp": "int a;" }, events.length)],
        events,
        openedAt: 0,
      },
      { initialText: "" },
    );
    expect(r.exact).toBe(false);
  });

  it("leaves a single-task v2 session completely unqualified", () => {
    // Every event carries taskId 'task1' — one task, so nothing is renamed and
    // the session replays exactly as a pre-multi-task one does.
    const events = typeInto("task1", "main.cpp", "int a;", 1000);
    const r = buildReplay(
      {
        snapshots: [
          tsnap(30000, { task1: { "main.cpp": "int a;" } }, events.length),
        ],
        events,
        openedAt: 0,
      },
      { initialText: "" },
    );
    expect(r.files).toEqual(["main.cpp"]);
    expect(r.exact).toBe(true);
    expect(r.stateAt(r.totalDurationMs)).toEqual({ fileName: "main.cpp", text: "int a;" });
  });
});

// ── Per-task replay selection (Prompt 2) ────────────────────────────────────
// The instructor picks WHICH task to watch. Narrowing the payload and re-using
// the same engine is what keeps per-task replay exact: the reconstruction is
// still verified against that task's own recorded snapshots.
describe("replayDataForTask", () => {
  const tsnap = (
    flushedAt: number,
    taskSnapshots: Record<string, Record<string, string>>,
    eventCount: number,
  ) => ({ flushedAt, codeSnapshot: "", fileSnapshots: null, taskSnapshots, eventCount });

  function typeInto(task: string, file: string, text: string, startTs: number) {
    return [...text].map((ch, i) => xev(startTs + i * 100, file, i, 0, ch, { taskId: task }));
  }

  const t1 = typeInto("task1", "main.cpp", "int a;", 1000);
  const t2 = typeInto("task2", "main.cpp", "double b;", 60000);
  const session = {
    snapshots: [
      tsnap(
        90000,
        { task1: { "main.cpp": "int a;" }, task2: { "main.cpp": "double b;" } },
        t1.length + t2.length,
      ),
    ],
    events: [...t1, ...t2],
    openedAt: 0,
  };

  it("lists every task present, in exam order", () => {
    expect(taskIdsInReplay(session)).toEqual(["task1", "task2"]);
    expect(taskIdsInReplay({ snapshots: [], events: [] })).toEqual(["task1"]);
  });

  it("replays ONE task exactly, with the other task's edits absent", () => {
    const only2 = buildReplay(replayDataForTask(session, "task2"), { initialText: "" });
    expect(only2.exact).toBe(true);
    // Unqualified: a one-task view is not a multi-task payload.
    expect(only2.files).toEqual(["main.cpp"]);
    expect(only2.eventCount).toBe(t2.length);
    expect(only2.stateAt(only2.totalDurationMs)).toEqual({
      fileName: "main.cpp",
      text: "double b;",
    });

    const only1 = buildReplay(replayDataForTask(session, "task1"), { initialText: "" });
    expect(only1.exact).toBe(true);
    expect(only1.finalText).toBe("int a;");
  });

  it("recomputes each window's eventCount so windows still partition correctly", () => {
    const narrowed = replayDataForTask(session, "task1");
    expect(narrowed.snapshots[0].eventCount).toBe(t1.length);
    expect(narrowed.events).toHaveLength(t1.length);
    expect(narrowed.snapshots[0].taskSnapshots).toEqual({ task1: { "main.cpp": "int a;" } });
  });

  it("counts time spent in another task as idle time in this task's timeline", () => {
    // Task 1's last keystroke is at 1500; Task 2 starts at 60000. Viewed as
    // Task 2 alone, that minute is real dead time and skip-idle must see it.
    const only2 = buildReplay(replayDataForTask(session, "task2"), { initialText: "" });
    expect(only2.events?.length ?? only2.eventCount).toBe(t2.length);
    expect(only2.gaps.some((g) => g.durationMs >= 55000)).toBe(true);
  });

  it("leaves a session with no per-task record untouched", () => {
    const legacy = {
      snapshots: [xsnap(9000, { "main.cpp": "int a;" }, 6)],
      events: typeOut("main.cpp", "int a;", 1000),
      openedAt: 0,
    };
    const narrowed = replayDataForTask(legacy, "task1");
    expect(narrowed.events).toEqual(legacy.events);
    expect(narrowed.snapshots[0].codeSnapshot).toBe(legacy.snapshots[0].codeSnapshot);
    expect(buildReplay(narrowed, { initialText: "" }).finalText).toBe("int a;");
  });

  it("returns the payload unchanged when no task is selected (all-tasks view)", () => {
    expect(replayDataForTask(session, null)).toBe(session);
  });
});
