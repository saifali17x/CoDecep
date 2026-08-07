// ── Behavioral-metric accuracy review (Feature 3) ───────────────────────────
//
// Collects OPTIONAL instructor judgments so the metric thresholds can be tuned
// MANUALLY later against real opinion instead of guesswork.
//
// **This module COLLECTS. It never tunes.** No code here, and none anywhere
// else, reads these judgments to move a threshold. `TYPED_MIN`,
// `RUNCOUNT_OK_DEFAULT` and the rest stay exactly what they are — tunable
// defaults a human changes deliberately (CLAUDE.md §7). Auto-retuning a
// detector from the opinions of the people it reports to would let the system
// quietly learn to stop reporting, which is the opposite of what a forensic
// tool is for.

/**
 * The metrics a judgment is MEANINGFUL for: the probabilistic, behavioral ones.
 *
 * Deliberately excluded — and the route rejects them — are the FACTUAL Tier-1
 * records: tab-outs, pastes and AST violations. "Was this accurate?" is not a
 * question about a tab-out; the browser either reported one or it did not. An
 * instructor who disagrees with a factual record is reporting a BUG, not
 * calibration data, and mixing the two would poison the dataset this exists to
 * build. `astAudit` is excluded for the same reason: it is a parse result, not
 * an inference.
 */
export const BEHAVIORAL_METRICS = ['metricA', 'metricB', 'metricC', 'authorship'] as const
export type BehavioralMetric = (typeof BEHAVIORAL_METRICS)[number]

export const JUDGMENTS = ['accurate', 'inaccurate'] as const
export type Judgment = (typeof JUDGMENTS)[number]

export function isBehavioralMetric(v: unknown): v is BehavioralMetric {
  return typeof v === 'string' && (BEHAVIORAL_METRICS as readonly string[]).includes(v)
}

export function isJudgment(v: unknown): v is Judgment {
  return typeof v === 'string' && (JUDGMENTS as readonly string[]).includes(v)
}

/**
 * `taskId` is stored as `''` for a session-level judgment, never NULL.
 *
 * Postgres treats NULLs as DISTINCT in a unique index, so with NULL the
 * "one judgment per instructor per session-metric" constraint would silently
 * permit duplicate session-level rows — exactly the idempotency the feature
 * requires. The API still speaks `taskId: null`; this is a storage detail, and
 * `taskIdOut` puts it back.
 */
export const SESSION_SCOPE = ''

export function normalizeTaskId(v: unknown): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : SESSION_SCOPE
}

export function taskIdOut(stored: string): string | null {
  return stored === SESSION_SCOPE ? null : stored
}

export interface ReviewInput {
  metric?: unknown
  judgment?: unknown
  predictedFlag?: unknown
  taskId?: unknown
}

export type ReviewParseResult =
  | { ok: true; metric: BehavioralMetric; judgment: Judgment; predictedFlag: boolean; taskId: string }
  | { ok: false; error: string }

/**
 * Validate a submitted judgment.
 *
 * `predictedFlag` — what the metric SAID at the moment of judging — is
 * REQUIRED, not optional and not derived server-side later. It is the half of
 * the row that makes the data calibratable: without it, "inaccurate" cannot be
 * sorted into a false positive (it flagged, wrongly) or a false negative (it
 * stayed quiet, wrongly), and those two errors have opposite implications for
 * which direction a threshold should move.
 */
export function parseReviewInput(body: ReviewInput): ReviewParseResult {
  if (!isBehavioralMetric(body.metric)) {
    return {
      ok: false,
      error: `Reviews are collected for behavioral metrics only (${BEHAVIORAL_METRICS.join(', ')}). Tier-1 events are factual records, not assessments.`,
    }
  }
  if (!isJudgment(body.judgment)) {
    return { ok: false, error: "judgment must be 'accurate' or 'inaccurate'." }
  }
  if (typeof body.predictedFlag !== 'boolean') {
    return { ok: false, error: 'predictedFlag (what the metric reported) is required.' }
  }
  return {
    ok: true,
    metric: body.metric,
    judgment: body.judgment,
    predictedFlag: body.predictedFlag,
    taskId: normalizeTaskId(body.taskId),
  }
}

/**
 * How a stored row is reported back. Deliberately the full row rather than a
 * tally — see the model comment: counters would destroy the very distinction
 * (predicted vs judged) the calibration depends on.
 */
export function reviewOut(row: {
  id: string
  sessionId: string
  taskId: string
  metric: string
  predictedFlag: boolean
  instructorJudgment: string
  instructorId: string
  updatedAt: Date
}) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    taskId: taskIdOut(row.taskId),
    metric: row.metric,
    predictedFlag: row.predictedFlag,
    judgment: row.instructorJudgment,
    instructorId: row.instructorId,
    updatedAt: row.updatedAt,
  }
}
