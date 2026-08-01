import { describe, it, expect } from 'vitest'
import {
  computeRoboticVariance,
  computeLinearInjection,
  computeAuthorship,
  finalCodeLengthOf,
  markInconclusiveIfSubstantial,
  ROBOTIC_CV_MAX,
  LINEAR_DELETE_RATIO_MAX,
  LINEAR_SINGLE_CHAR_RATIO_MIN,
  LINEAR_INSUFFICIENT_REASON,
  ROBOTIC_INSUFFICIENT_REASON,
  MIN_CODE_LEN,
  TYPED_MIN,
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
