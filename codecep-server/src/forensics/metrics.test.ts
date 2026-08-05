import { describe, it, expect } from 'vitest'
import {
  computeRoboticVariance,
  computeLinearInjection,
  computeAuthorship,
  finalCodeLengthOf,
  finalFileSnapshots,
  isCodeFileName,
  markInconclusiveIfSubstantial,
  ROBOTIC_CV_MAX,
  LINEAR_DELETE_RATIO_MAX,
  LINEAR_SINGLE_CHAR_RATIO_MIN,
  LINEAR_INSUFFICIENT_REASON,
  ROBOTIC_INSUFFICIENT_REASON,
  MIN_CODE_LEN,
  TYPED_MIN,
  DEFAULT_TASK,
  taskIdsIn,
  taskLabel,
  finalTaskSnapshots,
  codeLengthOfFiles,
  playbackLogForTask,
  burstHistoryForTask,
  runCountForTask,
  computeMergedReview,
  flaggedMetricsOf,
} from './metrics'

// ── Metric C: Robotic Variance ─────────────────────────────────────────────

describe('computeRoboticVariance', () => {
  it('returns flag=false for too few samples', () => {
    const result = computeRoboticVariance([
      { meanTimeBetweenKeystrokes: 200 },
      { meanTimeBetweenKeystrokes: 250 },
    ])
    expect(result.flag).toBe(false)
    expect(result.reason).toContain('Too few')
  })

  it('flags robotic session (all same timing = CV of 0)', () => {
    const bursts = Array(5).fill({ meanTimeBetweenKeystrokes: 200 })
    const result = computeRoboticVariance(bursts)
    expect(result.flag).toBe(true)
    expect(result.stats.cv).toBe(0)
  })

  it('does not flag genuine session with high variance', () => {
    const bursts = [
      { meanTimeBetweenKeystrokes: 100 },
      { meanTimeBetweenKeystrokes: 800 },
      { meanTimeBetweenKeystrokes: 200 },
      { meanTimeBetweenKeystrokes: 1200 },
      { meanTimeBetweenKeystrokes: 50 },
    ]
    const result = computeRoboticVariance(bursts)
    expect(result.flag).toBe(false)
    expect(result.stats.cv).toBeGreaterThan(ROBOTIC_CV_MAX)
  })

  it('drops nulls and zeros before computing', () => {
    const bursts = [
      { meanTimeBetweenKeystrokes: null },
      { meanTimeBetweenKeystrokes: 0 },
      { meanTimeBetweenKeystrokes: 200 },
      { meanTimeBetweenKeystrokes: 200 },
      { meanTimeBetweenKeystrokes: 200 },
    ]
    const result = computeRoboticVariance(bursts)
    expect(result.stats.sampleCount).toBe(3)
    expect(result.flag).toBe(true)
  })

  it('always returns stats object even when not flagged', () => {
    const bursts = [
      { meanTimeBetweenKeystrokes: 100 },
      { meanTimeBetweenKeystrokes: 500 },
      { meanTimeBetweenKeystrokes: 900 },
    ]
    const result = computeRoboticVariance(bursts)
    expect(result.stats).toBeDefined()
    expect(result.stats.cv).toBeDefined()
  })
})

// ── Metric B: Linear Injection ─────────────────────────────────────────────

describe('computeLinearInjection', () => {
  it('returns flag=false for too few events', () => {
    const log = [{ flushedAt: 1, codeSnapshot: '', events: Array(10).fill({ actionType: 'type', charDelta: 1 }) }]
    const result = computeLinearInjection(log)
    expect(result.flag).toBe(false)
    expect(result.reason).toContain('short')
  })

  it('flags purely linear session', () => {
    const events = Array(30).fill({ actionType: 'type', charDelta: 1 })
    const log = [{ flushedAt: 1, codeSnapshot: '', events }]
    const result = computeLinearInjection(log)
    expect(result.flag).toBe(true)
    expect(result.stats.deleteRatio).toBe(0)
    expect(result.stats.singleCharTypeRatio).toBe(1)
  })

  it('does not flag session with genuine backtracking', () => {
    const events = [
      ...Array(20).fill({ actionType: 'type', charDelta: 1 }),
      ...Array(5).fill({ actionType: 'delete', charDelta: -1 }),
      ...Array(5).fill({ actionType: 'type', charDelta: 1 }),
    ]
    const log = [{ flushedAt: 1, codeSnapshot: '', events }]
    const result = computeLinearInjection(log)
    expect(result.flag).toBe(false)
    expect(result.stats.deleteRatio).toBeGreaterThan(LINEAR_DELETE_RATIO_MAX)
  })

  it('flattens events across multiple playback entries', () => {
    const entry = (n: number) => ({
      flushedAt: n,
      codeSnapshot: '',
      events: Array(15).fill({ actionType: 'type', charDelta: 1 }),
    })
    const log = [entry(1), entry(2)]
    const result = computeLinearInjection(log)
    expect(result.stats.totalEvents).toBe(30)
    expect(result.flag).toBe(true)
  })

  it('always returns stats object', () => {
    const events = Array(25).fill({ actionType: 'type', charDelta: 1 })
    const log = [{ flushedAt: 1, codeSnapshot: '', events }]
    const result = computeLinearInjection(log)
    expect(result.stats).toBeDefined()
    expect(result.stats.deleteCount).toBeDefined()
  })
})

// ── Authorship (Session 22) ────────────────────────────────────────────────
// The paste-everything evasion: B and C reason about the SHAPE of a keystroke
// stream, so a session with almost no stream trips their guards and reads
// clean. Authorship counts CHARACTERS instead.

const snapshot = (len: number) => 'x'.repeat(len)

describe('computeAuthorship', () => {
  it('does not flag a typed-heavy session', () => {
    // 400 characters, every one of them typed.
    const events = Array(400).fill({ actionType: 'type', charDelta: 1 })
    const log = [{ flushedAt: 1, codeSnapshot: snapshot(400), events }]
    const result = computeAuthorship(log, 400)
    expect(result.flag).toBe(false)
    expect(result.reason).toBeNull()
    expect(result.stats.typedRatio).toBe(1)
    expect(result.stats.pastedChars).toBe(0)
  })

  it('flags a pasted-heavy session (the paste-everything cheat)', () => {
    // One paste delivers the whole program; a handful of keystrokes follow.
    const events = [
      { actionType: 'paste', charDelta: 900 },
      ...Array(10).fill({ actionType: 'type', charDelta: 1 }),
    ]
    const log = [{ flushedAt: 1, codeSnapshot: snapshot(910), events }]
    const result = computeAuthorship(log, 910)
    expect(result.flag).toBe(true)
    expect(result.reason).toContain('requires instructor review')
    expect(result.stats.pastedChars).toBe(900)
    expect(result.stats.typedRatio).toBeLessThan(TYPED_MIN)
  })

  it('never flags a program shorter than MIN_CODE_LEN', () => {
    // A tiny stub pasted in is not evidence of anything.
    const log = [{ flushedAt: 1, codeSnapshot: snapshot(40), events: [{ actionType: 'paste', charDelta: 40 }] }]
    const result = computeAuthorship(log, 40)
    expect(result.stats.finalCodeLength).toBeLessThan(MIN_CODE_LEN)
    expect(result.flag).toBe(false)
  })

  it('counts only positive deltas as typed and flattens across flushes', () => {
    const log = [
      { flushedAt: 1, codeSnapshot: snapshot(50), events: Array(60).fill({ actionType: 'type', charDelta: 1 }) },
      { flushedAt: 2, codeSnapshot: snapshot(100), events: [{ actionType: 'delete', charDelta: -10 }] },
    ]
    const result = computeAuthorship(log, 100)
    expect(result.stats.typedChars).toBe(60) // the -10 delete is not subtracted
    expect(result.stats.typedRatio).toBe(0.6)
    expect(result.flag).toBe(false)
  })

  it('reads the final code length from the last non-empty snapshot', () => {
    const log = [
      { flushedAt: 1, codeSnapshot: snapshot(120), events: [] },
      { flushedAt: 2, codeSnapshot: '', events: [] },
    ]
    expect(finalCodeLengthOf(log)).toBe(120)
    expect(finalCodeLengthOf([])).toBe(0)
  })
})

describe('markInconclusiveIfSubstantial', () => {
  it('re-words a tripped guard when a substantial program was submitted', () => {
    const guarded = computeLinearInjection([{ flushedAt: 1, codeSnapshot: snapshot(900), events: [] }])
    expect(guarded.reason).toBe(LINEAR_INSUFFICIENT_REASON)
    const tagged = markInconclusiveIfSubstantial(guarded, LINEAR_INSUFFICIENT_REASON, 900)
    expect(tagged.inconclusive).toBe(true)
    expect(tagged.reason).toContain('see the authorship metric')
    expect(tagged.flag).toBe(false) // the math is untouched
    expect(tagged.stats).toEqual(guarded.stats)
  })

  it('leaves a tripped guard alone on a trivially short session', () => {
    const guarded = computeRoboticVariance([{ meanTimeBetweenKeystrokes: 200 }])
    const tagged = markInconclusiveIfSubstantial(guarded, ROBOTIC_INSUFFICIENT_REASON, 20)
    expect(tagged.inconclusive).toBeUndefined()
    expect(tagged.reason).toBe(ROBOTIC_INSUFFICIENT_REASON)
  })

  it('leaves a genuinely assessed metric alone', () => {
    const assessed = computeRoboticVariance([
      { meanTimeBetweenKeystrokes: 100 },
      { meanTimeBetweenKeystrokes: 800 },
      { meanTimeBetweenKeystrokes: 200 },
    ])
    const tagged = markInconclusiveIfSubstantial(assessed, ROBOTIC_INSUFFICIENT_REASON, 900)
    expect(tagged.inconclusive).toBeUndefined()
    expect(tagged.reason).toBe(assessed.reason)
  })
})

// ── Telemetry Capture v2 (Session 24) — per-file authorship ─────────────────
// The denominator used to be the last `codeSnapshot`, i.e. whichever single
// file happened to be active at flush time. On a multi-file submission that
// could be a 40-character header while the student had written a 900-character
// program, making typedRatio meaningless. It is now the whole program.

const v2ev = (
  actionType: 'type' | 'paste' | 'delete',
  charDelta: number,
  fileName: string,
) => ({
  timestamp: 0,
  timeSinceLastKeystrokeMs: 100,
  actionType,
  charDelta,
  textLength: 0,
  fileName,
})

describe('isCodeFileName', () => {
  it('counts .cpp and .h as code, data files as not', () => {
    expect(isCodeFileName('main.cpp')).toBe(true)
    expect(isCodeFileName('Student.h')).toBe(true)
    expect(isCodeFileName('data.txt')).toBe(false)
    expect(isCodeFileName('scores.csv')).toBe(false)
    expect(isCodeFileName('raw.dat')).toBe(false)
  })

  it('treats an unnamed file as code, preserving pre-v2 sessions', () => {
    // Pre-v2 events have no fileName and were always single-file C++.
    // Dropping them from the numerator would fabricate a paste signal.
    expect(isCodeFileName(null)).toBe(true)
    expect(isCodeFileName(undefined)).toBe(true)
  })
})

describe('finalCodeLengthOf — per-file denominator', () => {
  it('sums every CODE file, not just the active buffer', () => {
    const log = [
      {
        flushedAt: 1,
        codeSnapshot: 'short', // the active buffer happened to be tiny
        fileSnapshots: {
          'main.cpp': 'x'.repeat(400),
          'Student.h': 'y'.repeat(200),
          'Student.cpp': 'z'.repeat(300),
        },
        events: [],
      },
    ]
    expect(finalCodeLengthOf(log)).toBe(900)
  })

  it('excludes data files from the program length', () => {
    const log = [
      {
        flushedAt: 1,
        codeSnapshot: '',
        fileSnapshots: { 'main.cpp': 'x'.repeat(100), 'data.txt': 'y'.repeat(5000) },
        events: [],
      },
    ]
    expect(finalCodeLengthOf(log)).toBe(100)
  })

  it('falls back to the last codeSnapshot for a pre-v2 session', () => {
    const log = [{ flushedAt: 1, codeSnapshot: 'int main(){}', events: [] }]
    expect(finalCodeLengthOf(log)).toBe(12)
  })
})

describe('finalFileSnapshots', () => {
  it('returns the recorded workspace', () => {
    const log = [
      { flushedAt: 1, codeSnapshot: 'a', fileSnapshots: { 'main.cpp': 'a', 'd.txt': 'b' }, events: [] },
    ]
    expect(finalFileSnapshots(log)).toEqual({ 'main.cpp': 'a', 'd.txt': 'b' })
  })

  it('presents a pre-v2 session as a single main.cpp', () => {
    const log = [{ flushedAt: 1, codeSnapshot: 'int main(){}', events: [] }]
    expect(finalFileSnapshots(log)).toEqual({ 'main.cpp': 'int main(){}' })
  })
})

describe('computeAuthorship — per-file (Session 24)', () => {
  const codeFiles = {
    'main.cpp': 'm'.repeat(300),
    'Student.h': 'h'.repeat(100),
  }

  it('sums typed characters across ALL code files', () => {
    const log = [
      {
        flushedAt: 1,
        codeSnapshot: codeFiles['Student.h'],
        fileSnapshots: codeFiles,
        events: [v2ev('type', 300, 'main.cpp'), v2ev('type', 100, 'Student.h')],
      },
    ]
    const len = finalCodeLengthOf(log)
    expect(len).toBe(400)
    const r = computeAuthorship(log, len)
    expect(r.stats.typedChars).toBe(400)
    expect(r.stats.typedRatio).toBe(1)
    expect(r.flag).toBe(false)
  })

  it('does NOT count typing in a DATA file toward the program', () => {
    // A student pasting a CSV of test data into data.txt is not pasting code.
    const log = [
      {
        flushedAt: 1,
        codeSnapshot: '',
        fileSnapshots: { ...codeFiles, 'data.txt': 'd'.repeat(9000) },
        events: [
          v2ev('type', 400, 'main.cpp'),
          v2ev('paste', 9000, 'data.txt'), // huge, but irrelevant to authorship
        ],
      },
    ]
    const len = finalCodeLengthOf(log)
    expect(len).toBe(400) // data.txt excluded from the denominator
    const r = computeAuthorship(log, len)
    expect(r.stats.pastedChars).toBe(0) // ...and from the numerator
    expect(r.stats.typedRatio).toBe(1)
    expect(r.flag).toBe(false)
  })

  it('flags a session whose CODE files were pasted', () => {
    const log = [
      {
        flushedAt: 1,
        codeSnapshot: '',
        fileSnapshots: codeFiles,
        events: [v2ev('paste', 380, 'main.cpp'), v2ev('type', 20, 'Student.h')],
      },
    ]
    const r = computeAuthorship(log, finalCodeLengthOf(log))
    expect(r.stats.pastedChars).toBe(380)
    expect(r.stats.typedRatio).toBeLessThan(TYPED_MIN)
    expect(r.flag).toBe(true)
  })

  it('still works unchanged on a pre-v2 single-file session', () => {
    const log = [
      {
        flushedAt: 1,
        codeSnapshot: 'x'.repeat(200),
        events: [
          { timestamp: 0, timeSinceLastKeystrokeMs: 1, actionType: 'type' as const, charDelta: 200, textLength: 200 },
        ],
      },
    ]
    const r = computeAuthorship(log, finalCodeLengthOf(log))
    expect(r.stats.typedRatio).toBe(1)
    expect(r.flag).toBe(false)
  })
})

// ── Multi-task exams (Prompt 1) ────────────────────────────────────────────
// Tasks are a dimension inside the same JSONB, so every selector below has to
// hold two properties at once: it must slice a multi-task session correctly,
// AND it must leave a pre-multi-task session reading exactly as it did before.
describe('multi-task selectors', () => {
  const ev = (
    task: string | null,
    file: string,
    kind: 'type' | 'paste',
    delta: number,
  ) => ({
    timestamp: 0,
    timeSinceLastKeystrokeMs: 100,
    actionType: kind,
    charDelta: delta,
    textLength: delta,
    fileName: file,
    ...(task === null ? {} : { taskId: task }),
  })

  const multiTaskLog = [
    {
      flushedAt: 1,
      codeSnapshot: 'a'.repeat(100),
      fileSnapshots: { 'main.cpp': 'a'.repeat(100) },
      taskSnapshots: {
        task1: { 'main.cpp': 'a'.repeat(100) },
        task2: { 'main.cpp': '' },
      },
      events: [ev('task1', 'main.cpp', 'type', 100)],
    },
    {
      flushedAt: 2,
      codeSnapshot: 'b'.repeat(200),
      fileSnapshots: { 'main.cpp': 'b'.repeat(200) },
      taskSnapshots: {
        task1: { 'main.cpp': 'a'.repeat(100) },
        task2: { 'main.cpp': 'b'.repeat(200), 'data.txt': 'x'.repeat(500) },
      },
      events: [ev('task2', 'main.cpp', 'paste', 200)],
    },
  ]

  it('lists every task that produced data, in exam order', () => {
    expect(taskIdsIn(multiTaskLog)).toEqual(['task1', 'task2'])
  })

  it('presents a pre-multi-task session as the single default task', () => {
    const legacy = [
      {
        flushedAt: 1,
        codeSnapshot: 'int main(){}',
        events: [ev(null, 'main.cpp', 'type', 12)],
      },
    ]
    expect(taskIdsIn(legacy)).toEqual([DEFAULT_TASK])
    expect(finalTaskSnapshots(legacy)).toEqual({
      [DEFAULT_TASK]: { 'main.cpp': 'int main(){}' },
    })
  })

  it('labels task ids for the report', () => {
    expect(taskLabel('task3')).toBe('Task 3')
  })

  it('takes the LATEST snapshot of each task, including one left early', () => {
    const snaps = finalTaskSnapshots(multiTaskLog)
    // task1 was abandoned after the first window but its files are still known.
    expect(snaps.task1).toEqual({ 'main.cpp': 'a'.repeat(100) })
    expect(snaps.task2['main.cpp']).toBe('b'.repeat(200))
  })

  it('excludes data files from a task code length, as v2 does', () => {
    expect(codeLengthOfFiles(finalTaskSnapshots(multiTaskLog).task2)).toBe(200)
  })

  it('sums every task for the SESSION-level denominator', () => {
    // 100 (task1 main.cpp) + 200 (task2 main.cpp); data.txt excluded.
    expect(finalCodeLengthOf(multiTaskLog)).toBe(300)
  })

  it('leaves finalCodeLengthOf untouched on a session with no task snapshots', () => {
    const legacy = [{ flushedAt: 1, codeSnapshot: 'z'.repeat(42), events: [] }]
    expect(finalCodeLengthOf(legacy)).toBe(42)
  })

  it('narrows the playback log to one task without changing its shape', () => {
    const only2 = playbackLogForTask(multiTaskLog, 'task2')
    expect(only2).toHaveLength(1)
    expect(only2[0].events).toHaveLength(1)
    expect(only2[0].events[0].charDelta).toBe(200)
  })

  it('scores a pasted task as pasted while a typed task stays clean', () => {
    const snaps = finalTaskSnapshots(multiTaskLog)
    const typed = computeAuthorship(
      playbackLogForTask(multiTaskLog, 'task1'),
      codeLengthOfFiles(snaps.task1),
    )
    const pasted = computeAuthorship(
      playbackLogForTask(multiTaskLog, 'task2'),
      codeLengthOfFiles(snaps.task2),
    )
    expect(typed.stats.typedRatio).toBe(1)
    expect(typed.flag).toBe(false)
    expect(pasted.stats.typedRatio).toBe(0)
    expect(pasted.flag).toBe(true)
  })

  it('selects the burst entries of one task by window alignment', () => {
    const bursts = [
      { meanTimeBetweenKeystrokes: 111 },
      { meanTimeBetweenKeystrokes: 222 },
    ]
    expect(burstHistoryForTask(multiTaskLog, bursts, 'task1')).toEqual([
      bursts[0],
    ])
    expect(burstHistoryForTask(multiTaskLog, bursts, 'task2')).toEqual([
      bursts[1],
    ])
  })

  it('treats an untagged event as the default task, so legacy slices whole', () => {
    const legacy = [
      {
        flushedAt: 1,
        codeSnapshot: 'q'.repeat(90),
        events: [ev(null, 'main.cpp', 'type', 90)],
      },
    ]
    expect(playbackLogForTask(legacy, DEFAULT_TASK)[0].events).toHaveLength(1)
  })
})

// ── Per-task run counts (Prompt 2 — gap #29) ───────────────────────────────

describe('runCountForTask', () => {
  it('reads a task\'s own count from the recorded map', () => {
    const map = { task1: 5, task2: 1 }
    expect(runCountForTask(map, 'task1', 6, 2)).toEqual({ runCount: 5, scope: 'task' })
    expect(runCountForTask(map, 'task2', 6, 2)).toEqual({ runCount: 1, scope: 'task' })
  })

  it('reports 0 runs at TASK scope for a tracked task that was never run', () => {
    // The map exists, so the absence of the key is a measurement, not a gap:
    // this task genuinely was never compiled.
    expect(runCountForTask({ task1: 4 }, 'task3', 4, 3)).toEqual({ runCount: 0, scope: 'task' })
  })

  it('falls back to the session total at TASK scope for a single-task session', () => {
    // With one task the session total IS that task's count, so it is honest to
    // report it as measured.
    expect(runCountForTask(null, 'task1', 3, 1)).toEqual({ runCount: 3, scope: 'task' })
  })

  it('falls back to the session total at SESSION scope for a legacy multi-task session', () => {
    // Recorded before per-task tracking: the total is all there is, and it must
    // be labelled rather than repeated per task as though measured there.
    expect(runCountForTask(undefined, 'task2', 7, 3)).toEqual({ runCount: 7, scope: 'session' })
  })

  it('ignores a non-object record and never returns a negative or fractional count', () => {
    expect(runCountForTask('nonsense', 'task1', 2, 1)).toEqual({ runCount: 2, scope: 'task' })
    expect(runCountForTask({ task1: -3 }, 'task1', 9, 2)).toEqual({ runCount: 0, scope: 'task' })
    expect(runCountForTask({ task1: 2.7 }, 'task1', 9, 2)).toEqual({ runCount: 2, scope: 'task' })
  })
})

// ── Merged review signal (Prompt 2 — gap #31) ──────────────────────────────

describe('computeMergedReview', () => {
  const clean = {
    label: 'Task 1',
    metricA: { flag: false },
    metricB: { flag: false },
    metricC: { flag: false },
    authorship: { flag: false },
    astAudit: { flag: false },
  }
  const pasted = {
    label: 'Task 2',
    metricA: { flag: false },
    metricB: { flag: false },
    metricC: { flag: false },
    authorship: { flag: true },
    astAudit: { flag: false },
  }

  it('flags the session when ANY task flags, even though the session average does not', () => {
    // This is gap #31 exactly: two hand-typed tasks pull the session-wide
    // authorship back over the threshold, so the session-level result is clean.
    const sessionLevel = {
      metricA: { flag: false },
      metricB: { flag: false },
      metricC: { flag: false },
      authorship: { flag: false },
      astAudit: { flag: false },
    }
    const merged = computeMergedReview(
      { task1: clean, task2: pasted, task3: { ...clean, label: 'Task 3' } },
      sessionLevel,
      3,
    )
    expect(merged.flag).toBe(true)
    expect(merged.basis).toBe('any-task-flagged')
    expect(merged.flaggedTaskCount).toBe(1)
    expect(merged.flaggedTasks).toEqual([
      { taskId: 'task2', label: 'Task 2', metrics: ['authorship'] },
    ])
    expect(merged.reason).toContain('Task 2')
    expect(merged.reason).toContain('instructor review')
  })

  it('does not flag when no task and no session-wide signal flags', () => {
    const merged = computeMergedReview({ task1: clean }, { authorship: { flag: false } }, 1)
    expect(merged.flag).toBe(false)
    expect(merged.flaggedTaskCount).toBe(0)
    expect(merged.reason).toBeNull()
  })

  it('flags on a session-wide signal even when every task reads clean', () => {
    const merged = computeMergedReview({ task1: clean }, { astAudit: { flag: true } }, 1)
    expect(merged.flag).toBe(true)
    expect(merged.sessionFlaggedMetrics).toEqual(['astAudit'])
    expect(merged.reason).toContain('Session-wide')
  })

  it('lists every flagged metric of a task, in exam order', () => {
    const merged = computeMergedReview(
      {
        task2: { ...pasted, metricA: { flag: true } },
        task1: { ...clean, metricC: { flag: true } },
      },
      {},
      2,
    )
    expect(merged.flaggedTasks.map((t) => t.taskId)).toEqual(['task1', 'task2'])
    expect(merged.flaggedTasks[1].metrics).toEqual(['metricA', 'authorship'])
  })

  it('flaggedMetricsOf ignores missing metrics and non-true flags', () => {
    expect(flaggedMetricsOf(null)).toEqual([])
    expect(flaggedMetricsOf({ metricB: { flag: 'yes' }, authorship: { flag: true } })).toEqual([
      'authorship',
    ])
  })
})
