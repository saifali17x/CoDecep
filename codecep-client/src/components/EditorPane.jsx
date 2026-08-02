import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import socket from "../socket";
import { debugLog } from "../debug";
import { badgeOf, kindOf } from "../lib/workspace";
import "./EditorPane.css";

const PASTE_THRESHOLD = 50; // charDelta > 50 triggers ILLEGAL_PASTE (per CLAUDE.md)
const CONTENT_HISTORY_LIMIT = 50; // bounded rolling history of session content

function classifyAction(delta) {
  if (delta < 0) return "delete";
  if (delta > 4) return "paste";
  return "type";
}

// Whitespace-insensitive comparison so trivial formatting differences don't
// misclassify an internal re-paste as external.
function normalizeContent(text) {
  return text.replace(/\s+/g, " ").trim();
}

export default function EditorPane({
  code,
  language,
  onChange,
  onCursorChange,
  onFlush,
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
  useEffect(() => {
    prevCode.current = code;
    lastKeystrokeTime.current = Date.now();
    // Intentionally keyed on the FILE, not the code: re-anchoring on every
    // keystroke would zero out every charDelta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  // Paste provenance (internal vs external) — session-local content history.
  // We compare pasted text against what THIS session has already contained;
  // we never try to read the OS clipboard's origin.
  const lastPastedTextRef = useRef(null); // set by Monaco onDidPaste, consumed once
  const sessionContentRef = useRef([]); // normalized full-content snapshots

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

  // AST_VIOLATION debounce state
  const debounceTimer = useRef(null);
  const lastViolationSig = useRef(null); // "nodeType:line" — prevents alert spam
  const isSubmittedRef = useRef(isSubmitted); // live mirror for async timeout callbacks

  useEffect(() => {
    isSubmittedRef.current = isSubmitted;
    if (isSubmitted) {
      // Disarm any pending debounce immediately on Submit (Immune Phase)
      clearTimeout(debounceTimer.current);
      lastViolationSig.current = null;
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

  const isCodeBuffer = activeFile ? kindOf(activeFile) === "code" : true;

  function handleChange(val) {
    const next = val ?? "";
    const now = Date.now();
    const timeSinceLastKeystrokeMs = now - lastKeystrokeTime.current;
    lastKeystrokeTime.current = now;

    const contentBeforeChange = prevCode.current;
    const charDelta = next.length - contentBeforeChange.length;
    const actionType = classifyAction(charDelta);
    prevCode.current = next;

    const event = {
      timestamp: now,
      timeSinceLastKeystrokeMs,
      actionType,
      charDelta,
      textLength: next.length,
    };
    telemetryBuffer.current.push(event);

    // Tier 1 alert — ILLEGAL_PASTE (both modes; guard against Submit).
    // Provenance-aware: an INTERNAL paste (text the session already contained)
    // is recorded in telemetry but never alerts; only EXTERNAL (novel) pastes
    // fire. Provenance can only SUPPRESS a would-be alert, never add one.
    if (!isSubmitted && actionType === "paste" && charDelta > PASTE_THRESHOLD) {
      // The pre-paste content is legitimate session history — bank it now so
      // re-pasting something typed earlier is recognized as internal.
      pushSessionContent(contentBeforeChange);
      // Monaco fires the content-change event (this handler) BEFORE onDidPaste,
      // so defer one tick to let onDidPaste record the pasted text first.
      setTimeout(() => {
        if (isSubmittedRef.current) return; // Immune Phase still wins
        const pastedText = lastPastedTextRef.current;
        lastPastedTextRef.current = null; // consume once
        // No paste-event text (drag-drop, programmatic insert) → treat as
        // external — the safer default, identical to the old behavior.
        const provenance =
          pastedText !== null && isInternalPaste(pastedText) ? "internal" : "external";
        event.provenance = provenance; // tagged in telemetry either way

        if (provenance === "internal") {
          debugLog(`[PASTE] internal paste (+${charDelta} chars) — no alert`);
          return;
        }
        const payload = {
          type: "ILLEGAL_PASTE",
          studentId,
          sessionId: sessionIdRef?.current ?? null,
          timestamp: now,
          detail: `external paste, +${charDelta} chars`,
        };
        debugLog("[EMIT] ILLEGAL_PASTE", payload);
        socket.emit("alert", payload);
      }, 0);
    }

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
    debounceTimer.current = setTimeout(async () => {
      if (isSubmittedRef.current) return;
      try {
        const res = await fetch("http://localhost:3001/api/ast/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: codeAtKeystroke, ...(assignmentId ? { assignmentId } : {}) }),
        });
        const { isValid, violations } = await res.json();
        if (!isValid && violations.length > 0) {
          const sig = `${violations[0].nodeType}:${violations[0].line}`;
          if (sig !== lastViolationSig.current) {
            lastViolationSig.current = sig;
            const payload = {
              type: "AST_VIOLATION",
              studentId,
              sessionId: sessionIdRef?.current ?? null,
              timestamp: Date.now(),
              detail: `${violations.length} violation(s): ${violations[0]?.nodeType ?? "unknown"}`,
            };
            debugLog("[EMIT] AST_VIOLATION", payload);
            socket.emit("alert", payload);
          }
        } else {
          // Code is now valid — reset so next violation triggers a fresh alert
          lastViolationSig.current = null;
        }
      } catch {
        // Silently swallow — do not emit on network/API errors
      }
    }, 1500);

    onChange(next);
  }

  function handleMount(editor) {
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange(e.position.lineNumber, e.position.column);
    });
    // Capture the actual pasted text (not just its size) for provenance
    // classification. e.range is the range of the freshly-inserted text.
    editor.onDidPaste((e) => {
      const model = editor.getModel();
      if (model) lastPastedTextRef.current = model.getValueInRange(e.range);
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
          // scroll position survive switching between them.
          path={activeFile}
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
