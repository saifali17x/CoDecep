// ── Plain-language metric names + descriptions (UI polish part 1) ────────────
//
// PURE module — no React, no DOM — and the ONE source of the wording every
// surface uses (DVR pills, TaskReport rows, ClassPage session table, the grid's
// alert log, the review controls). Before this, "Metric B (Linear Injection)"
// and "Metric C — Robotic Variance" were hardcoded in four components, which
// meant an instructor reading a session table and the same instructor reading
// the DVR were told two different things about the same number — and neither
// told them what the metric actually checks.
//
// This is a DISPLAY layer only. The stored keys (`forensicsResults.metricA`,
// …), the identifiers in the code and every line of the metric math are
// untouched: nothing here is read by the worker, the server or any detection
// path. Renaming the data would break every existing session row; renaming only
// what a human reads costs nothing and is the whole point.
//
// Two rules the wording must keep (Constraint 7):
//   • Probabilistic framing. "may indicate" / "flagged for review" — never
//     "proves", "cheated" or "undeniable". Every one of these is a signal a
//     human instructor judges against the task.
//   • The TECHNICAL name stays reachable. The plain name is what a professor
//     reads; the technical name is what the report, the defense and the docs
//     refer to, so it is kept as secondary text or in the tooltip rather than
//     replaced.

/**
 * One entry per metric the UI can show.
 *
 *  plain — what a professor reads first. No jargon.
 *  short — the same idea at table-header width.
 *  desc  — one line: what it checks, and what a flag MAY indicate.
 *  tech  — the technical name, kept for the report/defense/docs.
 */
export const METRIC_INFO = {
  metricA: {
    plain: "Testing & iteration",
    short: "Testing",
    desc: "How many times the student compiled and ran their code while working. Very few runs on a non-trivial program may indicate code that was not developed here.",
    tech: "Metric A — run count (trial-and-error)",
  },
  metricB: {
    plain: "Typed straight through",
    short: "Straight through",
    desc: "Whether the code appeared with very little of the normal back-and-forth of writing and revising. May indicate transcribed or recalled code rather than code worked out here.",
    tech: "Metric B — linear injection (delete ratio + single-character typing)",
  },
  metricC: {
    plain: "Typing rhythm",
    short: "Rhythm",
    desc: "Whether keystroke timing is mechanically even. A very uniform rhythm may indicate automated input rather than human typing.",
    tech: "Metric C — robotic variance (coefficient of variation, CV)",
  },
  authorship: {
    plain: "Typed vs pasted",
    short: "Typed vs pasted",
    desc: "How much of the final code was typed by the student versus pasted in. Mostly-pasted code is flagged for review.",
    tech: "Authorship — typed-character ratio",
  },
  astAudit: {
    plain: "Allowed constructs",
    short: "Constructs",
    desc: "Whether the submitted code uses only the C++ constructs the syllabus has taught by this week. Findings name the construct and the line so they can be checked against the syllabus.",
    tech: "AST audit — allowlist sweep over every code file at submit",
  },
  merged: {
    plain: "Overall review signal",
    short: "Review",
    desc: "Whether ANY task was flagged on ANY metric. Never an average, so one flagged task is never washed out by clean ones.",
    tech: "merged — any-task-flagged review signal",
  },
};

/**
 * Tier-1 live events, keyed as the `tier1Summary` counters are.
 *
 * These are FACTUAL records, not assessments — the browser reported one or it
 * did not — so their descriptions say what was observed and deliberately stop
 * short of what it means. That distinction is the same one that decides which
 * metrics accept an accuracy judgment (see lib/metricReviewMeta.js).
 */
export const TIER1_INFO = {
  tabOut: {
    plain: "Left the exam screen",
    short: "Left screen",
    desc: "The exam tab lost focus while the session was in progress. Recorded as an observation — leaving the screen is not by itself misconduct.",
    tech: "TAB_OUT — Page Visibility API",
  },
  illegalPaste: {
    plain: "Pasted from outside",
    short: "External paste",
    desc: "A block of text new to this session was pasted into the editor. Text the session already contained is recorded but never alerted.",
    tech: "ILLEGAL_PASTE — external-provenance paste",
  },
  astViolation: {
    plain: "Used a construct not permitted this week",
    short: "Not-permitted construct",
    desc: "A C++ construct the syllabus has not taught by this assignment's week appeared in the editor. The alert names the construct and the line.",
    tech: "AST_VIOLATION — live allowlist check",
  },
};

/** The same three, keyed by the raw alert `type` the socket carries. */
export const ALERT_TYPE_INFO = {
  TAB_OUT: TIER1_INFO.tabOut,
  ILLEGAL_PASTE: TIER1_INFO.illegalPaste,
  AST_VIOLATION: TIER1_INFO.astViolation,
};

/** Shared framing line, so the caveat is worded once rather than five ways. */
export const REVIEW_FRAMING =
  "A flag is a probabilistic signal for instructor review, judged against the task — never proof of misconduct.";

// ── Which signals MEAN anything, per exam type ───────────────────────────────
//
// A LIVE_LAB is proctored and sat in one continuous sitting, so the full suite
// reads sensibly: leaving the exam screen is notable, and a program compiled
// once in a two-hour lab is worth a look.
//
// An ASSESSMENT is a take-home done over hours or days, and both of those stop
// being signals. Of course the student left the screen — they ate dinner. Of
// course the compile count is whatever it is: there was no sitting to compare it
// against. Showing them anyway would be worse than showing nothing, because an
// instructor who learns to dismiss two of the six indicators learns to skim all
// six.
//
// This is a DISPLAY gate. The data is still captured and still stored — the
// server withholds these metrics only from the merged review signal (see
// forensics/metrics.ts), and a session can be re-read under a different lens
// later. An unknown/absent type shows everything, which is the behavior that
// existed before this gate.
export const METRICS_HIDDEN_FOR_ASSESSMENT = ["metricA"];
export const TIER1_HIDDEN_FOR_ASSESSMENT = ["tabOut"];
export const ALERT_TYPES_HIDDEN_FOR_ASSESSMENT = ["TAB_OUT"];

/** Take-home? Anything that is not literally ASSESSMENT is treated as a lab. */
export function isTakeHome(assignmentType) {
  return assignmentType === "ASSESSMENT";
}

/** Should this metric be shown for this exam type? */
export function isMetricShownFor(key, assignmentType) {
  return !isTakeHome(assignmentType) || !METRICS_HIDDEN_FOR_ASSESSMENT.includes(key);
}

/** Should this Tier-1 counter be shown for this exam type? */
export function isTier1ShownFor(key, assignmentType) {
  return !isTakeHome(assignmentType) || !TIER1_HIDDEN_FOR_ASSESSMENT.includes(key);
}

/** Should this live alert type be surfaced for this exam type? */
export function isAlertTypeShownFor(type, assignmentType) {
  return !isTakeHome(assignmentType) || !ALERT_TYPES_HIDDEN_FOR_ASSESSMENT.includes(type);
}

/** Filter a list of metric keys down to the ones this exam type shows. */
export function shownMetricKeys(keys, assignmentType) {
  return keys.filter((k) => isMetricShownFor(k, assignmentType));
}

/**
 * Why two indicators are missing on a take-home. Shown wherever the gate hides
 * something, because a silently shorter report is indistinguishable from a
 * broken one.
 */
export const ASSESSMENT_GATE_NOTE =
  "Take-home assessment: testing/run count and leaving the exam screen are not shown — over hours or days they carry no signal. Typed-vs-pasted, pastes, typing pattern and allowed constructs still apply.";

export function metricInfo(key) {
  return METRIC_INFO[key] ?? null;
}

export function tier1Info(key) {
  return TIER1_INFO[key] ?? null;
}

export function alertTypeInfo(type) {
  return ALERT_TYPE_INFO[type] ?? null;
}

/** Plain name, falling back to the raw key so an unknown metric still renders. */
export function metricPlainName(key) {
  return METRIC_INFO[key]?.plain ?? key;
}

export function alertPlainName(type) {
  return ALERT_TYPE_INFO[type]?.plain ?? type;
}

/**
 * The full tooltip for a metric: what it checks, what this session's verdict
 * was, and the technical name underneath it.
 *
 * Built here rather than in each component so a surface that only has room for
 * a tooltip still shows exactly the same three things a surface with room for a
 * card does — the description is never the thing that gets dropped for space.
 */
export function describeMetric(key, verdictLabel) {
  const info = METRIC_INFO[key];
  if (!info) return verdictLabel ?? "";
  return [
    `${info.plain} — ${info.desc}`,
    verdictLabel ? `\nThis session: ${verdictLabel}` : "",
    `\n${info.tech}`,
  ]
    .filter(Boolean)
    .join("");
}

/** Same, for a Tier-1 counter or alert row. */
export function describeTier1(key, verdictLabel) {
  const info = TIER1_INFO[key];
  if (!info) return verdictLabel ?? "";
  return [
    `${info.plain} — ${info.desc}`,
    verdictLabel ? `\nThis session: ${verdictLabel}` : "",
    `\n${info.tech}`,
  ]
    .filter(Boolean)
    .join("");
}
