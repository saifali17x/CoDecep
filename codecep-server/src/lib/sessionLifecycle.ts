// ── Session lifecycle: identity and restore (gap-fixes part 2) ──────────────
//
// TWO pure decisions the exam-open path depends on, kept out of the route so
// they can be driven by tests rather than by opening exams in a browser.
//
// 1. WHICH SESSION a student is opening (gap #12). A session used to be keyed
//    on `studentId` ALONE, so a student with any lingering IN_PROGRESS row
//    reused it for whatever assignment they opened next: telemetry filed under
//    the wrong assignmentId, the new assignment's roster reading NOT_STARTED,
//    and — because the old row already held a full exam — a reload appearing to
//    duplicate the student's own text. That last symptom made several genuinely
//    correct builds look broken during testing.
//
// 2. WHAT TO PUT BACK ON SCREEN when that session is resumed (gap #4). The
//    restore reads the last FLUSHED workspace out of `playback_log`: the
//    database is the source of truth, so restored code matches the forensic
//    record exactly and there is no second (browser-storage) copy to drift
//    from it. The honest cost is up to ~30s of unflushed typing, which the UI
//    states plainly rather than papering over.

import { finalTaskSnapshots } from '../forensics/metrics'

export type SessionAction = 'ALREADY_SUBMITTED' | 'RESUME' | 'CREATE'

export interface ExistingSessionRow {
  id: string
  status: string
}

export interface SessionDecision {
  action: SessionAction
  sessionId: string | null
}

/**
 * Decide what opening an exam means, given every session row that already
 * exists for THIS (student, assignment) pair — newest first.
 *
 * The order of the three rules is the whole invariant:
 *
 * - SUBMITTED wins over everything. Reopening a submitted assignment shows the
 *   locked state; it must never silently start a second attempt. This matches
 *   what `GET /api/assignments/:id` already reports as `mySubmittedSession`,
 *   so the two paths cannot disagree about whether a student has submitted.
 * - An IN_PROGRESS row is RESUMED. This is the legitimate reopen/reload case
 *   and the only case where the restore below applies.
 * - Otherwise a fresh session is created.
 *
 * Note what is NOT here: a session belonging to a DIFFERENT assignment. The
 * caller filters on assignmentId, so a different assignment simply produces no
 * rows and falls through to CREATE. Different assignment = different session,
 * always.
 *
 * Pre-fix rows are tolerated rather than migrated: repeated testing left pairs
 * with several rows, so this takes a LIST and picks by rule instead of assuming
 * the invariant already held in the database.
 */
export function decideSessionAction(rows: ExistingSessionRow[]): SessionDecision {
  const submitted = rows.find((r) => r.status === 'SUBMITTED')
  if (submitted) return { action: 'ALREADY_SUBMITTED', sessionId: submitted.id }
  const inProgress = rows.find((r) => r.status === 'IN_PROGRESS')
  if (inProgress) return { action: 'RESUME', sessionId: inProgress.id }
  return { action: 'CREATE', sessionId: null }
}

interface PlaybackEntry {
  flushedAt?: number
  codeSnapshot?: string
  fileSnapshots?: Record<string, string> | null
  taskSnapshots?: Record<string, Record<string, string>> | null
  events?: { taskId?: string | null; fileName?: string | null }[]
}

export interface RestorePayload {
  /** Every task's workspace as last flushed: { taskId: { fileName: text } }. */
  taskSnapshots: Record<string, Record<string, string>>
  /** `flushedAt` of the newest flush that carried a usable snapshot, or null. */
  restoredFrom: number | null
  /** Where the student was last typing, so the right tab reopens. */
  lastActive: { taskId: string | null; fileName: string | null } | null
  /** How many flush windows this session has — 0 means nothing to restore. */
  windowCount: number
}

function hasUsableSnapshot(entry: PlaybackEntry | undefined): boolean {
  if (!entry) return false
  if (entry.taskSnapshots && Object.keys(entry.taskSnapshots).length > 0) return true
  if (entry.fileSnapshots && Object.keys(entry.fileSnapshots).length > 0) return true
  return typeof entry.codeSnapshot === 'string' && entry.codeSnapshot.length > 0
}

/**
 * Build the workspace to put back on screen from a session's `playback_log`.
 *
 * The per-task merge is `finalTaskSnapshots` — the SAME function the forensics
 * worker uses to recover each task's final program. Reusing it is the point:
 * the code a student sees after a refresh is by construction the code the
 * forensic record says they had, rather than a second reconstruction that could
 * disagree with it. It also inherits that function's backward compatibility —
 * a pre-multi-task session presents its single workspace as `task1`, and a
 * pre-v2 session presents its single `codeSnapshot` as `main.cpp`.
 *
 * A session with no flushes yet restores nothing and opens blank, which is
 * exactly right: there is no recorded work to put back.
 */
export function buildRestorePayload(playbackLog: unknown): RestorePayload {
  const entries: PlaybackEntry[] = Array.isArray(playbackLog) ? (playbackLog as PlaybackEntry[]) : []

  let restoredFrom: number | null = null
  for (let i = entries.length - 1; i >= 0; i--) {
    if (hasUsableSnapshot(entries[i])) {
      const at = entries[i]?.flushedAt
      restoredFrom = typeof at === 'number' ? at : null
      break
    }
  }

  // Nothing has been flushed with content yet — open blank, say nothing.
  if (restoredFrom === null && !entries.some(hasUsableSnapshot)) {
    return { taskSnapshots: {}, restoredFrom: null, lastActive: null, windowCount: entries.length }
  }

  // Where the student was last typing. Read from the last EVENT rather than
  // from the snapshot map, because a flush carries every task's files while
  // only one of them was on screen.
  let lastActive: RestorePayload['lastActive'] = null
  for (let i = entries.length - 1; i >= 0 && lastActive === null; i--) {
    const events = entries[i]?.events
    if (!Array.isArray(events)) continue
    for (let j = events.length - 1; j >= 0; j--) {
      const ev = events[j]
      if (!ev) continue
      lastActive = { taskId: ev.taskId ?? null, fileName: ev.fileName ?? null }
      break
    }
  }

  return {
    taskSnapshots: finalTaskSnapshots(entries),
    restoredFrom,
    lastActive,
    windowCount: entries.length,
  }
}
