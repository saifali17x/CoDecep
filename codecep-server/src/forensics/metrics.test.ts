import { describe, it, expect } from 'vitest'
import {
  computeRoboticVariance,
  computeLinearInjection,
  ROBOTIC_CV_MAX,
  LINEAR_DELETE_RATIO_MAX,
  LINEAR_SINGLE_CHAR_RATIO_MIN,
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
