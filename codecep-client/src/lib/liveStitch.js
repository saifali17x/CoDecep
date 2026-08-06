// Live DVR stitching (Session 28). PURE module — no React, no DOM, no socket.
//
// THE PROBLEM. The DVR reconstructs a session from the 30s flush, so its most
// recent window is up to 30 seconds stale and the first minute of an exam shows
// nothing at all. That is not an edge case to patch: any view built on flushed
// data alone has a stale tail by construction.
//
// THE SHAPE OF THE FIX. Two sources, one timeline.
//
//   RECORDED PAST   ← the database. Durable, verified against every snapshot,
//                     and the only thing forensics ever reads.
//   LIVE PRESENT    ← a Socket.io keystroke stream that never waits for a flush.
//
// This module joins them. It does NOT reconstruct anything itself: it produces
// a payload in exactly the shape `buildReplay` already consumes, with the live
// tail appended as one trailing OPEN window. So the live edge is replayed by
// the same exact engine, from the same exact event data, as the recorded past —
// there is no second reconstruction strategy to keep honest.
//
// THE TWO WAYS THIS COULD GO WRONG, AND WHAT PREVENTS EACH.
//
//  1. DUPLICATION. An event arrives live and then again, minutes later, in a
//     flush. Applying it twice inserts the same text twice. Prevented by
//     `liveEventKey`: the recorded copy always wins and the live copy is
//     dropped. See that function for why no new stored field was needed.
//
//  2. A HOLE. Watching begins mid-window, so the keystrokes since the last
//     flush are still sitting in the student's browser buffer — the recorded
//     data ends before the live stream begins. This is the dangerous one:
//     every live edit carries an offset into text that the hole is missing, so
//     applying them produces genuinely garbled code rather than an obvious gap.
//     Prevented by `syncedAt`: on being watched, the student immediately drains
//     that buffer and reports the moment it was taken, and nothing live is
//     applied until the record has caught up to it. Until then the DVR shows
//     the clean recorded past and says so.

/**
 * A stable identity for one keystroke, derived ENTIRELY from fields the capture
 * layer already stores.
 *
 * A sequence number would be the textbook answer, and it was deliberately not
 * used: every event is one JSONB object in a row that holds an entire exam, so
 * a new field costs bytes on every keystroke of every session forever, and
 * adding one would change the stored capture shape that Sessions 24–27 pinned
 * down. The composite below is free.
 *
 * For two DISTINCT keystrokes to collide they would have to share a
 * millisecond, a task, a file, an offset, a deletion length and an insertion
 * length. Real typing does not do that. If it somehow did, the cost is one
 * dropped duplicate frame at the seam, which the next flush reconciles away.
 */
export function liveEventKey(ev) {
  return [
    ev?.timestamp ?? 0,
    ev?.taskId ?? "",
    ev?.fileName ?? "",
    editSignature(ev),
  ].join("|");
}

function editSignature(ev) {
  if (Array.isArray(ev?.changes)) {
    return ev.changes.map((c) => `${c?.o ?? 0},${c?.d ?? 0},${c?.t?.length ?? 0}`).join(";");
  }
  if (typeof ev?.rangeOffset === "number") {
    return `${ev.rangeOffset},${ev.rangeLength ?? 0},${ev.insertedText?.length ?? 0}`;
  }
  // Pre-v2 event: no edit list at all. Falls back to the size fields, which is
  // enough to key it — such a session can never be stitched anyway (see
  // `canStitch`), so this only ever has to not throw.
  return `~${ev?.charDelta ?? 0},${ev?.textLength ?? 0}`;
}

/** Does this event carry the exact edit the exact replay engine needs? */
export function hasExactEdit(ev) {
  if (Array.isArray(ev?.changes) && ev.changes.length > 0) return true;
  return typeof ev?.insertedText === "string" && typeof ev?.rangeOffset === "number";
}

/**
 * Live events that are not already in the durable record, in timestamp order.
 *
 * `since` is the sync moment (see the header). Events older than it belong to a
 * window the student had already buffered when watching began; they reach the
 * DVR through the flush, not the stream, so applying the live copy would risk
 * inserting text the recorded checkpoint already contains.
 */
export function dedupeLiveEvents(recordedEvents, liveEvents, { since = null } = {}) {
  const seen = new Set((recordedEvents ?? []).map(liveEventKey));
  const out = [];
  for (const ev of liveEvents ?? []) {
    if (!ev) continue;
    if (since !== null && (ev.timestamp ?? 0) < since) continue;
    const key = liveEventKey(ev);
    // Guards both directions at once: against the record, and against the live
    // buffer redelivering its own event after a socket reconnect.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/**
 * Can a live tail be stitched onto this recorded payload at all?
 *
 * Only the EXACT engine can replay an unverified tail — the legacy
 * interpolation path reconstructs text by diffing consecutive snapshots, and
 * the live tail has no snapshot to diff against. A pre-v2 session therefore
 * gets the recorded view and nothing else, which is honest: its stored events
 * never carried the data a live edge would need.
 */
export function canStitch(data) {
  const events = data?.events ?? [];
  return events.every(hasExactEdit);
}

/**
 * The recorded payload with the live tail appended as one trailing OPEN window.
 *
 * The open window is marked `open: true` and carries no snapshot, because there
 * genuinely is none — these keystrokes have not been flushed yet. The engine
 * therefore skips its snapshot check for that window instead of failing it. It
 * is not claiming less verification than it has, nor more: the closed windows
 * are still checked exactly as before and still decide `replay.exact`, and the
 * open window is reported separately as `liveEventCount` so the player can say
 * which part of the timeline is the unflushed live edge.
 *
 * Returns the input UNCHANGED when there is nothing to add, so a recorded-only
 * or pre-v2 session takes byte-for-byte the path it always did.
 */
export function stitchLive(data, liveEvents, { syncedAt = null } = {}) {
  if (!data) return data;
  const recorded = data.events ?? [];
  // Nothing may be applied before the student has confirmed their buffer was
  // drained — see the header's failure mode 2.
  if (syncedAt === null) return data;
  if (!canStitch(data)) return data;

  const tail = dedupeLiveEvents(recorded, liveEvents, { since: syncedAt }).filter(hasExactEdit);
  if (tail.length === 0) return data;

  return {
    ...data,
    snapshots: [
      ...(data.snapshots ?? []),
      {
        // No flush has happened for these events — that is the whole point.
        flushedAt: null,
        open: true,
        eventCount: tail.length,
        codeSnapshot: null,
        fileSnapshots: null,
        taskSnapshots: null,
      },
    ],
    events: [...recorded, ...tail],
    endedAt: tail[tail.length - 1].timestamp ?? data.endedAt,
  };
}

/**
 * When the durable record currently ends — the last flush's wall-clock time, or
 * null if nothing has been flushed yet.
 *
 * Part 4: an in-progress session must say what it is showing rather than
 * implying the recorded view is the current moment. Everything after this
 * instant exists only in the student's browser until the next flush.
 */
export function recordedThrough(data) {
  const snapshots = (data?.snapshots ?? []).filter((s) => !s?.open);
  const last = snapshots[snapshots.length - 1];
  return typeof last?.flushedAt === "number" ? last.flushedAt : null;
}
