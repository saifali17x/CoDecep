// ── Post-submission forensic metrics (Phase 5) ─────────────────────────────
// Pure functions — no Prisma, no Redis, no Express. Extracted from server.ts
// so they can be unit-tested without spinning up the full server.
// All metrics are probabilistic signals reviewed by a human instructor,
// never definitive verdicts.

// Thresholds are named constants so they can be tuned without hunting through logic.
export const LINEAR_DELETE_RATIO_MAX = 0.02       // flag if fewer than 2% of events are deletions
export const LINEAR_SINGLE_CHAR_RATIO_MIN = 0.90  // flag if more than 90% are single-char forward types
export const ROBOTIC_CV_MAX = 0.15                // flag if coefficient of variation is below this

// ── Authorship (Session 22) — tunable DEFAULTS, not empirical law ──────────
// MIN_CODE_LEN: below this a submission is too small to reason about at all
// (a stub, an abandoned attempt); TYPED_MIN: the share of the final program we
// expect to have arrived through typing. Both are instructor-tunable guidance.
export const MIN_CODE_LEN = 80
export const TYPED_MIN = 0.30

// The exact "not enough signal" reasons Metrics B and C return when their
// guards trip. Exported so the worker can recognise a guard result without
// touching either metric's math.
export const LINEAR_INSUFFICIENT_REASON = 'Session too short to assess linearity'
export const ROBOTIC_INSUFFICIENT_REASON = 'Too few bursts to assess rhythm'
// Deliberately says "keystroke data", not "typing activity": B's guard trips on
// too few EVENTS and C's on too few BURSTS, and a short genuine session can trip
// C's. Either way the honest reading is "not assessable here — look at
// authorship", never "clean".
export const INSUFFICIENT_TYPING_NOTE =
  'insufficient keystroke data to assess on a substantial program; see the authorship metric'

export interface PlaybackEvent {
  timestamp: number
  timeSinceLastKeystrokeMs: number
  actionType: 'type' | 'paste' | 'delete'
  charDelta: number
  textLength: number
}

export interface PlaybackEntry {
  flushedAt: number
  codeSnapshot: string
  events: PlaybackEvent[]
}

interface BurstEntry {
  meanTimeBetweenKeystrokes?: number | null
}

// ── Metric A — Trial-and-error / low compile count ─────────────────────────
// Genuine work has many compile attempts; a pasted solution typically has 0–1.
export function computeMetricA(runCount: number) {
  const flag = runCount <= 1
  return {
    runCount,
    flag,
    reason: flag
      ? 'Low compile count — probabilistic signal of pasted solution; requires instructor review'
      : null,
  }
}

// ── Metric B — Linear Injection Detection ──────────────────────────────────
export function computeLinearInjection(playbackLog: unknown) {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  const allEvents: PlaybackEvent[] = entries.flatMap((entry) => entry.events ?? [])
  const totalEvents = allEvents.length

  if (totalEvents < 20) {
    return {
      flag: false,
      reason: 'Session too short to assess linearity',
      stats: { totalEvents, deleteCount: 0, deleteRatio: 0, singleCharTypeRatio: 0, pasteCount: 0 },
    }
  }

  const deleteCount = allEvents.filter((e) => e.actionType === 'delete').length
  const deleteRatio = deleteCount / totalEvents
  const singleCharTypeCount = allEvents.filter(
    (e) => e.actionType === 'type' && Math.abs(e.charDelta) <= 2
  ).length
  const singleCharTypeRatio = singleCharTypeCount / totalEvents
  const pasteCount = allEvents.filter((e) => e.actionType === 'paste').length

  const flag = deleteRatio < LINEAR_DELETE_RATIO_MAX && singleCharTypeRatio > LINEAR_SINGLE_CHAR_RATIO_MIN

  return {
    flag,
    reason: flag
      ? 'Highly linear keystroke stream (minimal backtracking) — probabilistic signal of transcription/auto-typing; requires instructor review'
      : null,
    stats: { totalEvents, deleteCount, deleteRatio, singleCharTypeRatio, pasteCount },
  }
}

// ── Metric C — Robotic Variance ────────────────────────────────────────────
// CV = stddev / mean over burst_history[].meanTimeBetweenKeystrokes.
// Humans have high timing variance (thinking pauses, bursts); an auto-typer
// produces an inhumanly uniform rhythm → low CV.
// A type alias (not interface) so it satisfies Prisma's InputJsonValue,
// which requires an implicit index signature.
export type RoboticVarianceResult = {
  flag: boolean
  reason: string | null
  stats: {
    sampleCount: number
    mean: number | null
    stddev: number | null
    cv: number | null
  }
}

export function computeRoboticVariance(burstHistory: unknown): RoboticVarianceResult {
  const entries = (burstHistory as BurstEntry[]) ?? []
  const samples = entries
    .map((entry) => entry?.meanTimeBetweenKeystrokes)
    .filter((v): v is number => typeof v === 'number' && v > 0)
  const n = samples.length

  if (n < 3) {
    return {
      flag: false,
      reason: 'Too few bursts to assess rhythm',
      stats: { sampleCount: n, mean: null, stddev: null, cv: null },
    }
  }

  const mean = samples.reduce((a, b) => a + b, 0) / n
  const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n // population variance
  const stddev = Math.sqrt(variance)
  const cv = stddev / mean
  const flag = cv < ROBOTIC_CV_MAX

  return {
    flag,
    reason: flag
      ? 'Unusually consistent inter-keystroke timing (low CV) — probabilistic signal of automated typing; requires instructor review'
      : null,
    stats: {
      sampleCount: n,
      mean: Math.round(mean),
      stddev: parseFloat(stddev.toFixed(3)),
      cv: parseFloat(cv.toFixed(4)),
    },
  }
}

// ── Authorship — where did the final code actually come from? ──────────────
// Metrics B and C both reason about the SHAPE of a keystroke stream, so the
// crudest cheat defeats them: paste the whole solution and there is almost no
// stream left to shape-check — B and C trip their too-little-data guards and
// the session reads as clean. Authorship asks a different question, in
// CHARACTERS rather than events: how much of the submitted program can be
// accounted for by typing? A probabilistic signal for instructor review.
export type AuthorshipResult = {
  flag: boolean
  reason: string | null
  stats: {
    finalCodeLength: number
    typedChars: number
    pastedChars: number
    typedRatio: number
    pastedRatio: number
  }
}

export function computeAuthorship(playbackLog: unknown, finalCodeLength: number): AuthorshipResult {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  const allEvents: PlaybackEvent[] = entries.flatMap((entry) => entry.events ?? [])

  // Only positive deltas count as authored characters; deletions are handled
  // by the final length, not by subtracting from the typed budget.
  const typedChars = allEvents
    .filter((e) => e.actionType === 'type' && e.charDelta > 0)
    .reduce((sum, e) => sum + e.charDelta, 0)
  const pastedChars = allEvents
    .filter((e) => e.actionType === 'paste' && e.charDelta > 0)
    .reduce((sum, e) => sum + e.charDelta, 0)

  const denominator = Math.max(finalCodeLength, 1)
  const typedRatio = typedChars / denominator
  const pastedRatio = pastedChars / denominator

  // A real program exists, but under TYPED_MIN of it came from typing.
  const flag = finalCodeLength >= MIN_CODE_LEN && typedRatio < TYPED_MIN

  return {
    flag,
    reason: flag
      ? 'Most of the final code did not originate from typing (high pasted-content ratio) — probabilistic signal of pasted solution; requires instructor review'
      : null,
    stats: {
      finalCodeLength,
      typedChars,
      pastedChars,
      typedRatio: parseFloat(typedRatio.toFixed(4)),
      pastedRatio: parseFloat(pastedRatio.toFixed(4)),
    },
  }
}

// Length of the last flushed codeSnapshot — the submitted program. Scans
// backwards so an empty trailing snapshot can't zero out the denominator.
export function finalCodeLengthOf(playbackLog: unknown): number {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  for (let i = entries.length - 1; i >= 0; i--) {
    const snapshot = entries[i]?.codeSnapshot
    if (typeof snapshot === 'string' && snapshot.length > 0) return snapshot.length
  }
  return 0
}

// ── "Insufficient data" is not a pass on a substantial program ─────────────
// When B or C trip their too-little-data guard on a session that nonetheless
// submitted a full program, the stored reason is re-worded and tagged
// `inconclusive` so no report can read it as a clean result. The metric's math
// and its flag are untouched — authorship is the dominant signal here.
export function markInconclusiveIfSubstantial<T extends { flag: boolean; reason: string | null }>(
  result: T,
  guardReason: string,
  finalCodeLength: number,
): T & { inconclusive?: true } {
  if (result.flag) return result
  if (result.reason !== guardReason) return result
  if (finalCodeLength < MIN_CODE_LEN) return result
  return { ...result, reason: `${guardReason} — ${INSUFFICIENT_TYPING_NOTE}`, inconclusive: true }
}
