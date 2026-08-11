import { describe, it, expect } from 'vitest'
import {
  hasTelemetry,
  isRealSession,
  compareRealness,
  pickRealSession,
  isPhantomRow,
  isDeletablePhantom,
  dropPhantomDuplicates,
} from './sessionResolution'

// ── Gap #71: the empty phantom left by two overlapping creates ───────────────
// Shapes taken from the real duplicate pairs found in the local database: rows
// sharing (studentId, assignmentId) and createdAt to the millisecond, one with
// the student's telemetry and one with nothing on it at all.
const phantom = {
  id: 'phantom',
  status: 'IN_PROGRESS',
  windowCount: 0,
  tier1Count: 0,
  hasForensics: false,
  runCount: 0,
  updatedAt: new Date('2026-08-10T12:13:09.343Z'),
}
const realSubmitted = {
  id: 'real',
  status: 'SUBMITTED',
  windowCount: 5,
  tier1Count: 0,
  hasForensics: true,
  runCount: 0,
  updatedAt: new Date('2026-08-10T12:15:58.979Z'),
}
const realOpen = {
  id: 'real-open',
  status: 'IN_PROGRESS',
  windowCount: 1,
  tier1Count: 1,
  hasForensics: false,
  runCount: 0,
  updatedAt: new Date('2026-08-10T17:10:59.832Z'),
}

describe('hasTelemetry / isRealSession', () => {
  it('treats a row with flush windows as holding the student work', () => {
    expect(hasTelemetry(realOpen)).toBe(true)
    expect(hasTelemetry(phantom)).toBe(false)
  })

  it('counts a SUBMITTED row as real even with no windows', () => {
    // The student pressed submit and forensics was enqueued for this row. An
    // empty submitted session is a finding to look at, never a phantom.
    expect(isRealSession({ id: 's', status: 'SUBMITTED', windowCount: 0 })).toBe(true)
  })

  it('does not treat an unstarted IN_PROGRESS row as real', () => {
    expect(isRealSession(phantom)).toBe(false)
  })
})

describe('pickRealSession', () => {
  it('returns null for no rows at all', () => {
    expect(pickRealSession([])).toBeNull()
  })

  it('prefers the row with telemetry over an empty one', () => {
    expect(pickRealSession([phantom, realOpen])?.id).toBe('real-open')
  })

  it('is not fooled by the phantom being NEWER', () => {
    // The whole failure mode: the phantom is written 1-3ms after the real row,
    // so anything ordering purely by recency lands on the empty one.
    const newerPhantom = { ...phantom, updatedAt: new Date('2026-08-11T09:00:00Z') }
    expect(pickRealSession([newerPhantom, realOpen])?.id).toBe('real-open')
  })

  it('prefers the row with MORE windows when both hold telemetry', () => {
    const thin = { ...realOpen, id: 'thin', windowCount: 1 }
    const thick = { ...realOpen, id: 'thick', windowCount: 9 }
    expect(pickRealSession([thin, thick])?.id).toBe('thick')
  })

  it('falls back to forensics, then Tier-1, then runs when windows tie', () => {
    const bare = { id: 'bare', status: 'IN_PROGRESS', windowCount: 0 }
    expect(pickRealSession([bare, { ...bare, id: 'scored', hasForensics: true }])?.id).toBe('scored')
    expect(pickRealSession([bare, { ...bare, id: 'alerted', tier1Count: 2 }])?.id).toBe('alerted')
    expect(pickRealSession([bare, { ...bare, id: 'ran', runCount: 3 }])?.id).toBe('ran')
  })

  it('falls back to the most recent activity when nothing else separates rows', () => {
    const older = { id: 'older', status: 'IN_PROGRESS', windowCount: 2, updatedAt: '2026-08-01T10:00:00Z' }
    const newer = { id: 'newer', status: 'IN_PROGRESS', windowCount: 2, updatedAt: '2026-08-02T10:00:00Z' }
    expect(pickRealSession([older, newer])?.id).toBe('newer')
  })

  it('keeps the caller order when rows carry no evidence fields at all', () => {
    // Backward compatibility: a caller that selects only id + status gets
    // exactly the "first row wins" behavior this replaced.
    const rows = [{ id: 'first', status: 'IN_PROGRESS' }, { id: 'second', status: 'IN_PROGRESS' }]
    expect(pickRealSession(rows)?.id).toBe('first')
  })
})

describe('isPhantomRow', () => {
  it('recognises a row that has never held anything', () => {
    expect(isPhantomRow(phantom)).toBe(true)
  })

  it('refuses every row carrying any evidence at all', () => {
    expect(isPhantomRow({ ...phantom, windowCount: 1 })).toBe(false)
    expect(isPhantomRow({ ...phantom, tier1Count: 1 })).toBe(false)
    expect(isPhantomRow({ ...phantom, hasForensics: true })).toBe(false)
    expect(isPhantomRow({ ...phantom, runCount: 1 })).toBe(false)
    expect(isPhantomRow({ ...phantom, status: 'SUBMITTED' })).toBe(false)
  })

  it('refuses a row whose emptiness is UNKNOWN rather than proven', () => {
    // An absent field means the caller did not select it. This predicate hides
    // rows from instructors and deletes them in the cleanup, so "cannot prove
    // it is empty" must read as "not a phantom".
    expect(isPhantomRow({ id: 'x', status: 'IN_PROGRESS' })).toBe(false)
    expect(isPhantomRow({ ...phantom, windowCount: undefined })).toBe(false)
    expect(isPhantomRow({ ...phantom, tier1Count: null })).toBe(false)
    expect(isPhantomRow({ ...phantom, hasForensics: undefined })).toBe(false)
    expect(isPhantomRow({ ...phantom, runCount: null })).toBe(false)
  })
})

describe('isDeletablePhantom', () => {
  it('is true only when a REAL sibling proves the row is a duplicate', () => {
    expect(isDeletablePhantom(phantom, [phantom, realSubmitted])).toBe(true)
    expect(isDeletablePhantom(phantom, [phantom, realOpen])).toBe(true)
  })

  it('never deletes a lone fresh session that simply has not been typed in yet', () => {
    // The student who opened the exam thirty seconds ago looks identical to a
    // phantom. The sibling is the entire difference.
    expect(isDeletablePhantom(phantom, [phantom])).toBe(false)
  })

  it('never deletes either row when BOTH are empty', () => {
    // Observed in the local database: a pair where neither row ever recorded a
    // flush. Nothing proves which one the student would have used.
    const other = { ...phantom, id: 'phantom-2' }
    expect(isDeletablePhantom(phantom, [phantom, other])).toBe(false)
    expect(isDeletablePhantom(other, [phantom, other])).toBe(false)
  })

  it('never deletes the real row, whatever its siblings look like', () => {
    expect(isDeletablePhantom(realSubmitted, [realSubmitted, phantom])).toBe(false)
    expect(isDeletablePhantom(realOpen, [realOpen, realSubmitted])).toBe(false)
  })

  it('ignores a sibling that is the row itself (matched by id)', () => {
    const submittedButEmpty = { ...phantom, id: 'solo', status: 'SUBMITTED' }
    expect(isDeletablePhantom(submittedButEmpty, [submittedButEmpty])).toBe(false)
  })
})

describe('dropPhantomDuplicates', () => {
  const key = (r: { pair?: string }) => r.pair ?? ''

  it('hides the phantom and keeps the real session', () => {
    const rows = [
      { ...phantom, pair: 'a1::bob' },
      { ...realSubmitted, pair: 'a1::bob' },
    ]
    expect(dropPhantomDuplicates(rows, key).map((r) => r.id)).toEqual(['real'])
  })

  it('keeps a lone empty session — a student who has just opened the exam', () => {
    const rows = [{ ...phantom, pair: 'a1::bob' }]
    expect(dropPhantomDuplicates(rows, key).map((r) => r.id)).toEqual(['phantom'])
  })

  it('keeps BOTH rows of a historical duplicate where each holds real work', () => {
    // The gap #12 damage: two genuine forensic records for one pair. Collapsing
    // them would hide a real exam from the instructor.
    const rows = [
      { ...realOpen, pair: 'a1::bob' },
      { ...realSubmitted, pair: 'a1::bob' },
    ]
    expect(dropPhantomDuplicates(rows, key)).toHaveLength(2)
  })

  it('groups by the (student, assignment) pair, not across students', () => {
    // Alice's real session must not license deleting Bob's fresh empty one.
    const rows = [
      { ...phantom, id: 'bob-fresh', pair: 'a1::bob' },
      { ...realSubmitted, id: 'alice-real', pair: 'a1::alice' },
    ]
    expect(dropPhantomDuplicates(rows, key).map((r) => r.id)).toEqual(['bob-fresh', 'alice-real'])
  })

  it('preserves the input order of everything it keeps', () => {
    const rows = [
      { ...realSubmitted, id: 'r1', pair: 'a1::bob' },
      { ...phantom, id: 'p1', pair: 'a1::bob' },
      { ...realOpen, id: 'r2', pair: 'a2::bob' },
    ]
    expect(dropPhantomDuplicates(rows, key).map((r) => r.id)).toEqual(['r1', 'r2'])
  })
})

describe('compareRealness', () => {
  it('sorts real rows ahead of phantoms', () => {
    const sorted = [phantom, realSubmitted, realOpen].sort(compareRealness)
    expect(sorted[sorted.length - 1].id).toBe('phantom')
  })
})
