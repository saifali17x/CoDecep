import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import socket from "../socket";
import "./EditorPane.css";

const PASTE_THRESHOLD = 50; // charDelta > 50 triggers ILLEGAL_PASTE (per CLAUDE.md)

function classifyAction(delta) {
  if (delta < 0) return "delete";
  if (delta > 4) return "paste";
  return "type";
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
}) {
  const lastKeystrokeTime = useRef(Date.now());
  const prevCode = useRef(code);
  const telemetryBuffer = useRef([]);

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
      if (telemetryBuffer.current.length === 0) return;
      const payloadToFlush = [...telemetryBuffer.current];
      telemetryBuffer.current = [];
      onFlush(payloadToFlush);
    }, 30_000);
    return () => clearInterval(id);
  }, [isSubmitted]);

  function handleChange(val) {
    const next = val ?? "";
    const now = Date.now();
    const timeSinceLastKeystrokeMs = now - lastKeystrokeTime.current;
    lastKeystrokeTime.current = now;

    const charDelta = next.length - prevCode.current.length;
    const actionType = classifyAction(charDelta);
    prevCode.current = next;

    telemetryBuffer.current.push({
      timestamp: now,
      timeSinceLastKeystrokeMs,
      actionType,
      charDelta,
      textLength: next.length,
    });

    // Tier 1 alert — ILLEGAL_PASTE (both modes; guard against Submit)
    if (!isSubmitted && actionType === "paste" && charDelta > PASTE_THRESHOLD) {
      const payload = {
        type: "ILLEGAL_PASTE",
        studentId,
        sessionId: sessionIdRef?.current ?? null,
        timestamp: now,
        detail: `charDelta: +${charDelta}`,
      };
      console.log("[EMIT] ILLEGAL_PASTE", payload);
      socket.emit("alert", payload);
    }

    // Tier 1 alert — AST_VIOLATION (debounced 1.5s, de-duplicated, Immune Phase guarded)
    clearTimeout(debounceTimer.current);
    const codeAtKeystroke = next;
    debounceTimer.current = setTimeout(async () => {
      if (isSubmittedRef.current) return;
      try {
        const res = await fetch("http://localhost:3001/api/ast/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: codeAtKeystroke }),
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
            console.log("[EMIT] AST_VIOLATION", payload);
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
  }

  return (
    <div className="editor-pane">
      <div className="editor-tabs">
        <div className="editor-tab active">
          <span className="tab-badge cpp">C</span>
          main.cpp
          <span className="tab-close">&#215;</span>
        </div>
      </div>
      <div className="editor-body">
        <Editor
          height="100%"
          language={language}
          value={code}
          onChange={handleChange}
          theme="vs-dark"
          onMount={handleMount}
          options={{
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
