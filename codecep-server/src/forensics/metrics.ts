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
  // Session 24 (Telemetry Capture v2). All optional: pre-v2 sessions in the
  // database have none of them, and every metric below must keep working on
  // those rows exactly as it did before.
  fileName?: string | null
  rangeOffset?: number
  rangeLength?: number
  insertedText?: string
  changes?: { o: number; d: number; t: string }[]
  /**
   * Multi-task exams (Prompt 1) — which task of the exam this keystroke belongs
   * to. Optional for exactly the same reason `fileName` is: every session
   * already in the database predates tasks, and absence means "the one and only
   * task" rather than "unknown".
   */
  taskId?: string | null
}

export interface PlaybackEntry {
  flushedAt: number
  codeSnapshot: string
  /** Session 24 — the whole workspace at this flush. Absent pre-v2. */
  fileSnapshots?: Record<string, string> | null
  /**
   * Multi-task exams (Prompt 1) — EVERY task's workspace at this flush, not
   * just the active one. `fileSnapshots` above keeps its existing meaning (the
   * active task's files), so pre-multi-task readers are unaffected; this is the
   * source of truth for per-task forensics.
   */
  taskSnapshots?: Record<string, Record<string, string>> | null
  events: PlaybackEvent[]
}

// ── Tasks as a JSONB dimension (multi-task exams, Prompt 1) ────────────────
// A task is deliberately lightweight — an id, a label, and its own file
// workspace. There is no Task table: tasks are attributed the same way files
// were in Session 24, which reuses plumbing that is already proven and keeps
// every pre-multi-task session readable without a data migration.
export const DEFAULT_TASK = 'task1'

/** A missing taskId means the session's single default task, never "unknown". */
export function taskIdOf(taskId: string | null | undefined): string {
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : DEFAULT_TASK
}

/** Human label for reports: 'task3' → 'Task 3'. Unknown ids pass through. */
export function taskLabel(taskId: string): string {
  const match = /^task(\d+)$/.exec(taskId)
  return match ? `Task ${match[1]}` : taskId
}

function compareTaskIds(a: string, b: string): number {
  const na = /^task(\d+)$/.exec(a)
  const nb = /^task(\d+)$/.exec(b)
  if (na && nb) return Number(na[1]) - Number(nb[1])
  return a.localeCompare(b)
}

/**
 * Every task this session produced data for, in exam order.
 *
 * Reads both the events and the per-flush task snapshots, so a task the student
 * opened and typed nothing in still appears (its workspace was snapshotted)
 * rather than silently vanishing from the report.
 */
export function taskIdsIn(playbackLog: unknown): string[] {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  const ids = new Set<string>()
  for (const entry of entries) {
    for (const event of entry?.events ?? []) ids.add(taskIdOf(event?.taskId))
    const perTask = entry?.taskSnapshots
    if (perTask && typeof perTask === 'object') for (const id of Object.keys(perTask)) ids.add(id)
  }
  if (ids.size === 0) ids.add(DEFAULT_TASK)
  return [...ids].sort(compareTaskIds)
}

/**
 * Each task's workspace as last flushed: { taskId: { fileName: fullText } }.
 *
 * Merged forward rather than read from the final entry alone, so the latest
 * snapshot of EACH task wins — a task the student left early is still reported
 * with the files they actually wrote.
 *
 * A session with no task snapshots at all (every row written before this
 * feature) presents its single workspace as `task1`, which is what it always
 * was. That lets every consumer below treat old and new sessions uniformly.
 */
export function finalTaskSnapshots(playbackLog: unknown): Record<string, Record<string, string>> {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  const merged: Record<string, Record<string, string>> = {}
  for (const entry of entries) {
    const perTask = entry?.taskSnapshots
    if (!perTask || typeof perTask !== 'object') continue
    for (const [taskId, files] of Object.entries(perTask)) {
      if (files && typeof files === 'object') merged[taskId] = files as Record<string, string>
    }
  }
  if (Object.keys(merged).length > 0) return merged
  return { [DEFAULT_TASK]: finalFileSnapshots(playbackLog) }
}

/** Summed length of the CODE files in one workspace — an authorship denominator. */
export function codeLengthOfFiles(files: Record<string, string> | null | undefined): number {
  if (!files || typeof files !== 'object') return 0
  return Object.entries(files)
    .filter(([name]) => isCodeFileName(name))
    .reduce((sum, [, text]) => sum + (typeof text === 'string' ? text.length : 0), 0)
}

/**
 * The session's playback_log narrowed to ONE task: same entry shape, with each
 * entry's events filtered to that task and empty entries dropped.
 *
 * Returning the same shape is the point — every existing metric then runs over
 * a single task without knowing tasks exist, so none of their math changes.
 */
export function playbackLogForTask(playbackLog: unknown, taskId: string): PlaybackEntry[] {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  const out: PlaybackEntry[] = []
  for (const entry of entries) {
    const events = (entry?.events ?? []).filter((e) => taskIdOf(e?.taskId) === taskId)
    if (events.length > 0) out.push({ ...entry, events })
  }
  return out
}

/**
 * The burst entries belonging to ONE task.
 *
 * burst_history[i] is derived server-side from playback_log[i]'s chunk, so the
 * two arrays are index-aligned and a burst can be attributed by looking at the
 * tasks of its own window's events. The stored means are reused verbatim —
 * Metric C's input is selected, never recomputed, so its math is untouched.
 */
export function burstHistoryForTask(
  playbackLog: unknown,
  burstHistory: unknown,
  taskId: string,
): unknown[] {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  const bursts = (burstHistory as unknown[]) ?? []
  const out: unknown[] = []
  for (let i = 0; i < entries.length && i < bursts.length; i++) {
    const events = entries[i]?.events ?? []
    if (events.some((e) => taskIdOf(e?.taskId) === taskId)) out.push(bursts[i])
  }
  return out
}

// ── Which files count as CODE ──────────────────────────────────────────────
// Authorship is a statement about the submitted PROGRAM, so data files are
// excluded: a student legitimately pasting a CSV of test data into data.txt is
// not pasting code, and counting it would manufacture a false positive. Mirrors
// the client's lib/workspace.js and the server's lib/multiFile.ts.
const CODE_EXTENSIONS = ['cpp', 'h']

// A pre-v2 event has no fileName. Those sessions were single-file C++ by
// construction, so treating an unnamed file as code preserves their behavior
// exactly rather than silently dropping them from the numerator.
export function isCodeFileName(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return true
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return CODE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
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
  // Session 24 — CODE FILES ONLY. Keystrokes in a .txt/.csv/.dat are real work
  // but they are not part of the submitted program, and the denominator
  // (finalCodeLength) counts only code files, so counting their characters in
  // the numerator would inflate typedRatio above 1.
  const allEvents: PlaybackEvent[] = entries
    .flatMap((entry) => entry.events ?? [])
    .filter((e) => isCodeFileName(e.fileName))

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

/**
 * The workspace as last flushed: { fileName: fullText }.
 *
 * Pre-v2 sessions have no per-file snapshots, so their single `codeSnapshot` is
 * presented as one `main.cpp` — the file it always actually was. That keeps
 * every downstream consumer (submit-time AST audit, per-file replay) able to
 * treat old and new sessions uniformly instead of branching everywhere.
 */
export function finalFileSnapshots(playbackLog: unknown): Record<string, string> {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  for (let i = entries.length - 1; i >= 0; i--) {
    const perFile = entries[i]?.fileSnapshots
    if (perFile && typeof perFile === 'object' && Object.keys(perFile).length > 0) {
      return perFile
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const snapshot = entries[i]?.codeSnapshot
    if (typeof snapshot === 'string' && snapshot.length > 0) return { 'main.cpp': snapshot }
  }
  return {}
}

/**
 * Length of the submitted PROGRAM — the authorship denominator.
 *
 * Session 24: this is now the summed length of every CODE file in the last
 * flush that carried per-file snapshots. Before v2 it was the last
 * `codeSnapshot`, i.e. whichever single file happened to be active at flush
 * time — so on a multi-file submission the denominator could be a 40-character
 * header while the student had written a 900-character program, and typedRatio
 * was meaningless.
 *
 * Falls back to the old single-snapshot behavior for pre-v2 sessions, which is
 * exactly right for them: they only ever had one file.
 */
export function finalCodeLengthOf(playbackLog: unknown): number {
  const entries = (playbackLog as PlaybackEntry[]) ?? []

  // Multi-task (Prompt 1): the SESSION's program is every task's program. The
  // numerator here is every event in the session, so the denominator has to
  // span every task too — scoring all three tasks' keystrokes against one
  // task's files would push typedRatio far above 1 and make the session-level
  // authorship reading meaningless. Per-task denominators are computed
  // separately (codeLengthOfFiles) and are the sharper signal.
  //
  // Falls through untouched when no task snapshots exist, so every session
  // recorded before this feature keeps its exact previous value.
  const hasTaskSnapshots = entries.some(
    (entry) =>
      entry?.taskSnapshots &&
      typeof entry.taskSnapshots === 'object' &&
      Object.keys(entry.taskSnapshots).length > 0,
  )
  if (hasTaskSnapshots) {
    const total = Object.values(finalTaskSnapshots(playbackLog)).reduce(
      (sum, files) => sum + codeLengthOfFiles(files),
      0,
    )
    if (total > 0) return total
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const perFile = entries[i]?.fileSnapshots
    if (perFile && typeof perFile === 'object') {
      const total = Object.entries(perFile)
        .filter(([name]) => isCodeFileName(name))
        .reduce((sum, [, text]) => sum + (typeof text === 'string' ? text.length : 0), 0)
      if (total > 0) return total
    }
  }
  // Pre-v2 session (or a v2 session whose code files are all empty).
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
