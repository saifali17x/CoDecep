import { normalizeTaskRows, flaggedMetricsOfRow, TASK_METRIC_KEYS } from "../lib/taskReport";
import {
  metricASeverity,
  metricBSeverity,
  metricCSeverity,
  authorshipSeverity,
  inconclusiveSeverity,
  astAuditSeverity,
  mergedSeverity,
  LEVEL_COLORS,
} from "../lib/metricColors";
import "./TaskReport.css";

// ── The merged per-task forensic report (Prompt 2) ──────────────────────
//
// Why this exists: the session-level metrics are computed over ALL of a
// session's events, so on a multi-task exam they are an AVERAGE. A student who
// hand-writes two tasks and pastes the third pulls the session's typed share
// back over the threshold, and the session reads "no flag" — the pasted task
// hides inside the average (gap #31). This component shows each task's own
// result, and the session indicator it renders is the MERGED signal: any task
// flagged means the session is flagged for review.
//
// Framing (Constraint 7): every colour is paired with text, and red always
// reads "flagged for review" — a probabilistic signal a human instructor
// judges, never a verdict and never "cheating".
// Row normalization lives in lib/taskReport.js so this file exports components
// only (and so the DVR and the session table share one reading of the data).

function Cell({ sev, short }) {
  return (
    <span className="sev-cell" style={{ color: LEVEL_COLORS[sev.level] }} title={sev.label}>
      {short}
    </span>
  );
}

function severityOf(row, key) {
  if (key === "metricA") {
    // A pre-tracking session's session-wide total is shown greyed: it is not a
    // measurement of THIS task, and colouring it would imply it was.
    if (row.metricA.scope !== "task") {
      return {
        sev: {
          level: "grey",
          label:
            "Run count was recorded for the whole session, not per task — this session predates per-task run tracking.",
        },
        short: row.metricA.runCount == null ? "—" : `${row.metricA.runCount} (session)`,
      };
    }
    const sev = metricASeverity(row.metricA.runCount);
    return {
      sev: { ...sev, label: row.metricA.reason ?? sev.label },
      short: `${row.metricA.runCount} run${row.metricA.runCount === 1 ? "" : "s"}`,
    };
  }
  if (key === "metricB") {
    if (row.metricB.flag == null) return { sev: { level: "grey", label: "not assessed" }, short: "—" };
    const sev = row.metricB.inconclusive ? inconclusiveSeverity() : metricBSeverity(row.metricB.flag);
    return {
      sev: { ...sev, label: row.metricB.reason ?? sev.label },
      short: row.metricB.inconclusive ? "n/a" : row.metricB.flag ? "flag" : "ok",
    };
  }
  if (key === "metricC") {
    if (row.metricC.flag == null) return { sev: { level: "grey", label: "not assessed" }, short: "—" };
    const sev = row.metricC.inconclusive ? inconclusiveSeverity() : metricCSeverity(row.metricC.cv);
    return {
      sev: { ...sev, label: row.metricC.reason ?? sev.label },
      short: row.metricC.inconclusive
        ? "n/a"
        : row.metricC.cv != null
          ? `CV ${row.metricC.cv.toFixed(2)}`
          : "—",
    };
  }
  if (key === "authorship") {
    if (row.authorship.flag == null)
      return { sev: { level: "grey", label: "not assessed" }, short: "—" };
    const sev = authorshipSeverity(row.authorship.flag, row.authorship.typedRatio);
    return {
      sev: { ...sev, label: row.authorship.reason ?? sev.label },
      short:
        row.authorship.typedRatio != null
          ? `${Math.round(row.authorship.typedRatio * 100)}% typed`
          : row.authorship.flag
            ? "pasted"
            : "ok",
    };
  }
  const sev = astAuditSeverity(row.astAudit.flag, row.astAudit.violationCount);
  return {
    sev,
    short:
      row.astAudit.flag == null ? "—" : row.astAudit.flag ? `${row.astAudit.violationCount}` : "ok",
  };
}

/**
 * The session's review indicator. `merged` comes straight from the worker, so a
 * session processed before merged review existed reads "not assessed" (grey) —
 * never a green pass it was never assessed for.
 */
export function MergedFlagPill({ merged, taskCount }) {
  const sev = mergedSeverity(merged?.flag ?? null, merged?.flaggedTaskCount, taskCount ?? 1);
  const color = LEVEL_COLORS[sev.level];
  return (
    <span
      className="merged-pill"
      style={{ color, borderColor: color }}
      title={
        merged?.reason ??
        (merged?.flag === false
          ? "No task flagged. Flags are probabilistic signals for instructor review."
          : sev.label)
      }
    >
      {sev.label}
    </span>
  );
}

/**
 * Per-task breakdown table. `onReplayTask` (optional) turns each row into a
 * one-click jump into that task's replay.
 */
export default function TaskReport({ tasks, merged, taskCount, selectedTaskId, onReplayTask }) {
  const rows = normalizeTaskRows(tasks);
  if (rows.length === 0) return null;

  const flaggedIds = new Set(
    (merged?.flaggedTasks ?? []).map((t) => t.taskId).filter(Boolean),
  );

  return (
    <div className="task-report">
      <div className="task-report-head">
        <span className="task-report-title">
          Per-task breakdown ({rows.length} task{rows.length === 1 ? "" : "s"})
        </span>
        <MergedFlagPill merged={merged} taskCount={taskCount ?? rows.length} />
      </div>

      <div className="table-scroll">
        <table className="task-report-table">
          <thead>
            <tr>
              <th>Task</th>
              <th title="Metric A — Trial-and-Error (compile runs for THIS task)">Runs (A)</th>
              <th title="Metric B — Linear Injection">B</th>
              <th title="Metric C — Robotic Variance">C</th>
              <th title="Authorship — how much of this task's code came from typing">Auth</th>
              <th title="Submit-time construct check over this task's code files">Constructs</th>
              {onReplayTask && <th></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const flagged = flaggedMetricsOfRow(row).length > 0 || flaggedIds.has(row.taskId);
              return (
                <tr
                  key={row.taskId}
                  className={`${flagged ? "flagged" : ""} ${
                    row.taskId === selectedTaskId ? "selected" : ""
                  }`}
                >
                  <td>
                    <span className="task-name">{row.label}</span>
                    {flagged && (
                      <span className="task-flag-note" title="Flagged for instructor review">
                        flagged for review
                      </span>
                    )}
                  </td>
                  {TASK_METRIC_KEYS.map((key) => {
                    const { sev, short } = severityOf(row, key);
                    return (
                      <td key={key}>
                        <Cell sev={sev} short={short} />
                      </td>
                    );
                  })}
                  {onReplayTask && (
                    <td>
                      <button className="link-btn" onClick={() => onReplayTask(row.taskId)}>
                        {row.taskId === selectedTaskId ? "Replaying" : "Replay this task"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="task-report-note">
        Each task is a separate program and is assessed on its own data. The
        session indicator is <strong>any task flagged</strong>, never an average —
        a flagged task is never washed out by clean ones. Colours are severity
        guidance; "flagged" means flagged for instructor review.
      </p>
    </div>
  );
}
