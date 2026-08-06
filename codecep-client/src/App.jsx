import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import TopBar from "./components/TopBar";
import EditorPane from "./components/EditorPane";
import Terminal from "./components/Terminal";
import StatusBar from "./components/StatusBar";
import PdfPane from "./components/PdfPane";
import FilePanel from "./components/FilePanel";
import socket from "./socket";
import { debugLog } from "./debug";
import * as liveStream from "./lib/liveStream";
import {
  ENTRY_FILE,
  createWorkspace,
  kindOf,
  languageOf,
  makeTaskIds,
  outputKey,
  outputNameOf,
  sortFiles,
  taskLabel,
} from "./lib/workspace";
import "./App.css";

// LIVE_LAB = tab-out alerts are active. ASSESSMENT = tab-outs are ignored.
// Will come from assignment config in a future phase.
const LAB_MODE = "LIVE_LAB"; // 'LIVE_LAB' | 'ASSESSMENT'

// Session 25 — there is no starter template ANYWHERE any more, not even for
// /legacy. Every flow now opens an empty main.cpp, so every character of the
// submitted program is accounted for as either typed or pasted; pre-written
// boilerplate belongs to neither and silently inflated the authorship
// denominator. The old `DEFAULT_CODE` export is gone: nothing consumed it (the
// DVR replay anchor became "" in Session 22), so keeping a second starting
// state alive only invited the two flows to drift apart.

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
  // Starting editor contents. Blank in every flow (see above); the prop is
  // kept so a caller could seed a buffer deliberately, but nothing does.
  initialCode = "",
  // Multi-task exams (Prompt 1). How many questions this exam has; each gets
  // its own file workspace behind its own tab. 1 (the default, and every
  // pre-multi-task assignment) is the single-workspace exam as it was.
  taskCount = 1,
} = {}) {
  // Effective values: props (real identity from ExamPage) fall back to the
  // hardcoded module consts so the propless /legacy dev flow is unchanged.
  const LAB_MODE_EFFECTIVE = labModeProp ?? LAB_MODE;
  const STUDENT_ID_EFFECTIVE = studentIdProp ?? STUDENT_ID;
  // Session 16: ExamPage passes initialStatus='SUBMITTED' when reopening an
  // already-submitted assignment — the IDE mounts locked (Immune Phase from
  // the first frame; no session create, no telemetry, no fresh submission).
  const INITIAL_STATUS = initialStatusProp ?? "IN_PROGRESS";

  // ── Multi-file workspace (Session 23), per TASK (Prompt 1) ─────────────────
  // The exam is a set of files, not one buffer: .cpp/.h are compiled together
  // by `g++ *.cpp`, and .txt/.csv/.dat sit in the sandbox working directory for
  // fstream. `outputFiles` holds what the LAST run wrote — read-only results,
  // replaced on every run, never part of what gets compiled.
  //
  // Multi-task exams multiply that whole picture: each task is a SEPARATE
  // program with its own files, its own run and its own console. Holding one
  // state object per task (rather than five parallel maps) keeps "everything
  // that belongs to Task 2" in one place, so switching tasks is a single
  // lookup and nothing can drift out of step.
  const taskIds = useMemo(() => makeTaskIds(taskCount), [taskCount]);
  const isMultiTask = taskIds.length > 1;
  const [tasks, setTasks] = useState(() =>
    Object.fromEntries(
      makeTaskIds(taskCount).map((id) => [
        id,
        {
          files: createWorkspace(initialCode),
          activeFile: ENTRY_FILE,
          outputFiles: [],
          consoleEvents: [],
          stdin: "",
        },
      ]),
    ),
  );
  const [activeTask, setActiveTask] = useState(taskIds[0]);

  // Everything on screen belongs to the ACTIVE task. Derived, never duplicated,
  // for the same reason the active buffer is derived from `files`: one source
  // of truth for what the student is looking at.
  const current = tasks[activeTask] ?? tasks[taskIds[0]];
  const files = current.files;
  const activeFile = current.activeFile;
  const outputFiles = current.outputFiles;
  const consoleEvents = current.consoleEvents;
  const stdin = current.stdin;

  // Patch one task's slice. `patch` may be an object or a function of the
  // task's current state.
  const patchTask = useCallback((taskId, patch) => {
    setTasks((prev) => {
      const before = prev[taskId];
      if (!before) return prev;
      const next = typeof patch === "function" ? patch(before) : patch;
      return { ...prev, [taskId]: { ...before, ...next } };
    });
  }, []);

  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [isRunning, setIsRunning] = useState(false);
  // The brief window between clicking Submit and the disarm, during which the
  // final flush is in flight (see handleSubmit).
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionStatus, setSessionStatus] = useState(INITIAL_STATUS);
  const [sessionId, setSessionId] = useState(null);
  // 'SUBMITTED' (fresh submit) | 'ALREADY_SUBMITTED' (reopen/re-submit) | null
  const [submitOutcome, setSubmitOutcome] = useState(
    INITIAL_STATUS === "SUBMITTED" ? "ALREADY_SUBMITTED" : null,
  );

  // Execution console state (Session 21) now lives per task (see `tasks`
  // above): it holds ONLY execution output — program stdout/stderr, compiler
  // messages, run status — and Task 1's output must never appear under Task 2.
  // Telemetry flush traces are deliberately NOT piped here at all.

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
  // Prompt 1: the flush needs EVERY task's workspace (not just the active
  // one), and the active task id to label the snapshot it is anchored on.
  const tasksRef = useRef(tasks);
  const activeTaskRef = useRef(activeTask);

  // Session 25 — final pre-disarm flush. The telemetry buffer lives inside
  // EditorPane (only it sees keystrokes), so it hands back a drain-and-send
  // handle here; handleSubmit awaits it before anything else happens.
  const flushNowRef = useRef(null);
  // Submit is now asynchronous, which opens a gap where the button is still
  // live. This makes the whole sequence one-shot: no double flush, no second
  // forensics enqueue.
  const submitInFlightRef = useRef(false);

  // Focus-gated timer — counts milliseconds while the tab is visible
  const engagedTimeRef = useRef(0);   // banked ms from past focus windows
  const focusStartRef = useRef(null); // Date.now() when current focus window opened

  // Keep codeRef in sync on every code change
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  // Session 24 — the flush needs EVERY file, not just the active buffer, and
  // it runs from a stale-closure interval, so the workspace is mirrored into a
  // ref exactly as `code` is. Prompt 1 widens that to every task.
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    activeTaskRef.current = activeTask;
  }, [activeTask]);

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

  // ── Live DVR: join this session's room (Session 28) ───────────────────────
  // Joining is not streaming. The student sits in the room for the whole exam
  // and emits nothing until an instructor actually opens them, at which point
  // the server sends `live:start` and this module drains the buffer to close
  // the seam before the first live keystroke goes out (see lib/liveStream.js).
  // A session that mounts already SUBMITTED never attaches at all.
  useEffect(() => {
    if (!sessionId) return undefined;
    if (sessionStatusRef.current === "SUBMITTED") return undefined;
    liveStream.attach(sessionId, () => flushNowRef.current?.());
    return () => liveStream.stop();
  }, [sessionId]);

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

  // ── Submit: flush → await → disarm → enqueue (Session 25) ──────────────────
  // Telemetry flushes every 30s, so up to 30s of the student's FINAL keystrokes
  // used to die with the interval — often the most forensically interesting
  // moment (a last-second paste or panic edit), and the forensics worker then
  // analysed data that was missing that window.
  //
  // The fix is ONE extra flush, performed BEFORE the disarm and awaited, so the
  // BullMQ job the server enqueues cannot race ahead of the data it reads.
  // Immune Phase semantics are unchanged: it still fires instantly and
  // synchronously once reached, and nothing after it emits telemetry or alerts.
  // This is a one-time pre-disarm step, not ongoing post-submit capture.
  async function handleSubmit() {
    // One-shot. A reopened-already-submitted session (initialStatus=SUBMITTED)
    // never reaches the flush or the enqueue either — the server's own
    // idempotency stays the backstop, not the first line of defence.
    if (submitInFlightRef.current) return;
    if (sessionStatusRef.current === "SUBMITTED") return;
    submitInFlightRef.current = true;
    setIsSubmitting(true);

    // 1. FINAL FLUSH — still IN_PROGRESS here, so the normal flush path runs
    //    unchanged (same payload shape as the 30s flush: buffered events + the
    //    final per-file snapshots). Best-effort: a flaky network must never
    //    trap a student mid-submit, so a failure is logged and we continue.
    try {
      const flushed = await flushNowRef.current?.();
      if (flushed === true) {
        debugLog("[SUBMIT] final keystroke window flushed");
      } else if (flushed === false) {
        console.warn("[SUBMIT] final flush did not persist — submitting anyway");
      } else {
        debugLog("[SUBMIT] no buffered keystrokes — nothing to flush");
      }
    } catch (err) {
      console.warn("[SUBMIT] final flush threw — submitting anyway:", err?.message ?? err);
    }

    // 2. DISARM — the Immune Phase, exactly as before. Live streaming disarms
    //    here alongside the heartbeat and the visibility listeners: an
    //    instructor watching sees the stream end, and the server's submit route
    //    tells them so explicitly so their DVR settles onto the final recorded
    //    session rather than a live view that quietly stops moving.
    liveStream.stop();
    setSessionStatus("SUBMITTED");
    sessionStatusRef.current = "SUBMITTED";
    setSubmitOutcome("SUBMITTED"); // optimistic; refined by the server response

    // 3. ENQUEUE FORENSICS — the server flips the row to SUBMITTED and adds the
    //    BullMQ job, which now reads a complete playback_log.
    const id = sessionIdRef.current;
    if (id) {
      try {
        const res = await fetch(`http://localhost:3001/api/session/${id}/submit`, {
          method: "POST",
        });
        const data = await res.json();
        // Distinguish a real submission from an idempotency hit so the
        // student never thinks a fresh submission happened when it didn't.
        if (data?.status === "ALREADY_SUBMITTED") {
          setSubmitOutcome("ALREADY_SUBMITTED");
        }
      } catch (err) {
        console.error("[SUBMIT] Failed to notify server:", err);
      }
    }
    setIsSubmitting(false);
  }

  async function handleFlush(chunk) {
    // Read live values from refs, NOT the captured state, to avoid the
    // stale-closure bug (the interval was created at mount when these were null).
    const currentStatus = sessionStatusRef.current;
    const currentSessionId = sessionIdRef.current;
    const currentCode = codeRef.current;
    const currentTasks = tasksRef.current ?? {};
    const currentTaskId = activeTaskRef.current;
    const currentFiles = currentTasks[currentTaskId]?.files ?? [];

    // Returns true only when the server actually accepted the chunk, so the
    // submit path can tell "persisted" from "lost to a network blip".
    if (currentStatus === "SUBMITTED") return false;
    if (!currentSessionId) return false;

    // Per-file snapshots (Session 24). The single `codeSnapshot` below is the
    // ACTIVE buffer only, which made the authorship denominator and the DVR
    // follow whichever file happened to be open. `fileSnapshots` is the whole
    // workspace and is the source of truth going forward; `codeSnapshot` is
    // kept so pre-v2 readers (and the legacy /playback route) still work.
    const fileSnapshots = Object.fromEntries(
      currentFiles.map((f) => [f.name, f.content]),
    );

    // Per-TASK snapshots (Prompt 1) — every task's workspace, not just the
    // active one. `fileSnapshots` above keeps its existing meaning (the active
    // task's files) so no existing reader changes; this is what lets forensics
    // recover the final program of a task the student left an hour ago and
    // never came back to.
    const taskSnapshots = Object.fromEntries(
      Object.entries(currentTasks).map(([taskId, task]) => [
        taskId,
        Object.fromEntries((task.files ?? []).map((f) => [f.name, f.content])),
      ]),
    );

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
          fileSnapshots,
          taskSnapshots,
          engagedTimeMs,
        }),
      });
      const data = await res.json();
      // Flush results are DEBUG-ONLY — they must never reach the student's
      // console (that leakage was the old terminal's problem).
      if (res.status === 202) {
        debugLog(`[FLUSH] ${data.accepted} event(s) accepted — 202`);
        // A watching instructor can now re-read the durable record and retire
        // the matching events from their live tail (Session 28). No-op when
        // nobody is watching.
        liveStream.notifyFlushed();
        return true;
      }
      debugLog(`[FLUSH] server rejected payload — HTTP ${res.status}`);
      return false;
    } catch (err) {
      debugLog(`[FLUSH] network error — ${err.message}`);
      return false;
    }
  }

  function pushConsole(taskId, entries) {
    patchTask(taskId, (t) => ({ consoleEvents: [...t.consoleEvents, ...entries] }));
  }

  // ── Task switch: FLUSH FIRST (Prompt 1) ────────────────────────────────────
  // Telemetry buffers in EditorPane and only drains every 30s (or on submit).
  // Without this, a student who types in Task 1, switches to Task 2 and never
  // returns would have their Task 1 buffer still sitting unsent when Submit
  // drained only the ACTIVE task — those keystrokes would be stranded and the
  // forensics worker would judge Task 1 on data it never received.
  //
  // The drain happens while the outgoing task is still active, so the events
  // (already tagged with their own taskId at capture time) and the snapshot the
  // flush is anchored on both describe the task being left. Best-effort, for
  // the same reason the submit flush is: a flaky network must never block a
  // student from moving between questions mid-exam.
  async function handleSelectTask(taskId) {
    if (taskId === activeTask || !tasks[taskId]) return;
    if (!isSubmittedRefSafe()) {
      try {
        await flushNowRef.current?.();
      } catch (err) {
        console.warn("[TASK] flush on switch failed — switching anyway:", err?.message ?? err);
      }
    }
    setActiveTask(taskId);
    activeTaskRef.current = taskId;
  }

  // ── Workspace file management ─────────────────────────────────────────────
  // Every mutation is a no-op once submitted: the Immune Phase means the
  // submitted artifact cannot change, and that has to include the file set,
  // not just the text inside main.cpp.
  // Every one of these acts on the ACTIVE task's workspace: the file rules
  // (main.cpp always present and undeletable, allowed extensions, guarded
  // names) hold per task, not once per exam.
  function setActiveFile(next) {
    patchTask(activeTask, (t) => ({
      activeFile: typeof next === "function" ? next(t.activeFile) : next,
    }));
  }

  function handleEditorChange(next) {
    if (isOutputBuffer) return; // captured results are read-only
    patchTask(activeTask, (t) => ({
      files: t.files.map((f) => (f.name === t.activeFile ? { ...f, content: next } : f)),
    }));
  }

  function handleCreateFile(name) {
    if (isSubmittedRefSafe()) return;
    patchTask(activeTask, (t) => ({
      files: [...t.files, { name, content: "" }],
      activeFile: name,
    }));
  }

  function handleRenameFile(oldName, newName) {
    if (isSubmittedRefSafe() || oldName === newName) return;
    patchTask(activeTask, (t) => ({
      files: t.files.map((f) => (f.name === oldName ? { ...f, name: newName } : f)),
      activeFile: t.activeFile === oldName ? newName : t.activeFile,
    }));
  }

  function handleDeleteFile(name) {
    // main.cpp is the entry point for `g++ *.cpp -o main` — without it there is
    // nothing to link. The panel disables its delete button; this is the guard
    // behind it.
    if (isSubmittedRefSafe() || name === ENTRY_FILE) return;
    patchTask(activeTask, (t) => ({
      files: t.files.filter((f) => f.name !== name),
      activeFile: t.activeFile === name ? ENTRY_FILE : t.activeFile,
    }));
  }

  function isSubmittedRefSafe() {
    return sessionStatusRef.current === "SUBMITTED";
  }

  async function handleRun() {
    // Pin the task this run belongs to: the student can switch tabs while
    // Judge0 is still working, and Task 2's output must not land in Task 3's
    // console. Tasks are separate programs, so only THIS task's files are
    // compiled — `g++ *.cpp` globs one task's workspace, never the exam's.
    const runTaskId = activeTask;
    const runFiles = files;
    const runStdin = stdin;
    setIsRunning(true);
    // Results from the previous run are stale the moment a new one starts.
    const sourceCount = runFiles.filter((f) => kindOf(f.name) === "code").length;
    const dataCount = runFiles.length - sourceCount;
    // Clear-on-run so repeated runs stay readable.
    patchTask(runTaskId, (t) => ({
      outputFiles: [],
      activeFile: outputNameOf(t.activeFile) ? ENTRY_FILE : t.activeFile,
      consoleEvents: [
        { kind: "cmd", text: BUILD_COMMAND },
        {
          kind: "meta",
          text:
            `[build] ${sourceCount} source file(s)` +
            (dataCount > 0 ? `, ${dataCount} data file(s) in the working directory` : ""),
        },
        ...(runStdin.trim().length > 0
          ? [{ kind: "meta", text: `[stdin] ${runStdin.split("\n").length} line(s) provided` }]
          : [{ kind: "meta", text: "[stdin] none provided" }]),
      ],
    }));
    try {
      const res = await fetch("http://localhost:3001/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // This TASK's workspace goes up; the server packages it for Judge0's
          // multi-file language. `code` is still sent so an older server (or
          // the legacy path) keeps working.
          files: runFiles,
          code,
          lang: LANGUAGE,
          stdin: runStdin,
          sessionId: sessionIdRef.current,
          // Which task this run belongs to — carried for the server's run log.
          taskId: runTaskId,
        }),
      });
      const data = await res.json();

      const entries = [];
      // A rejected workspace (bad name, too many files) comes back as a plain
      // error — surface it instead of falling through to "(no output)".
      if (!res.ok && data.error) {
        pushConsole(runTaskId, [{ kind: "stderr", text: data.error }]);
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
      patchTask(runTaskId, { outputFiles: written });
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
      pushConsole(runTaskId, entries);
    } catch (err) {
      pushConsole(runTaskId, [{ kind: "stderr", text: `Network error — ${err.message}` }]);
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
        isSubmitting={isSubmitting}
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
          {/* Task tabs (Prompt 1). Rendered only for a genuinely multi-task
              exam: a single-task assignment must look exactly as it did
              before, with no extra chrome to explain. The PDF pane sits
              OUTSIDE this column because one question sheet covers every
              task — it stays put while the workspace beneath it swaps. */}
          {isMultiTask && (
            <div className="task-tabs" role="tablist" aria-label="Exam tasks">
              {taskIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={id === activeTask}
                  className={`task-tab ${id === activeTask ? "active" : ""}`}
                  onClick={() => handleSelectTask(id)}
                  title={`${taskLabel(id)} — its own files, compiled and run separately`}
                >
                  {taskLabel(id)}
                </button>
              ))}
              <span className="task-tabs-hint">
                One submit covers every task.
              </span>
            </div>
          )}
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
              flushRef={flushNowRef}
              isSubmitted={isSubmitted}
              studentId={STUDENT_ID_EFFECTIVE}
              sessionIdRef={sessionIdRef}
              labMode={LAB_MODE_EFFECTIVE}
              assignmentId={assignmentId}
              tabs={tabs}
              activeFile={activeFile}
              onSelectFile={setActiveFile}
              readOnly={isOutputBuffer}
              // Prompt 1: every captured event is tagged with the task it
              // happened in, and the editor keeps a separate Monaco model per
              // task so undo history and the telemetry baseline never bleed
              // across questions. `taskLabel` only ever decorates alert text.
              taskId={activeTask}
              taskLabel={isMultiTask ? taskLabel(activeTask) : null}
            />
          </div>
          <Terminal
            events={consoleEvents}
            stdin={stdin}
            onStdinChange={(next) => patchTask(activeTask, { stdin: next })}
            onClear={() => patchTask(activeTask, { consoleEvents: [] })}
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
