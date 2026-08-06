import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import socket from "../socket";
import { debugLog } from "../debug";
import { emitKeystroke } from "../lib/liveStream";
import { badgeOf, kindOf } from "../lib/workspace";
import "./EditorPane.css";

const PASTE_THRESHOLD = 50; // charDelta > 50 triggers ILLEGAL_PASTE (per CLAUDE.md)
const CONTENT_HISTORY_LIMIT = 50; // bounded rolling history of session content

// ── Telemetry Capture v2 (Session 24) ────────────────────────────────────────
// Two changes to how a keystroke is recorded, both in this file.
//
// EXACT CAPTURE. Monaco's content-change event carries the precise edit list —
// `{ rangeOffset, rangeLength, text }` per change — so an event now records
// WHAT changed and WHERE, not merely how much. That is what lets the DVR replay
// a session character-for-character instead of interpolating between 30s
// snapshots. The old size-only fields (charDelta, textLength) are KEPT so every
// existing metric keeps working unchanged.
//
// PASTE vs AUTO-INSERT. The old rule was `charDelta > 4 → paste`, which counted
// Monaco's own auto-indent, bracket auto-closing and autocomplete as pasted
// text. That dragged a hand-typed session's authorship down to ~0.54 typed and
// is precisely why TYPED_MIN had to stay conservatively low. Now the ONLY thing
// that makes an event a paste is Monaco's `onDidPaste` firing for it. Editor-
// generated insertions are what they actually are: authored typing.

// A paste is attributed to the most recent insertion event within this window.
// Monaco fires onDidPaste immediately after the content change it belongs to,
// so this is generous; it exists so a stray onDidPaste can never retro-label an
// unrelated older event.
const PASTE_ATTRIBUTION_WINDOW_MS = 250;

// Exact capture stores inserted text verbatim. A pathological single insertion
// (a megabyte pasted in) would bloat the JSONB row, so the stored text is
// capped and the event marked truncated. The SIZE fields stay exact either way,
// so no metric is affected — only replay fidelity for that one event.
const MAX_INSERTED_TEXT_CHARS = 100_000;

// Whitespace-insensitive comparison so trivial formatting differences don't
// misclassify an internal re-paste as external.
function normalizeContent(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Normalize Monaco's change list into the compact stored shape.
// `o` = offset in the pre-change text, `d` = chars deleted, `t` = text inserted.
// Monaco delivers changes sorted end-to-start so they can be applied in order
// without re-basing offsets; that order is preserved here and relied on by the
// replay engine.
function normalizeChanges(monacoChanges) {
  return (monacoChanges ?? []).map((c) => {
    const text = typeof c.text === "string" ? c.text : "";
    const truncated = text.length > MAX_INSERTED_TEXT_CHARS;
    return {
      o: c.rangeOffset,
      d: c.rangeLength,
      t: truncated ? text.slice(0, MAX_INSERTED_TEXT_CHARS) : text,
      ...(truncated ? { trunc: text.length } : {}),
    };
  });
}

export default function EditorPane({
  code,
  language,
  onChange,
  onCursorChange,
  onFlush,
  // Session 25 — App writes a drain-and-send function into this ref so Submit
  // can flush the final partial window before the Immune Phase disarms. The
  // buffer lives here, so only this component can drain it.
  flushRef,
  isSubmitted,
  studentId,
  sessionIdRef,
  labMode,
  assignmentId,
  // Multi-file workspace (Session 23). `tabs` are the switchable file names,
  // `activeFile` is the buffer Monaco currently holds, and `readOnly` locks it
  // for a captured program-output file. Telemetry is UNCHANGED by all of this:
  // it still records the active editor as ONE stream (per-file attribution is
  // the pending follow-up).
  tabs = [],
  activeFile,
  onSelectFile,
  readOnly = false,
  // Multi-task exams (Prompt 1). `taskId` is stamped on every captured event
  // alongside `fileName`, so forensics can judge each question separately.
  // `taskLabel` is null on a single-task exam and only ever decorates the text
  // of a Tier-1 alert, so the instructor knows WHICH task fired it.
  taskId = null,
  taskLabel = null,
}) {
  const lastKeystrokeTime = useRef(Date.now());
  const prevCode = useRef(code);
  const telemetryBuffer = useRef([]);

  // Switching files replaces the whole buffer. `prevCode` is the baseline every
  // charDelta is measured against, so it MUST be re-anchored on the switch or
  // the next real keystroke reports a delta the size of the difference between
  // two files — which would classify as a huge paste or delete and could fire a
  // false ILLEGAL_PASTE. No telemetry event is emitted for the switch itself.
  //
  // Safe because @monaco-editor/react suppresses onChange for programmatic
  // `value` syncs (it sets an internal guard around its executeEdits call), so
  // a file switch never reaches handleChange at all.
  //
  // Prompt 1 — the TASK is part of this identity, not just the file name. Two
  // tasks both have a main.cpp, so switching from Task 1's main.cpp to Task 2's
  // changes the buffer completely while `activeFile` stays the string
  // "main.cpp". Keyed on the file alone, the baseline would not be re-anchored
  // and the next real keystroke would report a delta the size of the whole
  // difference between the two tasks' programs — a false ILLEGAL_PASTE, which
  // is precisely the failure this guard exists to prevent.
  useEffect(() => {
    prevCode.current = code;
    lastKeystrokeTime.current = Date.now();
    // A pending change belongs to the file it happened in — never let a paste
    // in the newly-opened file be attributed to the previous file's last edit.
    lastChangeRef.current = null;
    // Change B2 (Session 24): validate the file being LEFT. Live validation
    // only ever sees the active buffer, so before v2 a forbidden construct
    // could sit in an unfocused file untouched. Submit-time validation is the
    // backstop; this is the live half.
    const leaving = prevFileRef.current;
    if (leaving && (leaving.name !== activeFile || leaving.taskId !== taskId)) {
      validateFileNow(leaving.taskId, leaving.name, leaving.code);
    }
    prevFileRef.current = { taskId, name: activeFile, code };
    // Intentionally keyed on the FILE and TASK, not the code: re-anchoring on
    // every keystroke would zero out every charDelta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, taskId]);

  // Mirrors the active file so the effect above can validate the one just left.
  // Updated on every keystroke so the validated text is current, not stale.
  useEffect(() => {
    const prev = prevFileRef.current;
    if (prev?.name === activeFile && prev?.taskId === taskId) prev.code = code;
  }, [code, activeFile, taskId]);

  // Paste provenance (internal vs external) — session-local content history.
  // We compare pasted text against what THIS session has already contained;
  // we never try to read the OS clipboard's origin.
  const lastPastedTextRef = useRef(null); // set by Monaco onDidPaste, consumed once
  const sessionContentRef = useRef([]); // normalized full-content snapshots
  // The most recent content change, held so onDidPaste can retroactively
  // upgrade it from 'type' to 'paste' (see attributePaste).
  const lastChangeRef = useRef(null);

  function pushSessionContent(text) {
    const norm = normalizeContent(text);
    if (!norm) return;
    const hist = sessionContentRef.current;
    if (hist[hist.length - 1] === norm) return;
    hist.push(norm);
    if (hist.length > CONTENT_HISTORY_LIMIT) hist.shift();
  }

  function isInternalPaste(pastedText) {
    const needle = normalizeContent(pastedText);
    if (!needle) return true; // whitespace-only pastes contain nothing novel
    return sessionContentRef.current.some((chunk) => chunk.includes(needle));
  }

  // AST_VIOLATION debounce state. The signature map is keyed by FILE
  // ({ [fileName]: "file:nodeType:line" }) so a violation in one file cannot
  // suppress a different violation in another.
  const debounceTimer = useRef(null);
  const lastViolationSig = useRef({});
  const isSubmittedRef = useRef(isSubmitted); // live mirror for async timeout callbacks
  // The file the editor was showing before the current one, with its text, so
  // switching away can validate what was left behind.
  const prevFileRef = useRef(null);

  useEffect(() => {
    isSubmittedRef.current = isSubmitted;
    if (isSubmitted) {
      // Disarm any pending debounce immediately on Submit (Immune Phase)
      clearTimeout(debounceTimer.current);
      lastViolationSig.current = {};
    }
  }, [isSubmitted]);

  useEffect(() => {
    if (isSubmitted) return;
    const id = setInterval(() => {
      // Bank the current content into the session history each flush cycle so
      // later re-pastes of it classify as internal.
      pushSessionContent(prevCode.current);
      if (telemetryBuffer.current.length === 0) return;
      const payloadToFlush = [...telemetryBuffer.current];
      telemetryBuffer.current = [];
      onFlush(payloadToFlush);
    }, 30_000);
    return () => clearInterval(id);
  }, [isSubmitted]);

  // ── Final pre-disarm flush handle (Session 25) ─────────────────────────────
  // The 30s interval above owns ordinary flushing. This is the ONE extra flush
  // Submit performs, before the Immune Phase disarms, so the last partial
  // window reaches the database instead of dying with the interval.
  //
  // Draining is the same synchronous copy-then-clear the interval does, so the
  // two can never send the same events twice even if they overlap. Returns
  // `null` when there was nothing buffered (a clean skip, not a failure), and
  // otherwise whatever the flush reported about persistence.
  const onFlushRef = useRef(onFlush);
  useEffect(() => {
    onFlushRef.current = onFlush;
  });

  useEffect(() => {
    if (!flushRef) return undefined;
    flushRef.current = async () => {
      if (isSubmittedRef.current) return null; // never after the disarm
      pushSessionContent(prevCode.current);
      if (telemetryBuffer.current.length === 0) return null;
      const payloadToFlush = [...telemetryBuffer.current];
      telemetryBuffer.current = [];
      return (await onFlushRef.current(payloadToFlush)) !== false;
    };
    return () => {
      flushRef.current = null;
    };
  }, [flushRef]);

  const isCodeBuffer = activeFile ? kindOf(activeFile) === "code" : true;

  // ── AST validation (shared by the live debounce and switch-away) ───────────
  // De-duplication is keyed per TASK+FILE: two files can legitimately hold
  // different violations at once, and a single shared signature would let the
  // second one be swallowed as a repeat of the first. Two tasks' main.cpp files
  // are different files for exactly the same reason.
  //
  // All tasks share ONE allowlist (the assignment's week), so what counts as a
  // violation is unchanged — only the bookkeeping is per task.
  async function validateFileNow(fileTaskId, fileName, sourceText) {
    if (isSubmittedRef.current) return; // Immune Phase
    if (!fileName || kindOf(fileName) !== "code") return; // never parse data files
    try {
      const res = await fetch("http://localhost:3001/api/ast/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: sourceText,
          ...(assignmentId ? { assignmentId } : {}),
        }),
      });
      const { isValid, violations, violationDetail } = await res.json();
      const key = `${fileTaskId ?? ""}::${fileName}`;
      const where = taskLabel ? `${taskLabel} / ${fileName}` : fileName;
      if (!isValid && violations.length > 0) {
        const sig = `${key}:${violations[0].nodeType}:${violations[0].line}`;
        if (sig !== lastViolationSig.current[key]) {
          lastViolationSig.current[key] = sig;
          // The detail names the CONSTRUCT and the LINE, not just a count. An
          // instructor reading "6 violation(s) in main.cpp" cannot act on it;
          // "Used for_statement (line 12)" is a specific, checkable statement.
          // `violationDetail` is formatted server-side so the alert, the stored
          // report and the server log word the same finding identically; the
          // fallback covers a server that predates the field.
          const what =
            violationDetail ??
            `${violations[0]?.nodeType ?? "unknown"} (line ${violations[0]?.line ?? "?"})`;
          const payload = {
            type: "AST_VIOLATION",
            studentId,
            sessionId: sessionIdRef?.current ?? null,
            timestamp: Date.now(),
            // "Used X" — a description of what was written, never a verdict on
            // why (Constraint 7).
            detail: `Used ${what} in ${where}`,
          };
          debugLog("[EMIT] AST_VIOLATION", payload);
          socket.emit("alert", payload);
        }
      } else {
        // This file is clean now — reset so its next violation alerts afresh.
        delete lastViolationSig.current[key];
      }
    } catch {
      // Silently swallow — do not emit on network/API errors
    }
  }

  function handleChange(val, monacoEvent) {
    const next = val ?? "";
    const now = Date.now();
    const timeSinceLastKeystrokeMs = now - lastKeystrokeTime.current;
    lastKeystrokeTime.current = now;

    const contentBeforeChange = prevCode.current;
    prevCode.current = next;

    const changes = normalizeChanges(monacoEvent?.changes);
    const insertedChars = changes.reduce((n, c) => n + (c.trunc ?? c.t.length), 0);
    const deletedChars = changes.reduce((n, c) => n + c.d, 0);

    // charDelta and textLength are derived from the CHANGE LIST, not from
    // diffing the editor's current value. @monaco-editor/react reads
    // `editor.getValue()` when its listener runs, which under fast input can
    // already be ahead of the change being reported — that produced events
    // whose size fields contradicted their own edit (an insertion with an
    // unchanged textLength). The change list is always self-consistent, so
    // deriving from it keeps every size-based metric (B, authorship) honest and
    // keeps the replay's offsets and sizes describing the same edit.
    const charDelta = changes.length > 0 ? insertedChars - deletedChars : next.length - contentBeforeChange.length;
    const textLength = changes.length > 0 ? contentBeforeChange.length + charDelta : next.length;

    // Provisional classification. NOTE the deliberate absence of a
    // "big insertion = paste" rule: a multi-char insertion is authored typing
    // until onDidPaste says otherwise (see attributePaste). Only a net
    // deletion is decided here and never revised.
    const actionType = charDelta < 0 ? "delete" : "type";

    const event = {
      timestamp: now,
      timeSinceLastKeystrokeMs,
      actionType,
      charDelta,
      textLength,
      // ── v2 exact-capture fields ──
      // Kept deliberately lean: every keystroke is one JSONB object, so a
      // redundant field costs bytes on every event of every exam. Anything
      // derivable (inserted/deleted counts) is derived at read time instead.
      fileName: activeFile ?? null,
      // Multi-task (Prompt 1): which question of the exam this keystroke was
      // typed into. Stamped at capture time, so an event carries its task even
      // if the student has moved on by the time the buffer flushes. Null on a
      // single-task exam — readers treat that as the one default task.
      taskId,
      // Single-change events (every keystroke, every ordinary paste) store the
      // edit flat; the multi-change case (multi-cursor, replace-all) keeps the
      // full list. The replay engine reads both through one helper.
      ...(changes.length === 1
        ? {
            rangeOffset: changes[0].o,
            rangeLength: changes[0].d,
            insertedText: changes[0].t,
            ...(changes[0].trunc ? { insertedTextTruncated: changes[0].trunc } : {}),
          }
        : changes.length > 1
          ? { changes }
          : {}),
    };
    telemetryBuffer.current.push(event);

    // Hand the paste attributor everything it needs, so when onDidPaste arrives
    // it can upgrade this event without re-deriving state.
    lastChangeRef.current = { event, contentBeforeChange, insertedChars, at: now };

    // ── Bulk insertions that onDidPaste never sees ──────────────────────────
    // Not every way to dump text into the editor fires a paste event:
    // drag-and-drop from another window, and programmatic inserts, do not. If
    // classification rested on onDidPaste ALONE, those would silently become
    // "typing" — a real loss of detection, so they are caught here instead.
    //
    // The gate is PASTE_THRESHOLD (50), the same size that has always defined a
    // reportable paste. That is what makes this safe: Monaco's auto-indent,
    // bracket auto-closing and word autocomplete insert a handful of characters,
    // never fifty, so the noise this change set out to remove stays removed
    // while every forensically interesting bulk insertion is still caught.
    //
    // Undo/redo is excluded: restoring text the student already wrote is a
    // revision, not an act of authorship or of pasting.
    const isUndoRedo = Boolean(monacoEvent?.isUndoing || monacoEvent?.isRedoing);
    if (isUndoRedo) event.revision = true;
    if (insertedChars > PASTE_THRESHOLD && !isUndoRedo) {
      setTimeout(() => {
        // onDidPaste already claimed it — nothing to do.
        if (event.actionType === "paste") return;
        const insertedText = changes.map((c) => c.t).join("");
        pushSessionContent(contentBeforeChange);
        event.actionType = "paste";
        // Exact capture means the inserted text is now known even without a
        // paste event, so an internal drag-MOVE of the student's own code can
        // be recognised instead of being reported as novel. Provenance can
        // only ever suppress an alert, never create one.
        const provenance = isInternalPaste(insertedText) ? "internal" : "external";
        event.provenance = provenance;
        if (isSubmittedRef.current) return; // Immune Phase
        if (provenance === "internal") {
          debugLog(`[PASTE] internal bulk insert (+${event.charDelta} chars) — no alert`);
          return;
        }
        const payload = {
          type: "ILLEGAL_PASTE",
          studentId,
          sessionId: sessionIdRef?.current ?? null,
          timestamp: event.timestamp,
          detail: `external paste, +${event.charDelta} chars${taskLabel ? ` in ${taskLabel}` : ""}`,
        };
        debugLog("[EMIT] ILLEGAL_PASTE (no paste event — drag-drop or programmatic)", payload);
        socket.emit("alert", payload);
      }, 0);
    }

    // ── Live stream (Session 28) ────────────────────────────────────────────
    // The SAME event, also sent over the socket, so an instructor watching this
    // student sees it now instead of up to 30 seconds from now. Additive and
    // best-effort: the event above is already buffered and will flush exactly
    // as it always did, whatever happens here.
    //
    // Deferred one tick on purpose. Both paths that can reclassify this event
    // as a paste run before a timer scheduled here does — `attributePaste` from
    // Monaco's synchronous `onDidPaste`, and the bulk-insert promotion queued
    // just above (FIFO, so it is already ahead of us). Emitting inside
    // handleChange would stream a pasted block labelled "type", and watching a
    // paste arrive AS a paste is the entire investigative value of live view.
    //
    // A copy, not the event itself: the buffered object is still mutable until
    // it flushes, and the wire copy must be what was true at this moment.
    setTimeout(() => {
      if (isSubmittedRef.current) return; // Immune Phase
      emitKeystroke({ ...event });
    }, 0);

    // Tier 1 alert — AST_VIOLATION (debounced 1.5s, de-duplicated, Immune Phase guarded).
    // Only C++ buffers are parsed: running the tree-sitter C++ grammar over a
    // .txt/.csv/.dat data file would report the prose as illegal constructs and
    // fire alerts for a student doing nothing wrong.
    clearTimeout(debounceTimer.current);
    if (!isCodeBuffer) {
      onChange(next);
      return;
    }
    const codeAtKeystroke = next;
    const taskAtKeystroke = taskId;
    debounceTimer.current = setTimeout(
      () => validateFileNow(taskAtKeystroke, activeFile, codeAtKeystroke),
      1500,
    );

    onChange(next);
  }

  // ── Paste attribution (Change D) ───────────────────────────────────────────
  // The ONLY promotion path from 'type' to 'paste'. Called from onDidPaste,
  // which Monaco fires immediately after the content change the paste caused —
  // so the pending event from handleChange is the one being paid for.
  //
  // Ordering is no longer load-bearing: the old code deferred a tick because
  // the content change arrives BEFORE onDidPaste, and it needed the pasted text
  // to decide provenance. Upgrading the already-buffered event retroactively
  // works whichever order the two events arrive in, and removes the setTimeout.
  function attributePaste(pastedText) {
    const pending = lastChangeRef.current;
    if (!pending) return;
    // Only an insertion can be a paste, and only a RECENT one — a stray
    // onDidPaste must never retro-label an unrelated earlier event.
    if (pending.insertedChars <= 0) return;
    if (Date.now() - pending.at > PASTE_ATTRIBUTION_WINDOW_MS) return;

    const { event, contentBeforeChange } = pending;
    lastChangeRef.current = null; // attribute once

    event.actionType = "paste";

    // Provenance is unchanged in meaning: an INTERNAL paste is text this
    // session already contained (recorded, never alerted); an EXTERNAL paste is
    // novel. Provenance can only SUPPRESS an alert, never add one.
    pushSessionContent(contentBeforeChange);
    const provenance =
      pastedText !== null && isInternalPaste(pastedText) ? "internal" : "external";
    event.provenance = provenance;

    // Tier 1 alert — ILLEGAL_PASTE. Same size gate and same Immune Phase guard
    // as before; only the classification feeding it got more accurate.
    if (isSubmittedRef.current) return;
    if (event.charDelta <= PASTE_THRESHOLD) return;
    if (provenance === "internal") {
      debugLog(`[PASTE] internal paste (+${event.charDelta} chars) — no alert`);
      return;
    }
    const payload = {
      type: "ILLEGAL_PASTE",
      studentId,
      sessionId: sessionIdRef?.current ?? null,
      timestamp: event.timestamp,
      detail: `external paste, +${event.charDelta} chars${taskLabel ? ` in ${taskLabel}` : ""}`,
    };
    debugLog("[EMIT] ILLEGAL_PASTE", payload);
    socket.emit("alert", payload);
  }

  function handleMount(editor) {
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange(e.position.lineNumber, e.position.column);
    });
    // The single source of truth for "this was a real clipboard paste".
    // e.range is the range of the freshly-inserted text, so the model yields
    // the exact pasted string for provenance classification.
    editor.onDidPaste((e) => {
      const model = editor.getModel();
      const pastedText = model ? model.getValueInRange(e.range) : null;
      lastPastedTextRef.current = pastedText;
      attributePaste(pastedText);
    });
  }

  return (
    <div className="editor-pane">
      <div className="editor-tabs">
        {tabs.length === 0 ? (
          <div className="editor-tab active">
            <span className="tab-badge cpp">C++</span>
            main.cpp
          </div>
        ) : (
          tabs.map((tab) => (
            <button
              type="button"
              key={tab.key}
              className={`editor-tab ${tab.key === activeFile ? "active" : ""}`}
              onClick={() => onSelectFile?.(tab.key)}
              title={tab.kind === "output" ? `${tab.label} — written by your last run (read-only)` : tab.label}
            >
              <span className={`tab-badge ${tab.kind}`}>
                {tab.kind === "output" ? "OUT" : badgeOf(tab.label)}
              </span>
              {tab.label}
            </button>
          ))
        )}
      </div>
      <div className="editor-body">
        <Editor
          height="100%"
          // `path` gives each file its own Monaco model, so undo history and
          // scroll position survive switching between them. Prompt 1 qualifies
          // it by task: two tasks each have a main.cpp, and sharing one model
          // between them would splice their undo histories together and show
          // one task's text under the other's tab.
          path={taskId ? `${taskId}/${activeFile}` : activeFile}
          language={language}
          value={code}
          onChange={handleChange}
          theme="vs-dark"
          onMount={handleMount}
          options={{
            // Visually lock the editor once submitted (Session 16). The
            // Immune Phase already disarms telemetry; readOnly makes the
            // exam-over state unmistakable. `readOnly` also covers a captured
            // program-output file, which is a result, not a source buffer.
            readOnly: isSubmitted || readOnly,
            fontSize: 14,
            fontFamily: '"Cascadia Code", ui-monospace, Consolas, monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbersMinChars: 3,
            padding: { top: 10 },
            renderLineHighlight: "line",
            cursorBlinking: "smooth",
            smoothScrolling: true,
          }}
        />
      </div>
    </div>
  );
}
