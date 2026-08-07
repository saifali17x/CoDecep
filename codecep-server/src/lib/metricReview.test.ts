import { describe, it, expect } from 'vitest'
import {
  BEHAVIORAL_METRICS,
  isBehavioralMetric,
  normalizeTaskId,
  parseReviewInput,
  reviewOut,
  SESSION_SCOPE,
  taskIdOut,
} from './metricReview'

describe('behavioral-only rule', () => {
  it('accepts the four behavioral metrics', () => {
    for (const m of BEHAVIORAL_METRICS) expect(isBehavioralMetric(m)).toBe(true)
  })

  it('REJECTS factual Tier-1 records and the AST audit', () => {
    // "Was this accurate?" is not a question about a tab-out — the browser
    // either reported one or it did not. An instructor disagreeing with a
    // factual record is reporting a bug, not calibration data, and mixing the
    // two would poison the dataset this table exists to build.
    for (const m of ['TAB_OUT', 'ILLEGAL_PASTE', 'AST_VIOLATION', 'astAudit', 'tier1', 'merged']) {
      expect(isBehavioralMetric(m)).toBe(false)
      const parsed = parseReviewInput({ metric: m, judgment: 'accurate', predictedFlag: true })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toMatch(/behavioral metrics only/)
    }
  })
})

describe('parseReviewInput', () => {
  it('accepts a complete judgment', () => {
    const parsed = parseReviewInput({ metric: 'authorship', judgment: 'inaccurate', predictedFlag: true })
    expect(parsed).toEqual({
      ok: true,
      metric: 'authorship',
      judgment: 'inaccurate',
      predictedFlag: true,
      taskId: SESSION_SCOPE,
    })
  })

  it('carries a task-scoped judgment', () => {
    const parsed = parseReviewInput({
      metric: 'metricC',
      judgment: 'accurate',
      predictedFlag: false,
      taskId: 'task2',
    })
    expect(parsed.ok && parsed.taskId).toBe('task2')
  })

  it('REQUIRES predictedFlag — it is what makes the row calibratable', () => {
    // Without it, "inaccurate" cannot be sorted into a false positive (flagged
    // wrongly) or a false negative (stayed quiet wrongly), and those two point
    // a threshold in opposite directions.
    const parsed = parseReviewInput({ metric: 'metricB', judgment: 'accurate' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/predictedFlag/)
  })

  it('rejects predictedFlag that is not a boolean', () => {
    expect(parseReviewInput({ metric: 'metricB', judgment: 'accurate', predictedFlag: 'true' }).ok).toBe(false)
  })

  it('rejects a judgment outside accurate/inaccurate', () => {
    for (const j of ['maybe', '', 'ACCURATE', true]) {
      const parsed = parseReviewInput({ metric: 'metricA', judgment: j, predictedFlag: true })
      expect(parsed.ok).toBe(false)
    }
  })

  it('accepts a "not flagged but wrong" judgment — the false-negative case', () => {
    const parsed = parseReviewInput({ metric: 'metricA', judgment: 'inaccurate', predictedFlag: false })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.predictedFlag).toBe(false)
  })
})

describe('task scope storage', () => {
  it("stores a session-level judgment as '' so the unique index actually holds", () => {
    // Postgres treats NULLs as DISTINCT in a unique index, so NULL here would
    // silently allow duplicate session-level rows — exactly the idempotency the
    // feature requires.
    expect(normalizeTaskId(null)).toBe('')
    expect(normalizeTaskId(undefined)).toBe('')
    expect(normalizeTaskId('   ')).toBe('')
    expect(normalizeTaskId(7)).toBe('')
  })

  it('round-trips a task id back to the API shape', () => {
    expect(taskIdOut('task3')).toBe('task3')
    expect(taskIdOut('')).toBeNull()
  })
})

describe('reviewOut', () => {
  it('returns the RICH row, keeping predicted and judged separate', () => {
    const at = new Date('2026-08-07T12:00:00Z')
    expect(
      reviewOut({
        id: 'r1',
        sessionId: 's1',
        taskId: '',
        metric: 'metricC',
        predictedFlag: true,
        instructorJudgment: 'inaccurate',
        instructorId: 'i1',
        updatedAt: at,
      }),
    ).toEqual({
      id: 'r1',
      sessionId: 's1',
      taskId: null,
      metric: 'metricC',
      predictedFlag: true,
      judgment: 'inaccurate',
      instructorId: 'i1',
      updatedAt: at,
    })
  })
})
