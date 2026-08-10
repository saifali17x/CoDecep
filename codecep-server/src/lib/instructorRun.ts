// ── Instructor review run — choosing WHAT to execute ────────────────────────
//
// PURE module. No Express, no Prisma, no Judge0: given the workspaces a
// submitted session recorded (`finalTaskSnapshots(playback_log)`) and the task
// the instructor is looking at, it decides which files go up. Everything that
// actually runs the code is the EXISTING student path (`executeOnJudge0` in
// server.ts) — this only selects its input.
//
// The whole feature is READ-ONLY by construction: nothing here can write, and
// the route that uses it never touches the session row. An instructor running a
// student's submitted code must not create telemetry, must not count as a
// student run, and must not alter the forensic record — so the safest shape is
// one where there is no write to forget to leave out.
//
// Mirrors the file rules in `lib/multiFile.ts` (which then re-validates the
// workspace anyway) rather than re-deriving them: the stored snapshot is data
// read back OUT of the database, so it is treated defensively, exactly as
// `lib/workspace.js` treats a restore on the client.

import { ENTRY_FILE, type WorkspaceFile } from './multiFile'

/** Task ids an exam can have — the same 1–6 bound `Assignment.taskCount` enforces. */
export const TASK_ID_PATTERN = /^task[1-6]$/

export type TaskSelection =
  | { ok: true; taskId: string; files: WorkspaceFile[] }
  | { ok: false; error: string }

/**
 * One task's stored workspace as a Judge0 workspace array.
 *
 * `main.cpp` first because the compile step globs `*.cpp` and a reader of the
 * log should see the entry point first; the rest keep a stable alphabetical
 * order so two runs of the same session package identically.
 *
 * Non-string values are dropped rather than coerced: a snapshot key whose value
 * is not text is corrupt data, and sending "[object Object]" to a compiler
 * would produce a confusing error about the student's code that is really about
 * ours.
 */
export function workspaceFromSnapshot(files: unknown): WorkspaceFile[] {
  if (!files || typeof files !== 'object') return []
  return Object.entries(files as Record<string, unknown>)
    .filter(([name, content]) => typeof name === 'string' && typeof content === 'string')
    .map(([name, content]) => ({ name, content: content as string }))
    .sort((a, b) => {
      if (a.name === ENTRY_FILE) return -1
      if (b.name === ENTRY_FILE) return 1
      return a.name.localeCompare(b.name)
    })
}

/**
 * Which task's code the instructor asked to run.
 *
 * Absent/blank → the session's only task when there is exactly one, so a
 * single-task exam needs no task id at all and every pre-multi-task session
 * keeps working unchanged. On a genuinely multi-task session an absent id is
 * REFUSED rather than guessed: silently running Task 1 when the instructor was
 * reading Task 3 would show them the wrong program and let them believe it was
 * the right one.
 *
 * A task the session recorded no workspace for is refused with a message that
 * says so — an empty run reading "(no output)" is indistinguishable from a
 * program that printed nothing.
 */
export function selectTaskWorkspace(
  snapshots: Record<string, Record<string, string>> | null | undefined,
  requestedTaskId: unknown,
): TaskSelection {
  const map = snapshots && typeof snapshots === 'object' ? snapshots : {}
  const available = Object.keys(map).sort()

  if (requestedTaskId !== undefined && requestedTaskId !== null && requestedTaskId !== '') {
    if (typeof requestedTaskId !== 'string' || !TASK_ID_PATTERN.test(requestedTaskId)) {
      return { ok: false, error: `"taskId" must be one of task1–task6.` }
    }
    const files = workspaceFromSnapshot(map[requestedTaskId])
    if (files.length === 0) {
      return {
        ok: false,
        error: `This session recorded no files for ${requestedTaskId}${
          available.length > 0 ? ` (recorded: ${available.join(', ')})` : ''
        }.`,
      }
    }
    return { ok: true, taskId: requestedTaskId, files }
  }

  if (available.length === 0) {
    return { ok: false, error: 'This session recorded no code to run.' }
  }
  if (available.length > 1) {
    return {
      ok: false,
      error: `This session has ${available.length} tasks — name the one to run ("taskId": ${available
        .map((id) => `"${id}"`)
        .join(' | ')}).`,
    }
  }

  const only = available[0]
  const files = workspaceFromSnapshot(map[only])
  if (files.length === 0) return { ok: false, error: 'This session recorded no code to run.' }
  return { ok: true, taskId: only, files }
}
