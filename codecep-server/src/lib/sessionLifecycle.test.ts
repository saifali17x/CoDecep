import { describe, it, expect } from 'vitest'
import { decideSessionAction, buildRestorePayload } from './sessionLifecycle'

// ── Fix 1: session identity is (student, assignment) — gap #12 ──────────────
// The route filters rows on assignmentId, so "a different assignment" reaches
// this function as an EMPTY list. That is the invariant these tests pin: the
// only way to resume is to have a row for the pair being opened.
describe('decideSessionAction', () => {
  it('creates a fresh session when the pair has no rows at all', () => {
    expect(decideSessionAction([])).toEqual({ action: 'CREATE', sessionId: null })
  })

  it('resumes the IN_PROGRESS session for the same student + assignment', () => {
    expect(decideSessionAction([{ id: 's1', status: 'IN_PROGRESS' }])).toEqual({
      action: 'RESUME',
      sessionId: 's1',
    })
  })

  it('reports ALREADY_SUBMITTED rather than starting a second attempt', () => {
    expect(decideSessionAction([{ id: 's9', status: 'SUBMITTED' }])).toEqual({
      action: 'ALREADY_SUBMITTED',
      sessionId: 's9',
    })
  })

  it('lets SUBMITTED win over a stray IN_PROGRESS row for the same pair', () => {
    // Pre-fix duplicates like this exist in the live database. A student who
    // has submitted this assignment must see the locked state, whichever row
    // happens to have been touched most recently.
    const decision = decideSessionAction([
      { id: 'open', status: 'IN_PROGRESS' },
      { id: 'done', status: 'SUBMITTED' },
    ])
    expect(decision).toEqual({ action: 'ALREADY_SUBMITTED', sessionId: 'done' })
  })

  it('picks the newest IN_PROGRESS row when duplicates exist (caller orders desc)', () => {
    const decision = decideSessionAction([
      { id: 'newest', status: 'IN_PROGRESS' },
      { id: 'older', status: 'IN_PROGRESS' },
    ])
    expect(decision.sessionId).toBe('newest')
  })

  it('creates fresh when the only rows belong to some other status', () => {
    expect(decideSessionAction([{ id: 'x', status: 'ARCHIVED' }]).action).toBe('CREATE')
  })
})

// ── Fix 2: restore the last FLUSHED workspace — gap #4 ──────────────────────
describe('buildRestorePayload', () => {
  it('restores nothing for a session that has never flushed', () => {
    expect(buildRestorePayload([])).toEqual({
      taskSnapshots: {},
      restoredFrom: null,
      lastActive: null,
      windowCount: 0,
    })
  })

  it('restores nothing when the only flush carried an empty buffer', () => {
    const payload = buildRestorePayload([{ flushedAt: 10, codeSnapshot: '', events: [] }])
    expect(payload.taskSnapshots).toEqual({})
    expect(payload.restoredFrom).toBeNull()
  })

  it('restores a pre-v2 single-snapshot session as one main.cpp', () => {
    const payload = buildRestorePayload([
      { flushedAt: 100, codeSnapshot: 'int a;', events: [] },
      { flushedAt: 200, codeSnapshot: 'int a; int b;', events: [] },
    ])
    expect(payload.taskSnapshots).toEqual({ task1: { 'main.cpp': 'int a; int b;' } })
    expect(payload.restoredFrom).toBe(200)
  })

  it('restores the WHOLE multi-file workspace, not just the active buffer', () => {
    const payload = buildRestorePayload([
      {
        flushedAt: 300,
        codeSnapshot: 'int main(){}',
        fileSnapshots: { 'main.cpp': 'int main(){}', 'Student.h': '#pragma once', 'data.txt': '1 2 3' },
        events: [],
      },
    ])
    expect(payload.taskSnapshots.task1).toEqual({
      'main.cpp': 'int main(){}',
      'Student.h': '#pragma once',
      'data.txt': '1 2 3',
    })
  })

  it('restores every task, including one the student left early', () => {
    // Task 2 was abandoned after the first flush; the merge-forward keeps its
    // last known files rather than losing them to the newest window.
    const payload = buildRestorePayload([
      {
        flushedAt: 100,
        taskSnapshots: { task1: { 'main.cpp': 'one' }, task2: { 'main.cpp': 'two-early' } },
        events: [{ taskId: 'task2', fileName: 'main.cpp' }],
      },
      {
        flushedAt: 200,
        taskSnapshots: { task1: { 'main.cpp': 'one-later' } },
        events: [{ taskId: 'task1', fileName: 'main.cpp' }],
      },
    ])
    expect(payload.taskSnapshots).toEqual({
      task1: { 'main.cpp': 'one-later' },
      task2: { 'main.cpp': 'two-early' },
    })
    expect(payload.restoredFrom).toBe(200)
  })

  it('reports where the student was last typing so the right tab reopens', () => {
    const payload = buildRestorePayload([
      {
        flushedAt: 100,
        fileSnapshots: { 'main.cpp': 'x', 'notes.txt': 'y' },
        events: [
          { taskId: 'task2', fileName: 'main.cpp' },
          { taskId: 'task2', fileName: 'notes.txt' },
        ],
      },
    ])
    expect(payload.lastActive).toEqual({ taskId: 'task2', fileName: 'notes.txt' })
  })

  it('tolerates a legacy event with no task or file recorded', () => {
    const payload = buildRestorePayload([
      { flushedAt: 5, codeSnapshot: 'legacy', events: [{}] },
    ])
    expect(payload.lastActive).toEqual({ taskId: null, fileName: null })
    expect(payload.taskSnapshots).toEqual({ task1: { 'main.cpp': 'legacy' } })
  })

  it('never throws on a malformed log', () => {
    expect(buildRestorePayload(null).taskSnapshots).toEqual({})
    expect(buildRestorePayload('not a log').taskSnapshots).toEqual({})
    expect(buildRestorePayload([null, undefined]).taskSnapshots).toEqual({})
  })
})
