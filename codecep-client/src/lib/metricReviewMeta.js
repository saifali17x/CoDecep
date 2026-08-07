// ── Which metrics accept an accuracy judgment (Feature 3) ───────────────────
//
// Mirrors `codecep-server/src/lib/metricReview.ts` — **keep the two in step**.
// The server is the authority and rejects anything outside this set; this list
// exists so the UI never OFFERS a control the server would refuse.
//
// The distinction is not arbitrary. These four are probabilistic INFERENCES
// about how code was written, so "was this accurate?" is a real question about
// them. Tab-outs, external pastes and AST violations are FACTUAL records — the
// browser reported one or it did not, the parser found a construct or it did
// not — and `astAudit` is a parse result of the same kind. An instructor who
// disagrees with one of those is reporting a BUG, not calibrating a threshold,
// and mixing the two would poison the dataset this feature exists to build.
//
// Nothing here (or anywhere) reads collected judgments to move a threshold.
// Tuning is a deliberate, manual, later pass — see CLAUDE.md §7.
export const BEHAVIORAL_METRICS = ["metricA", "metricB", "metricC", "authorship"];

export function isBehavioralMetric(metric) {
  return BEHAVIORAL_METRICS.includes(metric);
}

/**
 * What the metric SAID for this row — stored beside the judgment.
 *
 * This is the half that makes the data calibratable: "inaccurate" against a
 * flag is a FALSE POSITIVE, "inaccurate" against no flag is a FALSE NEGATIVE,
 * and those point a threshold in opposite directions. Metric A has no stored
 * boolean of its own in every shape, so it is derived from the run count the
 * same way the severity colouring is.
 */
export function predictedFlagOfRow(row, metric) {
  if (!row) return false;
  if (metric === "metricA") {
    if (typeof row.metricA?.flag === "boolean") return row.metricA.flag;
    const runs = row.metricA?.runCount;
    return typeof runs === "number" ? runs <= 1 : false;
  }
  return Boolean(row?.[metric]?.flag);
}

/**
 * Index an instructor's saved judgments by the (task, metric) they belong to,
 * so each optional control renders in the state it was left in. `""` is the
 * session-level scope, matching how the server stores it.
 */
export function judgmentIndex(rows) {
  const out = {};
  for (const row of rows ?? []) {
    out[judgmentKey(row.taskId, row.metric)] = row.judgment;
  }
  return out;
}

export function judgmentKey(taskId, metric) {
  return `${taskId ?? ""}::${metric}`;
}
