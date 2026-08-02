import { useState, useEffect, useRef, useCallback } from "react";
import TopBar from "./components/TopBar";
import EditorPane from "./components/EditorPane";
import Terminal from "./components/Terminal";
import StatusBar from "./components/StatusBar";
import PdfPane from "./components/PdfPane";
import FilePanel from "./components/FilePanel";
import socket from "./socket";
import { debugLog } from "./debug";
import {
  ENTRY_FILE,
  createWorkspace,
  kindOf,
  languageOf,
  outputKey,
  outputNameOf,
  sortFiles,
} from "./lib/workspace";
import "./App.css";

// LIVE_LAB = tab-out alerts are active. ASSESSMENT = tab-outs are ignored.
// Will come from assignment config in a future phase.
const LAB_MODE = "LIVE_LAB"; // 'LIVE_LAB' | 'ASSESSMENT'

// Dev-only starter template for the propless /legacy flow. A REAL exam starts
// blank (ExamPage passes initialCode="") so every character of the submitted
// program is accounted for as either typed or pasted — pre-written boilerplate
// belongs to neither, and would silently inflate the authorship denominator.
// Still exported so the DVR replay engine can use it as the initial-text
// anchor for legacy sessions (display only — no behavior change).
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

// The build the student is shown in the console — it matches the compile step
// the server writes into the Judge0 archive (see lib/multiFile.ts).
const BUILD_COMMAND = "$ g++ -std=c++17 -o main *.cpp && ./main";

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
  // Starting editor contents. A real exam passes "" (blank start); the
  // propless /legacy dev flow keeps the small template.
  initialCode = DEFAULT_CODE,
} = {}) {
  // Effective values: props (real identity from ExamPage) fall back to the
  // hardcoded module consts so the propless /legacy dev flow is unchanged.
  const LAB_MODE_EFFECTIVE = labModeProp ?? LAB_MODE;
  const STUDENT_ID_EFFECTIVE = studentIdProp ?? STUDENT_ID;
  // Session 16: ExamPage passes initialStatus='SUBMITTED' when reopening an
  // already-submitted assignment — the IDE mounts locked (Immune Phase from
  // the first frame; no session create, no telemetry, no fresh submission).
  const INITIAL_STATUS = initialStatusProp ?? "IN_PROGRESS";

  // ── Multi-file workspace (Session 23) ──────────────────────────────────────
  // The exam is a set of files, not one buffer: .cpp/.h are compiled together
  // by `g++ *.cpp`, and .txt/.csv/.dat sit in the sandbox working directory for
  // fstream. `outputFiles` holds what the LAST run wrote — read-only results,
  // replaced on every run, never part of what gets compiled.
  const [files, setFiles] = useState(() => createWorkspace(initialCode));
  const [activeFile, setActiveFile] = useState(ENTRY_FILE);
  const [outputFiles, setOutputFiles] = useState([]);

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

  // ── Active buffer ─────────────────────────────────────────────────────────
  // `activeFile` is either a workspace file name or an output key
  // ("output:out.txt"). Everything the editor needs is derived from it, so
  // there is exactly one source of truth for what is on screen.
  const activeOutputName = outputNameOf(activeFile);
  const activeOutput = activeOutputName
    ? outputFiles.find((f) => f.name === activeOutputName) ?? null
    : null;
  const activeWorkspaceFile = files.find((f) => f.name === activeFile) ?? null;
  const code = activeOutput ? activeOutput.content : activeWorkspaceFile?.content ?? "";
  const activeLanguage = languageOf(activeOutputName ?? activeFile);
  const isOutputBuffer = activeOutput !== null;

  // Refs mirror state so the stale closure inside EditorPane's setInterval
  // always reads the CURRENT value, not the value frozen at mount.
  const sessionIdRef = useRef(null);
  const sessionStatusRef = useRef(INITIAL_STATUS);
  const codeRef = useRef(initialCode);

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

  // ── Workspace file management ─────────────────────────────────────────────
  // Every mutation is a no-op once submitted: the Immune Phase means the
  // submitted artifact cannot change, and that has to include the file set,
  // not just the text inside main.cpp.
  function handleEditorChange(next) {
    if (isOutputBuffer) return; // captured results are read-only
    setFiles((prev) =>
      prev.map((f) => (f.name === activeFile ? { ...f, content: next } : f)),
    );
  }

  function handleCreateFile(name) {
    if (isSubmittedRefSafe()) return;
    setFiles((prev) => [...prev, { name, content: "" }]);
    setActiveFile(name);
  }

  function handleRenameFile(oldName, newName) {
    if (isSubmittedRefSafe() || oldName === newName) return;
    setFiles((prev) =>
      prev.map((f) => (f.name === oldName ? { ...f, name: newName } : f)),
    );
    setActiveFile((current) => (current === oldName ? newName : current));
  }

  function handleDeleteFile(name) {
    // main.cpp is the entry point for `g++ *.cpp -o main` — without it there is
    // nothing to link. The panel disables its delete button; this is the guard
    // behind it.
    if (isSubmittedRefSafe() || name === ENTRY_FILE) return;
    setFiles((prev) => prev.filter((f) => f.name !== name));
    setActiveFile((current) => (current === name ? ENTRY_FILE : current));
  }

  function isSubmittedRefSafe() {
    return sessionStatusRef.current === "SUBMITTED";
  }

  async function handleRun() {
    setIsRunning(true);
    // Results from the previous run are stale the moment a new one starts.
    setOutputFiles([]);
    if (outputNameOf(activeFile)) setActiveFile(ENTRY_FILE);
    const sourceCount = files.filter((f) => kindOf(f.name) === "code").length;
    const dataCount = files.length - sourceCount;
    // Clear-on-run so repeated runs stay readable.
    setConsoleEvents([
      { kind: "cmd", text: BUILD_COMMAND },
      {
        kind: "meta",
        text:
          `[build] ${sourceCount} source file(s)` +
          (dataCount > 0 ? `, ${dataCount} data file(s) in the working directory` : ""),
      },
      ...(stdin.trim().length > 0
        ? [{ kind: "meta", text: `[stdin] ${stdin.split("\n").length} line(s) provided` }]
        : [{ kind: "meta", text: "[stdin] none provided" }]),
    ]);
    try {
      const res = await fetch("http://localhost:3001/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The whole workspace goes up; the server packages it for Judge0's
          // multi-file language. `code` is still sent so an older server (or
          // the legacy path) keeps working.
          files,
          code,
          lang: LANGUAGE,
          stdin,
          sessionId: sessionIdRef.current,
        }),
      });
      const data = await res.json();

      const entries = [];
      // A rejected workspace (bad name, too many files) comes back as a plain
      // error — surface it instead of falling through to "(no output)".
      if (!res.ok && data.error) {
        pushConsole([{ kind: "stderr", text: data.error }]);
        return;
      }
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

      // Files the program wrote. Their CONTENT goes to the file panel, not the
      // console — dumping a data file into the terminal buries the program's
      // own output. The console just says what was captured and where it went.
      const written = Array.isArray(data.outputFiles) ? data.outputFiles : [];
      setOutputFiles(written);
      if (written.length > 0) {
        entries.push({
          kind: "meta",
          text:
            `[files] wrote ${written.map((f) => `${f.name} (${f.bytes}B)`).join(", ")}` +
            ` — open under "Program output" in the file panel`,
        });
        for (const file of written.filter((f) => f.truncated)) {
          entries.push({
            kind: "meta",
            text: `[files] ${file.name} is larger than the 64 KB preview limit — showing the first 64 KB`,
          });
        }
      }
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

  // Tabs mirror the workspace, plus the one output file being previewed (they
  // are transient results, so they don't all earn a permanent tab).
  const tabs = [
    ...sortFiles(files).map((f) => ({ key: f.name, label: f.name, kind: kindOf(f.name) })),
    ...(activeOutput
      ? [{ key: outputKey(activeOutput.name), label: activeOutput.name, kind: "output" }]
      : []),
  ];

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
          <div className="editor-row">
            <FilePanel
              files={files}
              activeFile={activeFile}
              outputFiles={outputFiles}
              onSelect={setActiveFile}
              onCreate={handleCreateFile}
              onRename={handleRenameFile}
              onDelete={handleDeleteFile}
              readOnly={isSubmitted}
            />
            <EditorPane
              code={code}
              language={activeLanguage}
              onChange={handleEditorChange}
              onCursorChange={(line, col) => setCursor({ line, col })}
              onFlush={handleFlush}
              isSubmitted={isSubmitted}
              studentId={STUDENT_ID_EFFECTIVE}
              sessionIdRef={sessionIdRef}
              labMode={LAB_MODE_EFFECTIVE}
              assignmentId={assignmentId}
              tabs={tabs}
              activeFile={activeFile}
              onSelectFile={setActiveFile}
              readOnly={isOutputBuffer}
            />
          </div>
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
