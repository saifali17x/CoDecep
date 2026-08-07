import { describe, it, expect } from 'vitest'
import {
  windowStatusFor,
  isSubmitAllowed,
  minutesLate,
  minutesUntilOpen,
  closesAtFrom,
  windowMinutesBetween,
  MS_PER_MINUTE,
} from './examWindow'

const OPENS = new Date('2026-08-08T09:00:00Z')
const CLOSES = new Date('2026-08-08T12:00:00Z')
const opensMs = OPENS.getTime()
const closesMs = CLOSES.getTime()
const min = (n: number) => n * MS_PER_MINUTE

describe('windowStatusFor — the scheduled wall-clock window', () => {
  it('is UNTIMED when the assignment has no schedule (every existing assignment)', () => {
    const s = windowStatusFor(null, null, closesMs + min(999))
    expect(s.state).toBe('untimed')
    expect(s.deadlineAt).toBeNull()
    expect(s.opensAt).toBeNull()
    expect(s.closesAt).toBeNull()
    expect(isSubmitAllowed(s)).toBe(true)
  })

  it('is untimed for undefined bounds', () => {
    expect(windowStatusFor(undefined, undefined, opensMs).state).toBe('untimed')
  })

  it('is PENDING before the scheduled open', () => {
    const s = windowStatusFor(OPENS, CLOSES, opensMs - min(5))
    expect(s.state).toBe('pending')
    expect(s.msUntilOpen).toBe(min(5))
    expect(isSubmitAllowed(s)).toBe(false)
    expect(minutesUntilOpen(s, opensMs - min(5))).toBe(5)
  })

  it('is OPEN at the opening instant and right up to the close', () => {
    expect(windowStatusFor(OPENS, CLOSES, opensMs).state).toBe('open')
    expect(windowStatusFor(OPENS, CLOSES, closesMs).state).toBe('open')
    expect(windowStatusFor(OPENS, CLOSES, closesMs - 1).state).toBe('open')
  })

  it('is CLOSED one millisecond past the close', () => {
    const s = windowStatusFor(OPENS, CLOSES, closesMs + 1)
    expect(s.state).toBe('closed')
    expect(isSubmitAllowed(s)).toBe(false)
  })

  it('reports the deadline as the SHARED wall-clock close, not a per-student instant', () => {
    const s = windowStatusFor(OPENS, CLOSES, opensMs + min(30))
    expect(s.deadlineAt).toBe(closesMs)
    expect(s.closesAt).toBe(closesMs)
    expect(s.msRemaining).toBe(min(150))
    expect(s.windowMinutes).toBe(180)
  })

  it('gives two students who started at DIFFERENT times the SAME deadline', () => {
    // The whole point of the wall-clock model. Neither student's start time is
    // an input at all — the schedule is the only thing consulted.
    const early = windowStatusFor(OPENS, CLOSES, opensMs + min(1))
    const late = windowStatusFor(OPENS, CLOSES, opensMs + min(90))
    expect(early.deadlineAt).toBe(late.deadlineAt)
    expect(late.msRemaining).toBe(min(90))
  })

  it('a resumed session gets the same deadline — reloading buys no time', () => {
    const first = windowStatusFor(OPENS, CLOSES, opensMs + min(10))
    const afterReload = windowStatusFor(OPENS, CLOSES, opensMs + min(70))
    expect(afterReload.deadlineAt).toBe(first.deadlineAt)
    expect(afterReload.msRemaining).toBe(min(110))
  })

  it('never reports negative time remaining or negative time until open', () => {
    expect(windowStatusFor(OPENS, CLOSES, closesMs + min(600)).msRemaining).toBe(0)
    expect(windowStatusFor(OPENS, CLOSES, closesMs).msUntilOpen).toBeNull()
  })

  it('accepts epoch-ms and ISO strings as well as Dates', () => {
    expect(windowStatusFor(opensMs, closesMs, closesMs + 1).state).toBe('closed')
    expect(windowStatusFor(OPENS.toISOString(), CLOSES.toISOString(), opensMs).state).toBe('open')
  })

  it('allows a close time with NO open time — "submit any time before noon"', () => {
    const s = windowStatusFor(null, CLOSES, closesMs - min(1))
    expect(s.state).toBe('open')
    expect(s.opensAt).toBeNull()
    expect(s.deadlineAt).toBe(closesMs)
    expect(windowStatusFor(null, CLOSES, closesMs + min(1)).state).toBe('closed')
  })

  it('allows an open time with NO close time — "not before nine, then as long as you like"', () => {
    expect(windowStatusFor(OPENS, null, opensMs - 1).state).toBe('pending')
    const s = windowStatusFor(OPENS, null, opensMs + min(10_000))
    expect(s.state).toBe('open')
    expect(s.msRemaining).toBeNull()
    expect(isSubmitAllowed(s)).toBe(true)
  })

  it('treats an unreadable timestamp as UNTIMED, never as closed', () => {
    // Refusing a submission because a stored date could not be parsed would
    // punish a student for a data problem that is not theirs; a wrongly-closed
    // window loses work, a wrongly-open one only produces a late timestamp.
    expect(windowStatusFor('not-a-date', 'also-not-a-date', opensMs).state).toBe('untimed')
    expect(windowStatusFor(Number.NaN, Number.NaN, opensMs).state).toBe('untimed')
    expect(isSubmitAllowed(windowStatusFor('nonsense', undefined, opensMs))).toBe(true)
  })

  it('ignores a close that precedes its open rather than refusing everything', () => {
    const s = windowStatusFor(CLOSES, OPENS, closesMs + min(5))
    expect(s.closesAt).toBeNull()
    expect(s.state).toBe('open')
    expect(isSubmitAllowed(s)).toBe(true)
  })

  it('reports how late a closed submission is', () => {
    const now = closesMs + min(15)
    expect(minutesLate(windowStatusFor(OPENS, CLOSES, now), now)).toBe(15)
  })

  it('reports zero lateness while the window is still open', () => {
    const now = opensMs + min(10)
    expect(minutesLate(windowStatusFor(OPENS, CLOSES, now), now)).toBe(0)
  })
})

describe('closesAtFrom / windowMinutesBetween — the instructor-UI convenience', () => {
  it('computes the stored close time from an open time plus a duration', () => {
    expect(closesAtFrom(OPENS, 180)?.getTime()).toBe(closesMs)
  })

  it('returns null for an unusable open time or duration', () => {
    expect(closesAtFrom(null, 180)).toBeNull()
    expect(closesAtFrom(OPENS, 0)).toBeNull()
    expect(closesAtFrom(OPENS, -5)).toBeNull()
    expect(closesAtFrom(OPENS, Number.NaN)).toBeNull()
  })

  it('derives the display duration back out of a stored schedule', () => {
    expect(windowMinutesBetween(OPENS, CLOSES)).toBe(180)
    expect(windowMinutesBetween(OPENS, null)).toBeNull()
    expect(windowMinutesBetween(CLOSES, OPENS)).toBeNull()
  })
})
