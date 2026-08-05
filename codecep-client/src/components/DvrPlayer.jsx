import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { buildReplay, replayDataForTask, taskIdsInReplay } from "../lib/replayEngine";
import { languageOf, taskLabel } from "../lib/workspace";
import TaskReport, { MergedFlagPill } from "./TaskReport";
import {
  metricASeverity,
  metricBSeverity,
  metricCSeverity,
  authorshipSeverity,
  inconclusiveSeverity,
  LEVEL_COLORS,
} from "../lib/metricColors";
import "./DvrPlayer.css";

// Session 19 — keystroke-level DVR replay. The instructor WATCHES the code
// get written: play/pause, speed, skip-idle, scrubbing, and a visible flash
// when a pasted block appears at once. Reconstruction is snapshot-anchored
// (see lib/replayEngine.js) — timing and paste moments are exact; character
// order within a typed burst is approximated. Display-only: the editor is
// read-only and paste highlights use Monaco decorations, never content edits.

const METRIC_LABELS = {
  metricA: "Metric A (Trial-and-Error)",
  metricB: "Metric B (Linear Injection)",
  metricC: "Metric C (Robotic Variance)",
  authorship: "Authorship (Typed vs Pasted)",
};
const SPEEDS = [1, 2, 5, 10, 25];
const PASTE_FLASH_MS = 1200;

// Session 24 — the replay says which kind it is, because the two are not
// equally strong evidence and the instructor should know which they're seeing.
const FIDELITY_HINT = {
  exact: "Reconstructed character-for-character from the recorded edits, and verified against every 30s snapshot.",
  approx:
    "This session predates exact keystroke capture (or its snapshots disagreed with the recorded edits). Timing and paste moments are exact; character order within a typed burst is approximated.",
};

// Session 22 (part 2): the live Tier-1 feed is now also summarised per session.
const TIER1_LABELS = {
  tabOut: "Tab-outs",
  illegalPaste: "External pastes",
  astViolation: "AST violations",
};

function MetricPill({ metricKey, metric }) {
  const sev = metric?.inconclusive
    ? // B/C whose guard tripped on a substantial program: grey, never green.
      inconclusiveSeverity()
    : metricKey === "metricA"
      ? // Prompt 2: a per-task Metric A carries `scope`. 'session' means the
        // count is the whole session's (this session predates per-task run
        // tracking), so it is shown grey rather than coloured as though it had
        // been measured for this task.
        metric?.scope === "session"
        ? {
            level: "grey",
            label: `${metric?.runCount ?? "—"} run(s) recorded for the whole session, not per task`,
          }
        : metricASeverity(metric?.runCount)
      : metricKey === "metricC"
        ? metricCSeverity(metric?.stats?.cv ?? null)
        : metricKey === "authorship"
          ? authorshipSeverity(metric?.flag, metric?.stats?.typedRatio ?? null)
          : metricBSeverity(metric?.flag);
  const color = LEVEL_COLORS[sev.level];
  return (
    <span className="dvr-pill" style={{ color, borderColor: color }} title={metric?.reason ?? sev.label}>
      {METRIC_LABELS[metricKey]}: {sev.label}
    </span>
  );
}

// Counts, colored by whether anything fired — never a verdict on its own.
// `recorded: false` = the session predates the Tier-1 record, so tab-outs and
// AST violations are UNKNOWN and must read "not recorded", never "0".
function Tier1Row({ summary }) {
  if (!summary) return null;
  return (
    <div className="dvr-tier1">
      <span className="dvr-tier1-title">Live violations during the exam:</span>
      {Object.entries(TIER1_LABELS).map(([key, label]) => {
        const n = summary[key];
        const unknown = n === null || n === undefined;
        const color = unknown
          ? LEVEL_COLORS.grey
          : n > 0
            ? LEVEL_COLORS.red
            : LEVEL_COLORS.green;
        return (
          <span
            key={key}
            className="dvr-pill"
            style={{ color, borderColor: color }}
            title={
              unknown
                ? "Not recorded — this session predates per-session Tier-1 logging."
                : n > 0
                  ? `${n} ${label.toLowerCase()} — flagged for review`
                  : `No ${label.toLowerCase()} recorded`
            }
          >
            {label}: {unknown ? "not recorded" : n}
          </span>
        );
      })}
      {!summary.recorded && (
        <span className="dvr-severity-note">
          Tier-1 alerts were not recorded for this session — external pastes are
          reconstructed from the keystroke log; tab-outs and AST violations are
          unknown, not zero.
        </span>
      )}
    </div>
  );
}

// Session 24 (Change B2) — the submit-time sweep over EVERY code file. Live
// validation only ever saw the active buffer, so this is what closes the
// "hide it in an unfocused file" gap. Absent on sessions submitted before v2,
// which must read as "not checked", never as "clean".
function AstAuditRow({ audit }) {
  if (!audit) return null;
  const { violations = [], checkedFiles = [], flag } = audit;
  const color = flag ? LEVEL_COLORS.red : LEVEL_COLORS.green;
  const byFile = violations.reduce((acc, v) => {
    (acc[v.fileName] ??= []).push(v);
    return acc;
  }, {});
  return (
    <div className="dvr-tier1">
      <span className="dvr-tier1-title">All-files construct check (at submit):</span>
      <span
        className="dvr-pill"
        style={{ color, borderColor: color }}
        title={
          checkedFiles.length === 0
            ? "No code files were present to check."
            : `Checked ${checkedFiles.join(", ")} against the ${audit.allowlistSource} allowlist`
        }
      >
        {checkedFiles.length === 0
          ? "no code files"
          : flag
            ? `${violations.length} disallowed construct(s) — flagged for review`
            : `${checkedFiles.length} file(s) clean`}
      </span>
      {Object.entries(byFile).map(([file, vs]) => (
        <span
          key={file}
          className="dvr-pill"
          style={{ color: LEVEL_COLORS.red, borderColor: LEVEL_COLORS.red }}
          title={vs.map((v) => `line ${v.line}: ${v.nodeType}`).join("\n")}
        >
          {file}: {[...new Set(vs.map((v) => v.nodeType))].join(", ")}
        </span>
      ))}
    </div>
  );
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function DvrPlayer({ sessionId, initialTaskId = null }) {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [t, setT] = useState(0); // playback position, ms relative to start
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [skipIdle, setSkipIdle] = useState(true);
  // Prompt 2 — WHICH task is being replayed. null = the whole session as one
  // timeline (the Prompt 1 behavior, and the only view a single-task session
  // ever shows).
  const [selectedTask, setSelectedTask] = useState(initialTaskId);

  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationsRef = useRef([]);

  // ── Load full replay data ─────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setT(0);
    setPlaying(false);
    apiFetch(`/api/session/${sessionId}/replay`, { token })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, token]);

  // A caller can open the player straight on one task ("Replay this task" in a
  // per-task report). Adjusting state during render (React's documented
  // reset-on-prop-change pattern) rather than in an effect: the selection is
  // derived from what the caller asked for, so it must not lag a frame behind
  // it. Keyed on the session too, so switching student drops a Task 3 selection
  // instead of carrying it into a session that only has two tasks.
  const selectionKey = `${sessionId}:${initialTaskId ?? ""}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    setSelectedTask(initialTaskId ?? null);
    setT(0);
    setPlaying(false);
  }

  // Session 22 (part 2): replay is anchored at an EMPTY document, matching the
  // real exam start. It used to anchor at the old starter template, which is
  // now wrong for every flow (Session 25 removed the template entirely) — and
  // anchoring at the first snapshot is what made a first-event paste invisible
  // (see lib/replayEngine.js).
  // Which tasks this session actually produced data for. A single-task session
  // (and every session recorded before multi-task exams) yields one id, and
  // everything task-shaped below then stays out of the way entirely.
  const taskIds = useMemo(() => (data ? taskIdsInReplay(data) : []), [data]);
  const isMultiTask = taskIds.length > 1 || (data?.taskCount ?? 1) > 1;

  // Prompt 2 — per-task replay is the SAME engine run over a payload narrowed
  // to one task, so its reconstruction is still verified against that task's
  // own recorded snapshots rather than being a second, weaker code path.
  const replay = useMemo(
    () =>
      data
        ? buildReplay(selectedTask ? replayDataForTask(data, selectedTask) : data, {
            initialText: "",
          })
        : null,
    [data, selectedTask],
  );
  const duration = replay?.totalDurationMs ?? 0;

  // Switching task rewinds: the timelines are different lengths and a position
  // carried across would land somewhere arbitrary.
  const selectTask = useCallback((taskId) => {
    setSelectedTask(taskId);
    setT(0);
    setPlaying(false);
  }, []);

  // ── Playback loop (rAF; text only re-renders when the frame text changes) ─
  useEffect(() => {
    if (!playing || !replay) return;
    let last = performance.now();
    let raf;
    const tick = (now) => {
      const dt = (now - last) * speed;
      last = now;
      setT((prev) => {
        let next = prev + dt;
        if (skipIdle) {
          // Fast-forward long pauses: jump to just before the gap's end.
          const gap = replay.gaps.find((g) => next > g.start + 1500 && next < g.end - 200);
          if (gap) next = gap.end - 100;
        }
        if (next >= replay.totalDurationMs) {
          setPlaying(false);
          return replay.totalDurationMs;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, skipIdle, replay]);

  // Session 24: the replay is file-aware. `stateAt` answers BOTH which file was
  // being edited at T and that file's exact text, so a file switch reads as a
  // labeled change rather than the content mysteriously jumping.
  const state = useMemo(
    () => (replay ? replay.stateAt(t) : { fileName: null, text: "" }),
    [replay, t],
  );
  const text = state.text;
  const activeFileName = state.fileName;

  // ── Paste highlight: flash the pasted range for ~1.2s after its moment ────
  // Scoped to the file the paste happened in — a range from another file would
  // decorate arbitrary characters in the one on screen.
  const activePaste = useMemo(
    () =>
      replay?.pasteMarks.find(
        (m) =>
          t >= m.t &&
          t <= m.t + PASTE_FLASH_MS &&
          (m.fileName == null || m.fileName === activeFileName),
      ) ?? null,
    [replay, t, activeFileName],
  );
  const lastPaste = useMemo(() => {
    if (!replay) return null;
    let latest = null;
    for (const m of replay.pasteMarks) if (m.t <= t) latest = m;
    return latest;
  }, [replay, t]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    if (activePaste) {
      const start = model.getPositionAt(Math.min(activePaste.rangeStart, model.getValueLength()));
      const end = model.getPositionAt(Math.min(activePaste.rangeEnd, model.getValueLength()));
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
        {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { className: "dvr-paste-flash", isWholeLine: false },
        },
      ]);
      editor.revealPositionInCenterIfOutsideViewport(start);
    } else {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
  }, [activePaste, text]);

  const seek = useCallback(
    (ms) => setT(Math.max(0, Math.min(duration, ms))),
    [duration],
  );

  function handleKeyDown(e) {
    if (e.key === " ") {
      e.preventDefault();
      setPlaying((p) => !p && duration > 0);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      seek(t - 5000);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seek(t + 5000);
    }
  }

  // ── States ────────────────────────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty">Select a session — click a student tile or a Replay button.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty"><span className="spinner" aria-hidden="true" />Loading replay…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty dvr-error">{error}</div>
      </div>
    );
  }
  if (!replay) return null;

  const { studentId, status, forensicsResults } = data;
  // The task whose forensics are shown beside the player. With a task selected
  // these are that task's OWN numbers; with "All tasks" they are the
  // session-wide computation (which on a multi-task exam is an average — the
  // merged pill beside it is the review signal).
  const taskBundle = selectedTask ? forensicsResults?.tasks?.[selectedTask] ?? null : null;
  const shown = taskBundle ?? forensicsResults;

  return (
    <div className="dvr-panel" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="dvr-header">
        <span className="dvr-student" title={studentId}>{studentId}</span>
        {data.assignmentTitle && (
          <span className="dvr-assignment" title={data.assignmentTitle}>
            {data.assignmentTitle}
          </span>
        )}
        <span className={`dvr-badge ${status === "IN_PROGRESS" ? "in-progress" : "submitted"}`}>
          {status}
        </span>
        {isMultiTask && (
          <span className="dvr-count">{data.taskCount ?? taskIds.length} tasks</span>
        )}
        <span className="dvr-count">
          {replay.eventCount} keystroke events · {data.snapshots.length} snapshots
        </span>
        {/* The session's REVIEW signal: any task flagged. Shown next to the
            student so a flagged task inside an otherwise clean-looking session
            is the first thing read, not something buried in a table. */}
        {isMultiTask && forensicsResults && (
          <MergedFlagPill
            merged={forensicsResults.merged}
            taskCount={data.taskCount ?? taskIds.length}
          />
        )}
      </div>

      <div className="dvr-forensics">
        {forensicsResults ? (
          <>
            {selectedTask && (
              <span className="dvr-scope-note">
                Showing {taskLabel(selectedTask)}
                {taskBundle ? "'s own forensics" : " — no per-task forensics recorded"}:
              </span>
            )}
            {Object.keys(METRIC_LABELS).map((key) => (
              <MetricPill key={key} metricKey={key} metric={shown?.[key]} />
            ))}
            <span className="dvr-severity-note">
              Colors are severity guidance — "flagged" means flagged for instructor
              review. The run-count and typed-share thresholds are configurable
              defaults; judge them against task complexity.
              {isMultiTask && !selectedTask
                ? " These session-level figures span every task; the per-task breakdown below is the sharper reading."
                : ""}
            </span>
          </>
        ) : (
          <span className="dvr-pill pending">Forensics pending (session not yet submitted)</span>
        )}
      </div>

      <Tier1Row summary={data.tier1Summary} />
      <AstAuditRow audit={shown?.astAudit} />

      {/* Per-task breakdown + merged report (Prompt 2). Rendered only for a
          genuinely multi-task session: a single-task exam shows exactly the
          report it always did, with no empty "Task 1" chrome. */}
      {isMultiTask && forensicsResults?.tasks && (
        <TaskReport
          tasks={forensicsResults.tasks}
          merged={forensicsResults.merged}
          taskCount={data.taskCount ?? taskIds.length}
          selectedTaskId={selectedTask}
          onReplayTask={selectTask}
        />
      )}

      {/* Which task is on the player. "All tasks" is the whole session as one
          timeline; picking a task replays that task's own reconstruction. */}
      {isMultiTask && (
        <div className="dvr-tasks">
          <span className="dvr-tasks-label">Replay:</span>
          <button
            className={`dvr-task-tab ${selectedTask === null ? "active" : ""}`}
            onClick={() => selectTask(null)}
            title="Replay the whole session as one timeline, across every task"
          >
            All tasks
          </button>
          {taskIds.map((id) => (
            <button
              key={id}
              className={`dvr-task-tab ${selectedTask === id ? "active" : ""}`}
              onClick={() => selectTask(id)}
              title={`Replay ${taskLabel(id)} on its own`}
            >
              {taskLabel(id)}
            </button>
          ))}
        </div>
      )}

      {duration === 0 ? (
        <div className="dvr-empty">
          {selectedTask
            ? `No keystroke activity recorded for ${taskLabel(selectedTask)}.`
            : "No keystroke activity recorded for this session yet."}
        </div>
      ) : (
        <>
          <div className="dvr-controls">
            <button
              className="btn btn-secondary dvr-play"
              onClick={() => setPlaying((p) => !p)}
              title="Space = play/pause · ←/→ = seek 5s"
            >
              {playing ? "❚❚ Pause" : "▶ Play"}
            </button>
            <label className="dvr-speed">
              Speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>{s}×</option>
                ))}
              </select>
            </label>
            <label className="dvr-skip">
              <input
                type="checkbox"
                checked={skipIdle}
                onChange={(e) => setSkipIdle(e.target.checked)}
              />
              Skip idle gaps ({replay.gaps.length})
            </label>
            <span className="dvr-clock mono">
              {fmtClock(t)} / {fmtClock(duration)}
            </span>
          </div>

          <div className="dvr-scrubber">
            <div className="dvr-track">
              <input
                type="range"
                min={0}
                max={duration}
                value={Math.round(t)}
                onChange={(e) => seek(Number(e.target.value))}
              />
              {/* Paste tick marks — click to jump straight to the moment */}
              {replay.pasteMarks.map((m, i) => (
                <button
                  key={i}
                  className={`dvr-paste-mark ${m.provenance === "internal" ? "internal" : "external"}`}
                  style={{ left: `${(m.t / duration) * 100}%` }}
                  title={`Paste +${m.charCount} chars at ${fmtClock(m.t)}${m.provenance ? ` (${m.provenance})` : ""} — click to jump`}
                  onClick={() => {
                    seek(m.t);
                    setPlaying(false);
                  }}
                />
              ))}
            </div>
            <div className="dvr-scrub-label">
              {lastPaste ? (
                <span className={`dvr-paste-label ${activePaste ? "active" : ""}`}>
                  ⚠ Paste: +{lastPaste.charCount} chars at {fmtClock(lastPaste.t)}
                  {lastPaste.provenance ? ` (${lastPaste.provenance})` : ""}
                </span>
              ) : (
                <span>No paste moments before this point</span>
              )}
            </div>
          </div>

          {/* Which file the student was editing at this moment. The strip
              exists even for single-file sessions so the reading is never
              ambiguous, and it is what turns a mid-replay content jump into an
              explained file switch. */}
          <div className="dvr-files">
            {(replay.files ?? []).map((name) => (
              <span
                key={name}
                className={`dvr-file-tab ${name === activeFileName ? "active" : ""}`}
                title={name === activeFileName ? `Editing ${name} at this moment` : name}
              >
                {name}
              </span>
            ))}
            <span className="dvr-fidelity" title={FIDELITY_HINT[replay.exact ? "exact" : "approx"]}>
              {replay.exact ? "exact replay" : "approximate replay"}
            </span>
          </div>

          <Editor
            height="400px"
            path={activeFileName ?? undefined}
            language={languageOf(activeFileName ?? "main.cpp")}
            value={text}
            theme="vs-dark"
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
            }}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 14 }}
          />
        </>
      )}
    </div>
  );
}
