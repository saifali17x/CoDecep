import { describe, it, expect } from "vitest";
import {
  liveEventKey,
  dedupeLiveEvents,
  canStitch,
  stitchLive,
  recordedThrough,
  hasExactEdit,
} from "./liveStitch";
import { buildReplay } from "./replayEngine";

// Live DVR stitching (Session 28). Everything here is the PURE half of the
// ghost typer: joining a recorded past to a live present without duplicating an
// event, without leaving a hole, and without letting a rewind get dragged
// forward by keystrokes that are still arriving.

/** One exact-capture keystroke, the shape EditorPane emits. */
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
  taskId: null,
  rangeOffset: o,
  rangeLength: d,
  insertedText: t,
  ...extra,
});

/** A flush window carrying the whole workspace. */
const xsnap = (
  flushedAt: number,
  fileSnapshots: Record<string, string>,
  eventCount: number,
) => ({
  flushedAt,
  codeSnapshot: Object.values(fileSnapshots)[0] ?? "",
  fileSnapshots,
  eventCount,
});

/** Type a string one character at a time into `file`. */
function typeOut(file: string, text: string, startTs: number, startOffset = 0) {
  return [...text].map((ch, i) => xev(startTs + i * 100, file, startOffset + i, 0, ch));
}

describe("liveEventKey", () => {
  it("is stable across the wire: the live copy and the flushed copy key alike", () => {
    const ev = xev(1000, "main.cpp", 4, 0, "x");
    // The live copy is a shallow clone made at emit time; the flushed copy is
    // the same object serialised through JSON. Both must resolve identically or
    // de-dup silently stops working and text gets inserted twice.
    expect(liveEventKey({ ...ev })).toBe(liveEventKey(JSON.parse(JSON.stringify(ev))));
  });

  it("separates events that differ only by file or task", () => {
    const a = xev(1000, "main.cpp", 4, 0, "x");
    const b = { ...a, fileName: "Student.h" };
    const c = { ...a, taskId: "task2" };
    expect(new Set([liveEventKey(a), liveEventKey(b), liveEventKey(c)]).size).toBe(3);
  });

  it("keys multi-cursor events off their whole change list", () => {
    const a = { timestamp: 5, changes: [{ o: 1, d: 0, t: "a" }] };
    const b = { timestamp: 5, changes: [{ o: 1, d: 0, t: "a" }, { o: 9, d: 0, t: "b" }] };
    expect(liveEventKey(a)).not.toBe(liveEventKey(b));
  });
});

describe("hasExactEdit / canStitch", () => {
  it("accepts v2 events and rejects pre-v2 size-only ones", () => {
    expect(hasExactEdit(xev(1, "main.cpp", 0, 0, "a"))).toBe(true);
    expect(hasExactEdit({ timestamp: 1, actionType: "type", charDelta: 1 })).toBe(false);
  });

  it("refuses to stitch a pre-v2 session — its recorded path cannot take a tail", () => {
    // The legacy engine reconstructs by diffing consecutive snapshots, and the
    // live tail has no snapshot to diff against. Honest refusal beats a
    // plausible fiction.
    const legacy = {
      snapshots: [xsnap(9000, { "main.cpp": "abc" }, 1)],
      events: [{ timestamp: 1000, actionType: "type", charDelta: 3, textLength: 3 }],
      openedAt: 0,
    };
    expect(canStitch(legacy)).toBe(false);
    const out = stitchLive(legacy, typeOut("main.cpp", "d", 9500), { syncedAt: 9000 });
    expect(out).toBe(legacy); // untouched, identity-equal
  });
});

describe("dedupeLiveEvents", () => {
  it("drops a live event that is already in the durable record", () => {
    const recorded = typeOut("main.cpp", "abc", 1000);
    // The same three events, plus one genuinely new one.
    const live = [...recorded.map((e) => ({ ...e })), xev(1300, "main.cpp", 3, 0, "d")];
    const tail = dedupeLiveEvents(recorded, live, { since: 0 });
    expect(tail).toHaveLength(1);
    expect(tail[0].insertedText).toBe("d");
  });

  it("drops a live event redelivered twice by the stream itself", () => {
    const ev = xev(1000, "main.cpp", 0, 0, "a");
    const tail = dedupeLiveEvents([], [ev, { ...ev }, { ...ev }], { since: 0 });
    expect(tail).toHaveLength(1);
  });

  it("ignores events older than the sync point", () => {
    // Those belong to the window the student had buffered when watching began;
    // they arrive through the flush, not the stream.
    const live = [xev(500, "main.cpp", 0, 0, "a"), xev(1500, "main.cpp", 1, 0, "b")];
    const tail = dedupeLiveEvents([], live, { since: 1000 });
    expect(tail.map((e) => e.insertedText)).toEqual(["b"]);
  });

  it("returns the tail in timestamp order regardless of arrival order", () => {
    const live = [
      xev(3000, "main.cpp", 2, 0, "c"),
      xev(1000, "main.cpp", 0, 0, "a"),
      xev(2000, "main.cpp", 1, 0, "b"),
    ];
    expect(dedupeLiveEvents([], live, { since: 0 }).map((e) => e.insertedText)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("stitchLive — the seam", () => {
  it("applies nothing before the sync handshake", () => {
    // The dangerous state: the student may still be holding un-flushed
    // keystrokes, so every live offset could point into text we do not have.
    // Showing the clean recorded past is the only correct answer here.
    const data = {
      snapshots: [xsnap(2000, { "main.cpp": "ab" }, 2)],
      events: typeOut("main.cpp", "ab", 1000),
      openedAt: 0,
    };
    const out = stitchLive(data, typeOut("main.cpp", "c", 3000, 2), { syncedAt: null });
    expect(out).toBe(data);
  });

  it("extends the timeline: appended live events are replayed character-accurately", () => {
    // Recorded: "int a" was flushed. Live: the student is typing " = 1;" now.
    const recordedEvents = typeOut("main.cpp", "int a", 1000);
    const data = {
      snapshots: [xsnap(2000, { "main.cpp": "int a" }, recordedEvents.length)],
      events: recordedEvents,
      openedAt: 0,
    };
    const liveEvents = typeOut("main.cpp", " = 1;", 3000, 5);

    const stitched = stitchLive(data, liveEvents, { syncedAt: 2500 });
    const r = buildReplay(stitched, { initialText: "" });

    expect(r.eventCount).toBe(10);
    expect(r.liveEventCount).toBe(5);
    // The whole document, recorded half + live half, with no gap and no overlap.
    expect(r.textAt(r.totalDurationMs)).toBe("int a = 1;");
    // ...and the live half is genuinely incremental, not a jump to the end.
    expect(r.stateAt(r.frames[6].t).text).toBe("int a =");
    expect(r.stateAt(r.frames[8].t).text).toBe("int a = 1");
  });

  it("an event arriving BOTH live and in a later flush is applied exactly once", () => {
    // The seam case that matters: a flush lands mid-watch and now contains
    // events the DVR already has from the stream. Applying them twice would
    // insert the text twice.
    const all = typeOut("main.cpp", "int a = 1;", 1000); // ts 1000…1900
    const recordedFirst = all.slice(0, 5); // "int a" flushed (ts 1000…1400)
    const liveTail = all.slice(5).map((e) => ({ ...e })); // " = 1;" streamed
    // The watch-start flush was taken at 1450: everything before it is durable,
    // everything from it on may be in either place and de-dup decides.
    const syncedAt = 1450;

    const before = stitchLive(
      {
        snapshots: [xsnap(1450, { "main.cpp": "int a" }, 5)],
        events: recordedFirst,
        openedAt: 0,
      },
      liveTail,
      { syncedAt },
    );
    expect(buildReplay(before, { initialText: "" }).textAt(Infinity)).toBe("int a = 1;");

    // Now the next flush lands: the record grows to cover the SAME events the
    // live tail is still holding, and the DVR refetches.
    const after = stitchLive(
      {
        snapshots: [
          xsnap(1450, { "main.cpp": "int a" }, 5),
          xsnap(4000, { "main.cpp": "int a = 1;" }, 5),
        ],
        events: all,
        openedAt: 0,
      },
      liveTail,
      { syncedAt },
    );
    // Every live event was retired into the record, so there is no tail left.
    expect(after.events).toHaveLength(10);
    const r = buildReplay(after, { initialText: "" });
    expect(r.eventCount).toBe(10);
    expect(r.liveEventCount).toBe(0);
    expect(r.textAt(Infinity)).toBe("int a = 1;"); // not "int a = 1; = 1;"
    // The reconciled window is verified against its real snapshot again.
    expect(r.exact).toBe(true);
  });

  it("the live edge does not make a verified session read as approximate", () => {
    // An un-flushed window has no snapshot to be checked against, and that
    // absence says nothing about fidelity — these are the same exact edits,
    // applied on a checkpoint that WAS verified. Marking it inexact would
    // label every live session "approximate" for the wrong reason.
    const recordedEvents = typeOut("main.cpp", "abc", 1000);
    const stitched = stitchLive(
      {
        snapshots: [xsnap(2000, { "main.cpp": "abc" }, 3)],
        events: recordedEvents,
        openedAt: 0,
      },
      typeOut("main.cpp", "de", 3000, 3),
      { syncedAt: 2500 },
    );
    const r = buildReplay(stitched, { initialText: "" });
    expect(r.exact).toBe(true);
    expect(r.inexactWindowCount).toBe(0);
    expect(r.liveEventCount).toBe(2); // ...but reported honestly as unflushed
  });

  it("works with NOTHING recorded yet — the first-minute case", () => {
    // The exact failure this feature exists for: before the first 30s flush the
    // database holds nothing, so a flush-only DVR shows an empty panel.
    const live = typeOut("main.cpp", "#include <iostream>", 1000);
    const stitched = stitchLive(
      { snapshots: [], events: [], openedAt: 0, status: "IN_PROGRESS" },
      live,
      { syncedAt: 500 },
    );
    const r = buildReplay(stitched, { initialText: "" });
    expect(r.totalDurationMs).toBeGreaterThan(0);
    expect(r.textAt(Infinity)).toBe("#include <iostream>");
    expect(r.liveEventCount).toBe(19);
  });
});

describe("stitchLive — rewind while the stream continues", () => {
  it("a past position keeps showing past text as live events keep arriving", () => {
    const recordedEvents = typeOut("main.cpp", "int a", 1000);
    const base = {
      snapshots: [xsnap(2000, { "main.cpp": "int a" }, recordedEvents.length)],
      events: recordedEvents,
      openedAt: 0,
    };
    // The instructor scrubs back to just after the 3rd keystroke.
    const rewound = buildReplay(base, { initialText: "" });
    const pastT = rewound.frames[2].t;
    expect(rewound.stateAt(pastT).text).toBe("int");

    // Two more bursts of live typing arrive while they sit there.
    let stitched = stitchLive(base, typeOut("main.cpp", " = ", 3000, 5), { syncedAt: 2500 });
    let r = buildReplay(stitched, { initialText: "" });
    expect(r.stateAt(pastT).text).toBe("int"); // the view they are looking at is unmoved
    expect(r.textAt(Infinity)).toBe("int a = "); // ...while the timeline grew

    stitched = stitchLive(
      base,
      [...typeOut("main.cpp", " = ", 3000, 5), ...typeOut("main.cpp", "1;", 4000, 8)],
      { syncedAt: 2500 },
    );
    r = buildReplay(stitched, { initialText: "" });
    expect(r.stateAt(pastT).text).toBe("int"); // still unmoved
    expect(r.textAt(Infinity)).toBe("int a = 1;"); // ...and the live edge advanced
  });
});

describe("stitchLive — a paste on the live stream", () => {
  it("is marked at the right moment, with the real inserted range", () => {
    // The investigative moment: the instructor sees Student 7 paste, live.
    const pasted = "for (int i = 0; i < n; i++) { total += arr[i]; }";
    const recordedEvents = typeOut("main.cpp", "int total = 0;", 1000);
    const pasteEvent = xev(5000, "main.cpp", 14, 0, pasted, {
      actionType: "paste",
      provenance: "external",
    });

    const stitched = stitchLive(
      {
        snapshots: [xsnap(2000, { "main.cpp": "int total = 0;" }, recordedEvents.length)],
        events: recordedEvents,
        openedAt: 0,
      },
      [pasteEvent],
      { syncedAt: 2500 },
    );
    const r = buildReplay(stitched, { initialText: "" });

    expect(r.pasteMarks).toHaveLength(1);
    const mark = r.pasteMarks[0];
    expect(mark.charCount).toBe(pasted.length);
    expect(mark.provenance).toBe("external");
    expect(mark.fileName).toBe("main.cpp");
    // The range is the real one, so the DVR's highlight lands on the pasted
    // block rather than on interpolated characters.
    expect(mark.rangeStart).toBe(14);
    expect(mark.rangeEnd).toBe(14 + pasted.length);
    // The block appears all at once at its own moment — never typed out.
    expect(r.textAt(mark.t - 1)).toBe("int total = 0;");
    expect(r.textAt(mark.t)).toBe("int total = 0;" + pasted);
  });
});

describe("recordedThrough", () => {
  it("reports the last flush time and ignores the open live window", () => {
    const data = {
      snapshots: [xsnap(2000, { "main.cpp": "a" }, 1), xsnap(4000, { "main.cpp": "ab" }, 1)],
      events: typeOut("main.cpp", "ab", 1000),
      openedAt: 0,
    };
    expect(recordedThrough(data)).toBe(4000);
    const stitched = stitchLive(data, typeOut("main.cpp", "c", 5000, 2), { syncedAt: 4500 });
    // The open window is not a flush and must never be reported as one — that
    // label is exactly what tells an instructor how stale the record is.
    expect(recordedThrough(stitched)).toBe(4000);
  });

  it("is null when nothing has been flushed yet", () => {
    expect(recordedThrough({ snapshots: [], events: [] })).toBe(null);
  });
});
