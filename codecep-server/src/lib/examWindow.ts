// ── Timed submission window (Feature 1) ─────────────────────────────────────
//
// An instructor can give a lab a duration. The window is SESSION-RELATIVE —
// "you have 3 hours from when you start" — because that is what a lab actually
// is: students trickle in, and each one's clock starts when they sit down. The
// session row already records that (`sessions.createdAt`), so the deadline is
// DERIVED and never stored. See the schema comment for why a wall-clock
// `opensAt` model was rejected.
//
// This module is pure and takes `now` as an argument so the enforcement rule can
// be tested at any point relative to a window without waiting for real time to
// pass. The ROUTE always passes the SERVER's clock — never a client-supplied
// timestamp, which is the entire security property here.

export const MS_PER_MINUTE = 60_000

export type WindowState = 'untimed' | 'open' | 'closed'

export interface WindowStatus {
  state: WindowState
  /**
   * The server's clock at the moment this status was computed.
   *
   * Handed to the client so its countdown can correct for clock skew: a student
   * whose machine is ten minutes slow would otherwise SEE ten extra minutes and
   * be rejected at submit for a discrepancy that is not their fault. This makes
   * the DISPLAY honest; it grants no authority, because the submit route
   * re-derives everything from the server clock regardless.
   */
  serverNow: number
  /** Absolute deadline in epoch ms; null when untimed. */
  deadlineAt: number | null
  /** Milliseconds left (never negative); null when untimed. */
  msRemaining: number | null
  windowMinutes: number | null
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * Where a session stands relative to its assignment's window.
 *
 * `windowMinutes` null / absent / non-positive → `untimed`. That is the state
 * every existing assignment is in, and it must behave exactly as it did before
 * this feature: no deadline, no countdown, no rejection.
 *
 * A missing or unusable `startedAt` also reads as `untimed` rather than
 * `closed`. Refusing a submission because a timestamp could not be read would
 * punish a student for a data problem that is not theirs — and the failure mode
 * of a wrongly-closed window (work lost) is far worse than that of a wrongly-open
 * one (a late submission an instructor can still see the timestamp of).
 */
export function windowStatusFor(
  windowMinutes: number | null | undefined,
  startedAt: Date | number | null | undefined,
  now: number,
): WindowStatus {
  if (!isPositiveInt(windowMinutes)) {
    return { state: 'untimed', serverNow: now, deadlineAt: null, msRemaining: null, windowMinutes: null }
  }
  const startMs = startedAt instanceof Date ? startedAt.getTime() : startedAt
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) {
    return { state: 'untimed', serverNow: now, deadlineAt: null, msRemaining: null, windowMinutes: null }
  }

  const deadlineAt = startMs + windowMinutes * MS_PER_MINUTE
  const msRemaining = Math.max(0, deadlineAt - now)
  return {
    state: now > deadlineAt ? 'closed' : 'open',
    serverNow: now,
    deadlineAt,
    msRemaining,
    windowMinutes,
  }
}

/**
 * The one question the submit route asks. Kept as its own named function so the
 * security-critical rule reads as a single line at the call site rather than as
 * an inline comparison someone could later "simplify" the wrong way.
 */
export function isSubmitAllowed(status: WindowStatus): boolean {
  return status.state !== 'closed'
}

/** How long a closed window has been closed — for the rejection message. */
export function minutesLate(status: WindowStatus, now: number): number {
  if (status.deadlineAt === null || now <= status.deadlineAt) return 0
  return Math.floor((now - status.deadlineAt) / MS_PER_MINUTE)
}
