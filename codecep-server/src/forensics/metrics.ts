// ── Post-submission forensic metrics (Phase 5) ─────────────────────────────
// Pure functions — no Prisma, no Redis, no Express. Extracted from server.ts
// so they can be unit-tested without spinning up the full server.
// All metrics are probabilistic signals reviewed by a human instructor,
// never definitive verdicts.

// Thresholds are named constants so they can be tuned without hunting through logic.
export const LINEAR_DELETE_RATIO_MAX = 0.02       // flag if fewer than 2% of events are deletions
export const LINEAR_SINGLE_CHAR_RATIO_MIN = 0.90  // flag if more than 90% are single-char forward types
export const ROBOTIC_CV_MAX = 0.15                // flag if coefficient of variation is below this

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
