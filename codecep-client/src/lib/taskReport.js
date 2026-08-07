// Per-task forensic report helpers (Prompt 2). PURE module — no React, no DOM,
// so both the DVR and the ClassPage session table read the per-task evidence
// through exactly one normalization instead of drifting into two renderings.

import { taskLabel } from "./workspace";
import { shownMetricKeys } from "./metricLabels";

/** The metrics a task can be flagged on, in the order the report shows them. */
export const TASK_METRIC_KEYS = ["metricA", "metricB", "metricC", "authorship", "astAudit"];

/**
 * The metric columns this exam type shows. On a take-home ASSESSMENT the run
 * count is dropped: over hours or days it measures the student's habits, not
 * their authorship. Anything else (LIVE_LAB, unknown, absent) shows all five —
 * the behavior that existed before this gate.
 */
export function taskMetricKeysFor(assignmentType) {
  return shownMetricKeys(TASK_METRIC_KEYS, assignmentType);
}

/**
 * One row per task, from either shape the API produces:
 *  • the replay payload's `forensicsResults.tasks` MAP, carrying full stats
 *  • the flags-only ARRAY the session-summary routes return
 */
export function normalizeTaskRows(tasks) {
  if (!tasks) return [];
  const entries = Array.isArray(tasks)
    ? tasks.map((t) => [t?.taskId, t])
    : Object.entries(tasks);

  return entries
    .filter(([taskId]) => typeof taskId === "string" && taskId.length > 0)
    .map(([taskId, t]) => ({
      taskId,
      label: typeof t?.label === "string" ? t.label : taskLabel(taskId),
      metricA: {
        flag: t?.metricA?.flag ?? null,
        runCount: t?.metricA?.runCount ?? null,
        // 'task' = this task's own run count (per-task tracking); 'session' =
        // a session recorded before that existed, where only the total is
        // known. The UI must not present the second as measured here.
        scope: t?.metricA?.scope ?? "session",
        reason: t?.metricA?.reason ?? null,
      },
      metricB: {
        flag: t?.metricB?.flag ?? null,
        inconclusive: t?.metricB?.inconclusive ?? false,
        reason: t?.metricB?.reason ?? null,
      },
      metricC: {
        flag: t?.metricC?.flag ?? null,
        inconclusive: t?.metricC?.inconclusive ?? false,
        cv: t?.metricC?.cv ?? t?.metricC?.stats?.cv ?? null,
        reason: t?.metricC?.reason ?? null,
      },
      authorship: {
        flag: t?.authorship?.flag ?? null,
        typedRatio: t?.authorship?.typedRatio ?? t?.authorship?.stats?.typedRatio ?? null,
        reason: t?.authorship?.reason ?? null,
      },
      astAudit: {
        flag: t?.astAudit?.flag ?? null,
        violationCount:
          t?.astAudit?.violationCount ??
          (Array.isArray(t?.astAudit?.violations) ? t.astAudit.violations.length : 0),
      },
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));
}

/**
 * Which metrics of one normalized row carry a flag — drives the row emphasis.
 *
 * `assignmentType` excludes metrics that mean nothing for that exam type, so a
 * take-home row is never marked "flagged for review" on the strength of a
 * signal the report deliberately does not show. Mirrors the server's
 * `flaggedMetricsOf`, which gates the stored merged signal the same way.
 */
export function flaggedMetricsOfRow(row, assignmentType) {
  return taskMetricKeysFor(assignmentType).filter((key) => row?.[key]?.flag === true);
}
