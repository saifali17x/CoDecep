import { useState, useEffect, useRef, useCallback } from "react";
import TopBar from "./components/TopBar";
import EditorPane from "./components/EditorPane";
import Terminal from "./components/Terminal";
import StatusBar from "./components/StatusBar";
import PdfPane from "./components/PdfPane";
import socket from "./socket";
import { debugLog } from "./debug";
import "./App.css";

// LIVE_LAB = tab-out alerts are active. ASSESSMENT = tab-outs are ignored.
// Will come from assignment config in a future phase.
const LAB_MODE = "LIVE_LAB"; // 'LIVE_LAB' | 'ASSESSMENT'

// Exported so the DVR replay engine can use the same template as the
// initial-text anchor (display only — no behavior change).
export const DEFAULT_CODE = `#include <iostream>
using namespace std;

int main() {
    cout << "Hello, World!" << endl;
    return 0;
}
`;

const STUDENT_ID = "student-001";

// Session 21 — draggable PDF/editor split. Percent of the workspace given to
// the PDF pane, clamped so neither side becomes unusable.
const PDF_DEFAULT_PCT = 40;
const PDF_MIN_PCT = 25;
const PDF_MAX_PCT = 60;

// The tool is scoped to C++ only (see TopBar): sandboxed Judge0 execution
// reliably supports self-contained C++ programs.
const LANGUAGE = "cpp";

function App({
  sessionId: sessionIdProp,
  userId,
  assignmentId,
  labMode: labModeProp,
  studentId: studentIdProp,
  initialStatus: initialStatusProp,
  // Exam-shell props (Session 21): ExamPage passes these so the exam has ONE
  // top strip instead of a separate back-strip above the IDE.
  assignmentTitle,
  onBack,
  hasPdf = false,
} = {}) {
  // Effective values: props (real identity from ExamPage) fall back to the
  // hardcoded module consts so the propless /legacy dev flow is unchanged.
  const LAB_MODE_EFFECTIVE = labModeProp ?? LAB_MODE;
  const STUDENT_ID_EFFECTIVE = studentIdProp ?? STUDENT_ID;
  // Session 16: ExamPage passes initialStatus='SUBMITTED' when reopening an
  // already-submitted assignment — the IDE mounts locked (Immune Phase from
  // the first frame; no session create, no telemetry, no fresh submission).
  const INITIAL_STATUS = initialStatusProp ?? "IN_PROGRESS";

  const [code, setCode] = useState(DEFAULT_CODE);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [isRunning, setIsRunning] = useState(false);
  const [sessionStatus, setSessionStatus] = useState(INITIAL_STATUS);
  const [sessionId, setSessionId] = useState(null);
  // 'SUBMITTED' (fresh submit) | 'ALREADY_SUBMITTED' (reopen/re-submit) | null
  const [submitOutcome, setSubmitOutcome] = useState(
    INITIAL_STATUS === "SUBMITTED" ? "ALREADY_SUBMITTED" : null,
  );

  // Execution console state (Session 21). `consoleEvents` holds ONLY
  // execution output — program stdout/stderr, compiler messages, run status.
  // Telemetry flush traces are deliberately NOT piped here any more.
  const [consoleEvents, setConsoleEvents] = useState([]);
  const [stdin, setStdin] = useState("");

  // Split width (session-local; no need to persist across reloads).
  const [pdfPct, setPdfPct] = useState(PDF_DEFAULT_PCT);
  const workspaceRef = useRef(null);
  const draggingRef = useRef(false);

  // Refs mirror state so the stale closure inside EditorPane's setInterval
  // always reads the CURRENT value, not the value frozen at mount.
  const sessionIdRef = useRef(null);
  const sessionStatusRef = useRef(INITIAL_STATUS);
  const codeRef = useRef(DEFAULT_CODE);

  // Focus-gated timer — counts milliseconds while the tab is visible
  const engagedTimeRef = useRef(0);   // banked ms from past focus windows
  const focusStartRef = useRef(null); // Date.now() when current focus window opened

  // Keep codeRef in sync on every code change
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  // Keep sessionStatusRef in sync
  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  // Page Visibility API — disarms when submitted, uses sessionStatusRef to avoid stale closure
  useEffect(() => {
    focusStartRef.current = document.hidden ? null : Date.now();

    const handleVisibilityChange = () => {
      if (sessionStatusRef.current === "SUBMITTED") return;
      if (document.hidden) {
        // Bank engaged time
        if (focusStartRef.current !== null) {
          engagedTimeRef.current += Date.now() - focusStartRef.current;
          focusStartRef.current = null;
        }
        // Tier 1 alert — TAB_OUT (only in LIVE_LAB, never after Submit)
        if (LAB_MODE_EFFECTIVE === "LIVE_LAB") {
          const payload = {
            type: "TAB_OUT",
            studentId: STUDENT_ID_EFFECTIVE,
            sessionId: sessionIdRef.current,
            timestamp: Date.now(),
            detail: "tab lost focus",
          };
          debugLog("[EMIT] TAB_OUT", payload);
          socket.emit("alert", payload);
        }
      } else {
        focusStartRef.current = Date.now();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Create (or resume) the session on mount.
  // If a sessionId prop is supplied (ExamPage already created the session with
  // real identity), use it directly and do NOT hit /api/session/create.
  // Otherwise keep the exact legacy behavior (self-create for student-001).
  useEffect(() => {
    if (sessionIdProp) {
      setSessionId(sessionIdProp);
      sessionIdRef.current = sessionIdProp;
      return;
    }
    fetch("http://localhost:3001/api/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: STUDENT_ID_EFFECTIVE }),
    })
      .then((r) => r.json())
      .then((data) => {
        setSessionId(data.sessionId);
        sessionIdRef.current = data.sessionId; // ← keep ref in sync for the flush
      })
      .catch((err) =>
        console.error("[SESSION] Failed to create session:", err),
      );
  }, []);

  // ── Draggable divider ─────────────────────────────────────────────────────
  const handleDividerMove = useCallback((clientX) => {
    const el = workspaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPdfPct(Math.min(PDF_MAX_PCT, Math.max(PDF_MIN_PCT, pct)));
  }, []);

  useEffect(() => {
    function onMove(e) {
      if (!draggingRef.current) return;
      e.preventDefault();
      handleDividerMove(e.clientX);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove("is-splitting");
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [handleDividerMove]);

  function startDrag(e) {
    e.preventDefault();
    draggingRef.current = true;
    document.body.classList.add("is-splitting");
  }

  function handleSubmit() {
    setSessionStatus("SUBMITTED");
    sessionStatusRef.current = "SUBMITTED"; // ← disarm the flush immediately
    setSubmitOutcome("SUBMITTED"); // optimistic; refined by the server response
    const id = sessionIdRef.current;
    if (id) {
      fetch(`http://localhost:3001/api/session/${id}/submit`, {
        method: "POST",
      })
        .then((r) => r.json())
        .then((data) => {
          // Distinguish a real submission from an idempotency hit so the
          // student never thinks a fresh submission happened when it didn't.
          if (data?.status === "ALREADY_SUBMITTED") {
            setSubmitOutcome("ALREADY_SUBMITTED");
          }
        })
        .catch((err) =>
          console.error("[SUBMIT] Failed to notify server:", err),
        );
    }
  }

  async function handleFlush(chunk) {
    // Read live values from refs, NOT the captured state, to avoid the
    // stale-closure bug (the interval was created at mount when these were null).
    const currentStatus = sessionStatusRef.current;
    const currentSessionId = sessionIdRef.current;
    const currentCode = codeRef.current;

    if (currentStatus === "SUBMITTED") return;
    if (!currentSessionId) return;

    // Banked time + time accrued in the current (still-open) focus window
    const engagedTimeMs =
      engagedTimeRef.current +
      (focusStartRef.current !== null ? Date.now() - focusStartRef.current : 0);

    try {
      const res = await fetch("http://localhost:3001/api/telemetry/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: currentSessionId,
          studentId: STUDENT_ID_EFFECTIVE,
          chunk,
          codeSnapshot: currentCode,
          engagedTimeMs,
        }),
      });
      const data = await res.json();
      // Flush results are DEBUG-ONLY — they must never reach the student's
      // console (that leakage was the old terminal's problem).
      if (res.status === 202) {
        debugLog(`[FLUSH] ${data.accepted} event(s) accepted — 202`);
      } else {
        debugLog(`[FLUSH] server rejected payload — HTTP ${res.status}`);
      }
    } catch (err) {
      debugLog(`[FLUSH] network error — ${err.message}`);
    }
  }

  function pushConsole(entries) {
    setConsoleEvents((prev) => [...prev, ...entries]);
  }

  async function handleRun() {
    setIsRunning(true);
    // Clear-on-run so repeated runs stay readable.
    setConsoleEvents([
      { kind: "cmd", text: "$ g++ main.cpp -o main && ./main" },
      ...(stdin.trim().length > 0
        ? [{ kind: "meta", text: `[stdin] ${stdin.split("\n").length} line(s) provided` }]
        : [{ kind: "meta", text: "[stdin] none provided" }]),
    ]);
    try {
      const res = await fetch("http://localhost:3001/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          lang: LANGUAGE,
          stdin,
          sessionId: sessionIdRef.current,
        }),
      });
      const data = await res.json();

      const entries = [];
      if (data.compileOutput) {
        entries.push({ kind: "compile", text: data.compileOutput.trimEnd() });
      }
      if (data.stdout) {
        entries.push({ kind: "stdout", text: data.stdout.replace(/\n$/, "") });
      }
      if (data.stderr) {
        entries.push({ kind: "stderr", text: data.stderr.trimEnd() });
      }
      if (data.message) {
        entries.push({ kind: "stderr", text: data.message.trimEnd() });
      }
      // Older/error shapes only carry `output`.
      if (entries.length === 0 && data.output) {
        entries.push({ kind: "stdout", text: String(data.output).trimEnd() });
      }
      if (entries.length === 0) {
        entries.push({ kind: "meta", text: "(no output)" });
      }

      const statusText = data.status ?? "Finished";
      const meta = [
        data.exitCode !== null && data.exitCode !== undefined ? `exit ${data.exitCode}` : null,
        data.time ? `${data.time}s` : null,
        data.memory ? `${data.memory} KB` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      entries.push({
        kind: statusText === "Accepted" ? "ok" : "stderr",
        text: `— ${statusText}${meta ? ` (${meta})` : ""}`,
      });
      pushConsole(entries);
    } catch (err) {
      pushConsole([{ kind: "stderr", text: `Network error — ${err.message}` }]);
    } finally {
      setIsRunning(false);
    }
  }

  const isSubmitted = sessionStatus === "SUBMITTED";
  // The divider only exists when there IS a PDF — no empty pane otherwise.
  const showPdf = Boolean(hasPdf && assignmentId);

  return (
    <div className="app">
      <TopBar
        onRun={handleRun}
        isRunning={isRunning}
        onSubmit={handleSubmit}
        isSubmitted={isSubmitted}
        onBack={onBack}
        title={assignmentTitle}
        labMode={assignmentTitle ? LAB_MODE_EFFECTIVE : undefined}
      />
      {isSubmitted && (
        <div className={`submit-banner ${submitOutcome === "ALREADY_SUBMITTED" ? "already" : "fresh"}`}>
          {submitOutcome === "ALREADY_SUBMITTED"
            ? "This assignment has already been submitted. The editor is locked."
            : "✓ Submitted successfully. You may now safely close this tab or return to your class."}
        </div>
      )}
      <div
        className={`workspace ${showPdf ? "has-pdf" : ""}`}
        ref={workspaceRef}
        style={showPdf ? { "--pdf-width": `${pdfPct}%` } : undefined}
      >
        {showPdf && (
          <>
            <div className="pdf-column">
              <PdfPane assignmentId={assignmentId} />
            </div>
            <div
              className="split-divider"
              onPointerDown={startDrag}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize assignment pane"
              title="Drag to resize"
            />
          </>
        )}
        <div className="main-content">
          <EditorPane
            code={code}
            language={LANGUAGE}
            onChange={setCode}
            onCursorChange={(line, col) => setCursor({ line, col })}
            onFlush={handleFlush}
            isSubmitted={isSubmitted}
            studentId={STUDENT_ID_EFFECTIVE}
            sessionIdRef={sessionIdRef}
            labMode={LAB_MODE_EFFECTIVE}
            assignmentId={assignmentId}
          />
          <Terminal
            events={consoleEvents}
            stdin={stdin}
            onStdinChange={setStdin}
            onClear={() => setConsoleEvents([])}
            running={isRunning}
            disabled={isSubmitted}
          />
        </div>
      </div>
      <StatusBar language={LANGUAGE} line={cursor.line} col={cursor.col} />
    </div>
  );
}

export default App;
