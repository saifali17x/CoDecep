// Keystroke replay engine (Session 19; rebuilt Session 24). PURE module — no
// React, no DOM.
//
// TWO reconstruction strategies, chosen per session by what the data supports.
//
// 1. EXACT (Telemetry Capture v2, Session 24 onward). Events carry the precise
//    edit — `{ rangeOffset, rangeLength, insertedText }` (or a `changes` list)
//    plus the `fileName` they happened in — so the replay applies the real
//    edits in the real order and reproduces every intermediate buffer state
//    character for character, per file. Nothing is interpolated.
//
//    Correctness is not assumed, it is CHECKED: the reconstruction is compared
//    against each flush's stored snapshot for that file. If a window ever fails
//    to match, that window is healed from the snapshot and marked inexact, and
//    the session reports `exact: false`. A replay is therefore never silently
//    wrong — it either matches the recorded truth or says it didn't.
//
// 2. SNAPSHOT-ANCHORED DIFF INTERPOLATION (pre-v2 sessions). Older events carry
//    only timing/kind/size, so exact text replay is impossible from the data.
//    Each 30s codeSnapshot is a known-correct checkpoint; between two snapshots
//    the diff is distributed across the real event timestamps in proportion to
//    each event's charDelta, and paste events apply their whole share in ONE
//    step. Timing and paste moments are exact; character order WITHIN a typed
//    burst is approximated. This path is unchanged, so every session recorded
//    before v2 replays exactly as it always did.

export const DEFAULT_IDLE_GAP_MS = 5000;
export const PASTE_MARK_MIN_CHARS = 20; // pastes at least this big get marks

// Session 22 (part 2) — LEAD-IN. The timeline used to start AT the first
// keystroke (t0 = events[0].timestamp), so the first event's frame sat at t=0
// and its effect was already on screen before playback began. A student who
// pasted their whole solution as their first action therefore appeared to have
// "always had" the code — and when the paste was the ONLY event, the last
// frame was also at t=0, totalDurationMs was 0, and the player fell through to
// its "no keystroke activity" empty state. The single most incriminating
// session in the system rendered as nothing at all.
//
// Fix: anchor the timeline at `openedAt` (when the exam was opened) so the
// replay opens on an empty document and the first event is SEEN arriving.
// When openedAt is missing or unusable (legacy payloads, clock skew) fall back
// to a small synthetic lead-in — enough to see the arrival, never enough to
// invent activity. The lead-in is registered as an idle gap, so skip-idle
// fast-forwards a long "sat there before typing" pause exactly as it does mid-
// session.
export const FALLBACK_LEAD_IN_MS = 1500;

// Common prefix/suffix diff: from → to expressed as one changed region.
export function diffTexts(from, to) {
  let p = 0;
  const maxP = Math.min(from.length, to.length);
  while (p < maxP && from[p] === to[p]) p++;
  let s = 0;
  const maxS = Math.min(from.length, to.length) - p;
  while (s < maxS && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
  return {
    prefix: to.slice(0, p),
    suffix: s > 0 ? to.slice(to.length - s) : "",
    removed: from.slice(p, from.length - s),
    inserted: to.slice(p, to.length - s),
  };
}

// The file a pre-v2 event (or a v2 event with no fileName) belongs to. Those
// sessions were single-file C++ by construction.
export const DEFAULT_FILE = "main.cpp";

/**
 * The stored edit list for an event, or null when this event predates exact
 * capture. Single-change events store the edit flat; multi-cursor / replace-all
 * events keep a `changes` array. Both read the same way through here.
 */
export function changesOf(ev) {
  if (Array.isArray(ev?.changes) && ev.changes.length > 0) return ev.changes;
  if (typeof ev?.insertedText === "string" && typeof ev?.rangeOffset === "number") {
    return [{ o: ev.rangeOffset, d: ev.rangeLength ?? 0, t: ev.insertedText }];
  }
  return null;
}

/**
 * Apply Monaco's edit list to a string. Monaco delivers changes sorted from the
 * END of the document backwards precisely so they can be applied in sequence
 * without re-basing offsets; that order is preserved in storage and relied on
 * here.
 */
export function applyChanges(text, changes) {
  let out = text;
  for (const c of changes) {
    const o = Math.max(0, Math.min(c.o, out.length));
    out = out.slice(0, o) + (c.t ?? "") + out.slice(o + (c.d ?? 0));
  }
  return out;
}

const fileOf = (ev) => ev?.fileName ?? DEFAULT_FILE;

// Per-flush workspace map, tolerating pre-v2 snapshots that only carry the
// single active-buffer string.
function snapshotFiles(snapshot) {
  if (snapshot?.fileSnapshots && typeof snapshot.fileSnapshots === "object") {
    return snapshot.fileSnapshots;
  }
  return { [DEFAULT_FILE]: snapshot?.codeSnapshot ?? "" };
}

export function buildReplay(data, opts = {}) {
  const snapshots = data?.snapshots ?? [];
  const events = data?.events ?? [];
  const initialText = opts.initialText ?? "";
  const idleGapMs = opts.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const pasteMinChars = opts.pasteMinChars ?? PASTE_MARK_MIN_CHARS;

  // Exact replay needs the edit list on EVERY event: a session with even one
  // pre-v2 event cannot be reconstructed exactly, and guessing would be worse
  // than the honest interpolation the legacy path already does well.
  const exactCapable =
    events.length > 0 && snapshots.length > 0 && events.every((e) => changesOf(e) !== null);
  if (exactCapable) {
    return buildExactReplay(data, { initialText, idleGapMs, pasteMinChars });
  }

  const finalText = snapshots.length
    ? snapshots[snapshots.length - 1].codeSnapshot
    : initialText;

  if (!snapshots.length || !events.length) {
    const names = snapshots.length
      ? Object.keys(snapshotFiles(snapshots[snapshots.length - 1]))
      : [DEFAULT_FILE];
    return {
      totalDurationMs: 0,
      startTime: data?.startedAt ?? 0,
      frames: [],
      pasteMarks: [],
      gaps: [],
      eventCount: events.length,
      files: names,
      exact: false,
      finalText,
      textAt: () => finalText,
      stateAt: () => ({ fileName: names[0] ?? DEFAULT_FILE, text: finalText }),
    };
  }

  // Timeline origin: the moment the exam was OPENED, not the first keystroke.
  const firstEventTs = events[0].timestamp;
  const openedAt = Number(data?.openedAt);
  const t0 =
    Number.isFinite(openedAt) && openedAt < firstEventTs
      ? openedAt
      : firstEventTs - FALLBACK_LEAD_IN_MS;

  // Partition the flattened events back into flush windows via eventCount.
  // (Windows without an eventCount — defensive — fall back to "rest".)
  const segments = [];
  let cursor = 0;
  for (let i = 0; i < snapshots.length; i++) {
    const count = snapshots[i].eventCount ?? events.length - cursor;
    const segEvents = events.slice(cursor, cursor + count);
    cursor += count;
    const fromText = i === 0 ? initialText : snapshots[i - 1].codeSnapshot;
    const toText = snapshots[i].codeSnapshot;
    segments.push({ fromText, toText, events: segEvents, diff: diffTexts(fromText, toText) });
  }

  // Build frames: one per event, each carrying how much of the segment's
  // inserted/removed region is realized at that moment.
  const frames = []; // { t (rel ms), seg, ins, del, prevIns, actionType, charDelta, provenance }
  const pasteMarks = [];
  const gaps = [];
  let prevT = 0;

  segments.forEach((seg, segIdx) => {
    const { inserted, removed } = seg.diff;
    const typeTotal = seg.events.reduce((s, e) => s + Math.max(0, e.charDelta), 0);
    const delTotal = seg.events.reduce((s, e) => s + Math.max(0, -e.charDelta), 0);
    let typeAcc = 0;
    let delAcc = 0;

    seg.events.forEach((ev, k) => {
      typeAcc += Math.max(0, ev.charDelta);
      delAcc += Math.max(0, -ev.charDelta);
      const isLast = k === seg.events.length - 1;
      // Proportional share of the real diff; the segment's last event anchors
      // to the snapshot exactly.
      const ins = isLast
        ? inserted.length
        : typeTotal > 0
          ? Math.min(inserted.length, Math.round((inserted.length * typeAcc) / typeTotal))
          : Math.round((inserted.length * (k + 1)) / seg.events.length);
      const del = isLast
        ? removed.length
        : delTotal > 0
          ? Math.min(removed.length, Math.round((removed.length * delAcc) / delTotal))
          : 0;
      const prevIns = frames.length && frames[frames.length - 1].seg === segIdx
        ? frames[frames.length - 1].ins
        : 0;
      const t = Math.max(prevT, ev.timestamp - t0); // keep monotonic
      prevT = t;
      frames.push({
        t,
        seg: segIdx,
        ins,
        del,
        prevIns,
        actionType: ev.actionType,
        charDelta: ev.charDelta,
        provenance: ev.provenance,
      });

      if (ev.actionType === "paste" && ev.charDelta >= pasteMinChars) {
        pasteMarks.push({
          t,
          charCount: ev.charDelta,
          // offsets valid within textAt(t)
          rangeStart: seg.diff.prefix.length + prevIns,
          rangeEnd: seg.diff.prefix.length + ins,
          provenance: ev.provenance ?? null,
        });
      }
      if (frames.length === 1) {
        // The lead-in before the first keystroke: real dead time (the exam was
        // open, nothing was typed). Skippable like any other idle gap.
        if (t > idleGapMs) gaps.push({ start: 0, end: t, durationMs: t });
      } else if (ev.timeSinceLastKeystrokeMs > idleGapMs) {
        gaps.push({ start: t - ev.timeSinceLastKeystrokeMs, end: t, durationMs: ev.timeSinceLastKeystrokeMs });
      }
    });
  });

  const totalDurationMs = frames.length ? frames[frames.length - 1].t : 0;

  function textForFrame(frame) {
    const seg = segments[frame.seg];
    const { prefix, suffix, removed, inserted } = seg.diff;
    return (
      prefix +
      inserted.slice(0, frame.ins) +
      removed.slice(0, removed.length - frame.del) +
      suffix
    );
  }

  // Last frame with t <= relMs (binary search).
  function frameIndexAt(relMs) {
    let lo = 0;
    let hi = frames.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= relMs) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function textAt(relMs) {
    if (relMs >= totalDurationMs) return finalText;
    const idx = frameIndexAt(relMs);
    if (idx < 0) return initialText;
    return textForFrame(frames[idx]);
  }

  return {
    totalDurationMs,
    startTime: t0,
    frames,
    pasteMarks,
    gaps,
    eventCount: events.length,
    // A pre-v2 session had exactly one file, so the file-aware API still
    // answers — it just always names the same file.
    files: [DEFAULT_FILE],
    exact: false,
    finalText,
    textAt,
    stateAt: (relMs) => ({ fileName: DEFAULT_FILE, text: textAt(relMs) }),
  };
}

// ── EXACT per-file reconstruction (Telemetry Capture v2) ────────────────────
function buildExactReplay(data, { initialText, idleGapMs, pasteMinChars }) {
  const snapshots = data.snapshots;
  const events = data.events;

  // Partition the flattened events back into flush windows. `eventCount` per
  // snapshot is what makes this exact rather than a clock comparison.
  const windowOf = new Int32Array(events.length);
  {
    let cursor = 0;
    for (let w = 0; w < snapshots.length; w++) {
      const count = snapshots[w].eventCount ?? events.length - cursor;
      for (let i = cursor; i < Math.min(cursor + count, events.length); i++) windowOf[i] = w;
      cursor += count;
    }
    // Defensive: any trailing events belong to the last window.
    for (let i = Math.max(0, cursor); i < events.length; i++) windowOf[i] = snapshots.length - 1;
  }

  // Every file that ever appears, in first-seen order.
  const files = [];
  const seeFile = (name) => {
    if (!files.includes(name)) files.push(name);
  };
  events.forEach((e) => seeFile(fileOf(e)));
  snapshots.forEach((s) => Object.keys(snapshotFiles(s)).forEach(seeFile));

  // ── Checkpoint pass ───────────────────────────────────────────────────────
  // Replay every edit forward per file, and at each flush boundary CHECK the
  // reconstruction against the recorded snapshot. Matching proves the replay is
  // faithful; a mismatch heals from the snapshot and is recorded, so the player
  // can say the session is not exact instead of showing a plausible fiction.
  // checkpoints[w][file] = that file's text at the END of window w.
  const checkpoints = [];
  const inexactWindows = new Set();
  const current = new Map();
  for (const f of files) {
    // The entry file may have started non-empty (the /legacy template); every
    // other file starts empty because it was created during the session.
    current.set(f, f === (files[0] ?? DEFAULT_FILE) ? initialText : "");
  }

  let idx = 0;
  for (let w = 0; w < snapshots.length; w++) {
    while (idx < events.length && windowOf[idx] === w) {
      const ev = events[idx];
      const f = fileOf(ev);
      current.set(f, applyChanges(current.get(f) ?? "", changesOf(ev)));
      idx++;
    }
    const recorded = snapshotFiles(snapshots[w]);
    for (const [name, text] of Object.entries(recorded)) {
      if ((current.get(name) ?? "") !== text) {
        inexactWindows.add(w);
        current.set(name, text); // heal, so later windows stay anchored
      }
    }
    checkpoints.push(new Map(current));
  }

  // ── Frames ────────────────────────────────────────────────────────────────
  const firstEventTs = events[0].timestamp;
  const openedAt = Number(data?.openedAt);
  const t0 =
    Number.isFinite(openedAt) && openedAt < firstEventTs
      ? openedAt
      : firstEventTs - FALLBACK_LEAD_IN_MS;

  const frames = [];
  const pasteMarks = [];
  const gaps = [];
  let prevT = 0;

  events.forEach((ev, i) => {
    const t = Math.max(prevT, ev.timestamp - t0); // keep monotonic
    prevT = t;
    const fileName = fileOf(ev);
    frames.push({ t, i, w: windowOf[i], fileName, actionType: ev.actionType, charDelta: ev.charDelta });

    // Paste marks now carry the REAL inserted range — no interpolation.
    if (ev.actionType === "paste" && ev.charDelta >= pasteMinChars) {
      const ch = changesOf(ev)[0];
      pasteMarks.push({
        t,
        charCount: ev.charDelta,
        fileName,
        rangeStart: ch.o,
        rangeEnd: ch.o + (ch.t?.length ?? 0),
        provenance: ev.provenance ?? null,
      });
    }

    if (i === 0) {
      // Lead-in before the first keystroke: real dead time, skippable.
      if (t > idleGapMs) gaps.push({ start: 0, end: t, durationMs: t });
    } else if (ev.timeSinceLastKeystrokeMs > idleGapMs) {
      gaps.push({
        start: t - ev.timeSinceLastKeystrokeMs,
        end: t,
        durationMs: ev.timeSinceLastKeystrokeMs,
      });
    }
  });

  const totalDurationMs = frames.length ? frames[frames.length - 1].t : 0;

  function frameIndexAt(relMs) {
    let lo = 0;
    let hi = frames.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= relMs) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  // Text of one file at a frame: start from the previous window's checkpoint
  // (or the session start) and replay only that window's edits for that file.
  // Bounded work — at most one 30s flush window, however long the exam ran.
  function textOfFileAt(fileName, frameIdx) {
    if (frameIdx < 0) {
      return fileName === (files[0] ?? DEFAULT_FILE) ? initialText : "";
    }
    const w = frames[frameIdx].w;
    let text =
      w === 0
        ? fileName === (files[0] ?? DEFAULT_FILE)
          ? initialText
          : ""
        : checkpoints[w - 1].get(fileName) ?? "";
    const eventIdx = frames[frameIdx].i;
    for (let i = 0; i < events.length; i++) {
      if (windowOf[i] !== w) continue;
      if (i > eventIdx) break;
      if (fileOf(events[i]) !== fileName) continue;
      text = applyChanges(text, changesOf(events[i]));
    }
    return text;
  }

  const lastFile = frames.length ? frames[frames.length - 1].fileName : files[0] ?? DEFAULT_FILE;
  const finalFiles = checkpoints.length ? checkpoints[checkpoints.length - 1] : new Map();
  const finalText = finalFiles.get(lastFile) ?? "";

  function stateAt(relMs) {
    if (relMs >= totalDurationMs) return { fileName: lastFile, text: finalText };
    const idxAt = frameIndexAt(relMs);
    if (idxAt < 0) {
      const f = files[0] ?? DEFAULT_FILE;
      return { fileName: f, text: initialText };
    }
    const fileName = frames[idxAt].fileName;
    return { fileName, text: textOfFileAt(fileName, idxAt) };
  }

  return {
    totalDurationMs,
    startTime: t0,
    frames,
    pasteMarks,
    gaps,
    eventCount: events.length,
    files,
    exact: inexactWindows.size === 0,
    inexactWindowCount: inexactWindows.size,
    finalText,
    finalFiles,
    textAt: (relMs) => stateAt(relMs).text,
    stateAt,
  };
}
