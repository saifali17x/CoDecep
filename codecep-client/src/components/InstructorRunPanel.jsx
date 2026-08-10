import { useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { runStatusOf, RUNNING_STATUS } from "../lib/runStatus";
import { runResultEvents, runNetworkErrorEvents } from "../lib/runConsole";
import { taskLabel } from "../lib/workspace";
import Terminal from "./Terminal";
import "./InstructorRunPanel.css";

// ── Run the submitted code (instructor review) ───────────────────────────────
//
// The forensic report answers "how was this written?". This answers the other
// question an instructor has in front of a submitted session: "does it work?"
// — using the code the student actually submitted, and inputs the student may
// never have tried.
//
// It reuses the existing execution path end to end: POST /api/sessions/:id/run
// is a second ENTRY POINT into the same Judge0 call the student's Run Code
// button reaches (same multi-file packaging, same batch stdin, same captured
// output files), and the console below is the same <Terminal>, fed by the same
// lib/runConsole.js the exam console uses.
//
// READ-ONLY. Nothing here writes to the student's record: no telemetry, no
// keystroke events, no change to the forensics, and — the one that would
// quietly corrupt a metric — no change to `runCount`. Metric A counts the
// STUDENT's compiles, so an instructor pressing Run while marking must not move
// it. The server enforces that by containing no write at all on this route; the
// panel states it on screen so the instructor knows it too, rather than having
// to trust that we remembered.
//
// Owner-only: the route is instructor-only and ownership-checked, and this
// component only ever renders inside the instructor's DVR.

export default function InstructorRunPanel({
  sessionId,
  taskId = null,
  studentId = null,
  // Multi-task session showing "All tasks": there is no single program to run.
  // Asking for a task beats guessing one — running Task 1 while the instructor
  // reads Task 3 would show them the wrong program and look like the right one.
  needsTaskSelection = false,
}) {
  const { token } = useAuth();
  const [stdin, setStdin] = useState("");
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState(null);
  // Which task the LAST run actually executed, as reported by the server. Shown
  // rather than assumed: the instructor may have switched the replay to another
  // task since, and output labelled with the wrong task is worse than unlabelled
  // output.
  const [ranTask, setRanTask] = useState(null);

  const run = useCallback(async () => {
    setRunning(true);
    setRunStatus(null);
    // Clear-on-run, exactly like the exam console: the previous run's output is
    // stale the moment a new one starts.
    setEvents([
      { kind: "cmd", text: "g++ -std=c++17 -o main *.cpp && ./main" },
      {
        kind: "meta",
        text:
          `[review] running the submitted code${taskId ? ` for ${taskLabel(taskId)}` : ""}` +
          ` — the student's record is not changed`,
      },
      stdin.trim().length > 0
        ? { kind: "meta", text: `[stdin] ${stdin.split("\n").length} line(s) provided by you` }
        : { kind: "meta", text: "[stdin] none provided" },
    ]);
    try {
      const data = await apiFetch(`/api/sessions/${sessionId}/run`, {
        method: "POST",
        token,
        body: { taskId, stdin },
      });
      const { entries } = runResultEvents(data, true, {
        // No file panel on this screen — see lib/runConsole.js.
        filesHint: " — written by this run only, nothing was saved",
      });
      setRanTask(data.taskId ?? taskId ?? null);
      setRunStatus(runStatusOf(data, true));
      setEvents((prev) => [...prev, ...entries]);
    } catch (err) {
      // apiFetch throws the server's own message (403 ownership, 409 not yet
      // submitted, 400 nothing recorded for that task), so the console shows
      // what actually happened rather than a generic failure.
      const rejected = typeof err.status === "number";
      setRunStatus(
        rejected ? { state: "error", label: "Run rejected" } : { state: "error", label: "Network error" },
      );
      setEvents((prev) => [
        ...prev,
        ...(rejected
          ? [{ kind: "stderr", text: err.message }, { kind: "prompt", text: "$" }]
          : runNetworkErrorEvents(err.message)),
      ]);
    } finally {
      setRunning(false);
    }
  }, [sessionId, taskId, stdin, token]);

  const clear = useCallback(() => {
    setEvents([]);
    setRunStatus(null);
  }, []);

  return (
    <div className="instructor-run">
      <div className="instructor-run-head">
        <h4 className="instructor-run-title">Run the submitted code</h4>
        <button
          className="btn btn-primary instructor-run-btn"
          onClick={run}
          disabled={running || needsTaskSelection}
          title={
            needsTaskSelection
              ? "Pick a task above — each task is a separate program"
              : "Compile and run the code this student submitted, with the input you provide below"
          }
        >
          {running ? RUNNING_STATUS.label : "▶ Run submitted code"}
        </button>
        {ranTask && !running && (
          <span className="instructor-run-scope">last run: {taskLabel(ranTask)}</span>
        )}
      </div>

      {needsTaskSelection && (
        <p className="instructor-run-note warn">
          Each task is a separate program. Choose one under <strong>Replay</strong> above to run
          that task&apos;s submitted code.
        </p>
      )}

      <p className="instructor-run-note">
        This compiles and runs <strong>{studentId ? `${studentId}'s` : "the student's"} submitted
        code</strong>
        {taskId ? ` for ${taskLabel(taskId)}` : ""} in a fresh sandbox, so you can check what it
        actually does — including against inputs the student never tried. It is <strong>not</strong>{" "}
        the student&apos;s own run: it records no keystrokes, does not count towards their run
        count, and changes nothing in their session or forensic record.
      </p>

      <Terminal
        title="Review run"
        events={events}
        stdin={stdin}
        onStdinChange={setStdin}
        onClear={clear}
        running={running}
        runStatus={runStatus}
        stdinNote="One input per line, in the order the student's program reads them — sent with the run. Leave empty for a program that reads no input."
      />
    </div>
  );
}
