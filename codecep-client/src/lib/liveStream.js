// Student-side live keystroke streaming (Session 28).
//
// The student's editor already captures every keystroke exactly, for the 30s
// flush. This ALSO emits those same events over Socket.io — but only while an
// instructor is actually watching this session, so an exam of forty students
// streams nothing until someone opens one of them.
//
// THREE RULES THIS MODULE EXISTS TO KEEP.
//
//  1. It never touches capture or flush. The event is buffered and flushed
//     exactly as before; the live emit is a parallel, best-effort copy. If the
//     socket is down, dead, or never connects, the durable record is identical.
//     The database remains the source of truth and the only thing forensics
//     reads.
//
//  2. The Immune Phase wins. `stop()` is called on submit and nothing emits
//     after it, the same way the heartbeat and the visibility listeners disarm.
//
//  3. The seam is synced, not guessed. When watching begins, the keystrokes
//     since the last flush are still in the browser's buffer — a hole between
//     where the recorded data ends and where the stream starts. Every live edit
//     carries an offset into text that hole is missing, so a naive stream would
//     hand the instructor genuinely garbled code. So on `live:start` we drain
//     the buffer immediately and report the moment it was taken; the DVR
//     applies nothing until the record has caught up to that instant.

import socket from "../socket";
import { debugLog } from "../debug";

// How long to wait before retrying a failed sync flush. The instructor sees
// clean recorded data in the meantime, so this is not urgent — it just must not
// give up, or the live edge would stay dark for the rest of the exam.
const SYNC_RETRY_MS = 5000;

let sessionId = null;
let watched = false;
let synced = false;
let stopped = false;
let flushFn = null;
let retryTimer = null;
let listenersBound = false;

/** Live emitting is armed: an instructor is watching and we are not submitted. */
export function isWatched() {
  return watched && !stopped;
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;

  socket.on("live:start", (payload) => {
    if (!sessionId || payload?.sessionId !== sessionId || stopped) return;
    if (watched) return; // already streaming (a second instructor joined)
    watched = true;
    debugLog("[LIVE] instructor watching — streaming keystrokes");
    void syncNow();
  });

  socket.on("live:stop", (payload) => {
    if (!sessionId || payload?.sessionId !== sessionId) return;
    watched = false;
    synced = false; // the next watcher gets a fresh sync
    clearTimeout(retryTimer);
    debugLog("[LIVE] no longer watched — streaming stopped");
  });

  // A dropped socket loses the room membership, so re-join and let the server
  // tell us whether anyone is still watching. Streaming stays off until it does.
  socket.on("connect", () => {
    if (!sessionId || stopped) return;
    watched = false;
    synced = false;
    socket.emit("session:join", { sessionId });
  });
}

/**
 * Drain the telemetry buffer NOW and tell the watchers the moment it was taken.
 * `at` is captured BEFORE the drain, so every event older than it is guaranteed
 * to be in the flush; anything at or after it may be in either place and the
 * DVR's de-dup settles which.
 */
async function syncNow() {
  if (!watched || stopped || synced || !sessionId) return;
  const at = Date.now();
  let ok = true;
  try {
    // `null` means there was nothing buffered — a clean skip, and the record is
    // already current. `false` means the flush genuinely failed.
    ok = (await flushFn?.()) !== false;
  } catch (err) {
    debugLog("[LIVE] sync flush threw:", err?.message ?? err);
    ok = false;
  }
  if (!ok) {
    // Keep the live edge dark rather than showing an instructor a reconstruction
    // built over a hole. Retry until the record catches up.
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void syncNow(), SYNC_RETRY_MS);
    return;
  }
  synced = true;
  socket.emit("live:synced", { sessionId, at });
  debugLog(`[LIVE] synced at ${at} — live edge open`);
}

/**
 * Start participating. Joining the session room is NOT streaming: it is only
 * how the server reaches this student if an instructor opens them later.
 *
 * @param id        this session's id
 * @param drain     the flush handle (EditorPane's buffer drain, via App)
 */
export function attach(id, drain) {
  if (!id) return;
  sessionId = id;
  flushFn = drain;
  stopped = false;
  bindListeners();
  socket.emit("session:join", { sessionId: id });
}

/**
 * Immune Phase. Called on submit: streaming disarms permanently for this
 * session, exactly like the 30s heartbeat and the tab-out listeners.
 */
export function stop() {
  stopped = true;
  watched = false;
  synced = false;
  clearTimeout(retryTimer);
}

/**
 * Emit ONE captured keystroke, if armed. Best-effort by design — a failure here
 * is invisible to the student and irrelevant to the record, because the same
 * event is already buffered for the flush.
 *
 * The caller defers this by a tick so paste attribution (`onDidPaste`, which
 * Monaco fires just after the content change) has already upgraded the event.
 * Streaming it earlier would show the instructor a large paste labelled as
 * typing — and seeing the paste as a paste is the whole investigative point.
 */
export function emitKeystroke(event) {
  if (!isWatched() || !synced || !sessionId) return;
  try {
    socket.emit("live:keystroke", { sessionId, event });
  } catch (err) {
    debugLog("[LIVE] keystroke emit failed (ignored):", err?.message ?? err);
  }
}

/**
 * Tell watchers a flush landed, so they reconcile their live tail against the
 * durable record. The server also announces this from the ingest route; the
 * client-side signal is what covers a flush the server accepted but whose
 * announcement the instructor missed while reconnecting.
 */
export function notifyFlushed() {
  if (!sessionId || stopped || !watched) return;
  socket.emit("live:flushed", { sessionId });
}

/** Test seam — resets module state between cases. */
export function __resetForTests() {
  sessionId = null;
  watched = false;
  synced = false;
  stopped = false;
  flushFn = null;
  clearTimeout(retryTimer);
}
