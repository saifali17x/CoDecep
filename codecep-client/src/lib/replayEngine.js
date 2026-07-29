// Keystroke replay engine (Session 19). PURE module — no React, no DOM.
//
// Reconstruction strategy: SNAPSHOT-ANCHORED DIFF INTERPOLATION.
// The stored keystroke events carry timing/kind/size ({ timestamp,
// timeSinceLastKeystrokeMs, actionType, charDelta, textLength, provenance? })
// but NOT the exact inserted characters or cursor position — so exact
// per-keystroke text replay is not possible from the data. Instead:
//
//   - Each 30s codeSnapshot is a KNOWN-CORRECT full-text checkpoint. The
//     replay can never drift: text at every snapshot boundary is exact.
//   - Between two snapshots we diff the texts (common prefix/suffix → one
//     changed region) and distribute the insertion/removal across the real
//     event timestamps, proportional to each event's real charDelta.
//   - PASTE events apply their whole share in ONE step at their timestamp —
//     the block visibly appears at once (the forensically important moment).
//
// Fidelity, honestly stated: TIMING and PASTE MOMENTS are exact; the exact
// character order WITHIN a typed burst is approximated (the diff region fills
// front-to-back). Deletions shrink the old region as delete events occur.

export const DEFAULT_IDLE_GAP_MS = 5000;
export const PASTE_MARK_MIN_CHARS = 20; // pastes at least this big get marks

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

export function buildReplay(data, opts = {}) {
  const snapshots = data?.snapshots ?? [];
  const events = data?.events ?? [];
  const initialText = opts.initialText ?? "";
  const idleGapMs = opts.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const pasteMinChars = opts.pasteMinChars ?? PASTE_MARK_MIN_CHARS;

  const finalText = snapshots.length
    ? snapshots[snapshots.length - 1].codeSnapshot
    : initialText;

  if (!snapshots.length || !events.length) {
    return {
      totalDurationMs: 0,
      startTime: data?.startedAt ?? 0,
      frames: [],
      pasteMarks: [],
      gaps: [],
      eventCount: events.length,
      finalText,
      textAt: () => finalText,
    };
  }

  const t0 = events[0].timestamp;

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
      if (ev.timeSinceLastKeystrokeMs > idleGapMs && frames.length > 1) {
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
    finalText,
    textAt,
  };
}
