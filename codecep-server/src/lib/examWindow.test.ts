import { describe, it, expect } from 'vitest'
import { windowStatusFor, isSubmitAllowed, minutesLate, MS_PER_MINUTE } from './examWindow'

const START = new Date('2026-08-07T10:00:00Z')
const startMs = START.getTime()
const min = (n: number) => n * MS_PER_MINUTE

describe('windowStatusFor — the session-relative window', () => {
  it('is UNTIMED when the assignment has no window (every existing assignment)', () => {
    const s = windowStatusFor(null, START, startMs + min(999))
    expect(s.state).toBe('untimed')
    expect(s.deadlineAt).toBeNull()
    expect(isSubmitAllowed(s)).toBe(true)
  })

  it('is untimed for undefined / zero / negative windows', () => {
    for (const w of [undefined, 0, -5]) {
      expect(windowStatusFor(w as number | null | undefined, START, startMs).state).toBe('untimed')
    }
  })

  it('derives the deadline from the SESSION start, not from wall clock', () => {
    const s = windowStatusFor(180, START, startMs + min(1))
    expect(s.deadlineAt).toBe(startMs + min(180))
    expect(s.msRemaining).toBe(min(179))
    expect(s.state).toBe('open')
  })

  it('is OPEN right up to the deadline', () => {
    expect(windowStatusFor(60, START, startMs + min(60)).state).toBe('open')
    expect(windowStatusFor(60, START, startMs + min(60) - 1).state).toBe('open')
  })

  it('is CLOSED one millisecond past the deadline', () => {
    const s = windowStatusFor(60, START, startMs + min(60) + 1)
    expect(s.state).toBe('closed')
    expect(isSubmitAllowed(s)).toBe(false)
  })

  it('never reports negative time remaining', () => {
    expect(windowStatusFor(60, START, startMs + min(600)).msRemaining).toBe(0)
  })

  it('accepts an epoch-ms start as well as a Date', () => {
    expect(windowStatusFor(30, startMs, startMs + min(31)).state).toBe('closed')
  })

  it('treats an unreadable start as UNTIMED, never as closed', () => {
    // Refusing a submission because a timestamp could not be read would punish a
    // student for a data problem that is not theirs; a wrongly-closed window
    // loses work, a wrongly-open one only produces a late timestamp.
    expect(windowStatusFor(60, null, startMs).state).toBe('untimed')
    expect(windowStatusFor(60, Number.NaN, startMs).state).toBe('untimed')
    expect(isSubmitAllowed(windowStatusFor(60, undefined, startMs))).toBe(true)
  })

  it('reports how late a closed submission is', () => {
    const now = startMs + min(75)
    const s = windowStatusFor(60, START, now)
    expect(minutesLate(s, now)).toBe(15)
  })

  it('reports zero lateness while the window is still open', () => {
    const now = startMs + min(10)
    expect(minutesLate(windowStatusFor(60, START, now), now)).toBe(0)
  })

  it('a resumed session keeps its ORIGINAL deadline — a refresh buys no time', () => {
    // Same start, evaluated an hour later: the deadline is the same instant.
    const first = windowStatusFor(120, START, startMs + min(1))
    const afterReload = windowStatusFor(120, START, startMs + min(61))
    expect(afterReload.deadlineAt).toBe(first.deadlineAt)
    expect(afterReload.msRemaining).toBe(min(59))
  })
})
