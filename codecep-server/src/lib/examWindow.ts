// ── Scheduled submission window (Feature 1, wall-clock) ─────────────────────
//
// An instructor SCHEDULES an exam: "opens 09:00, closes 12:00". The window is
// WALL-CLOCK and identical for every student, regardless of when each one
// opened the exam. A student who starts twenty minutes late gets twenty minutes
// less, exactly as they would in a room with a clock on the wall.
//
// This REPLACES the earlier session-relative model (deadline =
// `session.createdAt + windowMinutes`), which gave every student their own
// private deadline — wrong for a scheduled exam, because two students sitting
// the same paper had different close times and a late arrival could work past
// the end of the sitting.
//
// `windowMinutes` survives only as a CONVENIENCE for the instructor UI (enter
// an open time plus a duration, get a close time). It is derived from the
// schedule, never enforced: `opensAt`/`closesAt` are the only values the submit
// route consults.
//
// This module is pure and takes `now` as an argument so the enforcement rule can
// be tested at any point relative to a window without waiting for real time to
// pass. The ROUTE always passes the SERVER's clock — never a client-supplied
// timestamp, which is the entire security property here.

export const MS_PER_MINUTE = 60_000

/**
 * `untimed` — no schedule at all (every pre-feature assignment).
 * `pending` — scheduled, but the opening time has not arrived.
 * `open`    — inside the window.
 * `closed`  — past the closing time.
 */
export type WindowState = 'untimed' | 'pending' | 'open' | 'closed'

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
  /** Scheduled opening instant in epoch ms; null when unscheduled. */
  opensAt: number | null
  /** Scheduled closing instant in epoch ms; null when there is no close time. */
  closesAt: number | null
  /**
   * The instant the countdown targets — the same as `closesAt`. Kept as its own
   * key because every existing client reader (session create payload, the exam
   * timer) already speaks `deadlineAt`, and it is now a SHARED wall-clock
   * instant rather than a per-student one.
   */
  deadlineAt: number | null
  /** Milliseconds until the close (never negative); null when there is none. */
  msRemaining: number | null
  /** Milliseconds until the open (never negative); null when already open. */
  msUntilOpen: number | null
  /**
   * The scheduled duration in whole minutes, DERIVED from the schedule for
   * display. Never an enforcement input.
   */
  windowMinutes: number | null
}

/** Accepts a Date, an epoch-ms number, or an ISO string; anything unusable → null. */
function toMs(v: Date | number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    const ms = v.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * Where an assignment's SHARED schedule stands right now.
 *
 * Both bounds null / absent / unreadable → `untimed`. That is the state every
 * assignment created before this feature is in, and it must behave exactly as it
 * did: no deadline, no countdown, no rejection.
 *
 * An UNREADABLE timestamp reads as untimed rather than closed, deliberately.
 * Refusing a submission because a stored date could not be parsed would punish a
 * student for a data problem that is not theirs — and the failure mode of a
 * wrongly-closed window (work lost) is far worse than that of a wrongly-open one
 * (a late submission whose timestamp an instructor can still see).
 *
 * Either bound may stand alone: a close time with no open time is "submit any
 * time before noon"; an open time with no close time is "not before nine, then
 * as long as you like".
 */
export function windowStatusFor(
  opensAtIn: Date | number | string | null | undefined,
  closesAtIn: Date | number | string | null | undefined,
  now: number,
): WindowStatus {
  const opensAt = toMs(opensAtIn)
  let closesAt = toMs(closesAtIn)

  // A schedule that closes before it opens is nonsense the API refuses to
  // store; if one ever reaches here (hand-edited row, older data) the close is
  // ignored rather than used to refuse every submission for that assignment.
  if (opensAt !== null && closesAt !== null && closesAt <= opensAt) closesAt = null

  if (opensAt === null && closesAt === null) {
    return {
      state: 'untimed',
      serverNow: now,
      opensAt: null,
      closesAt: null,
      deadlineAt: null,
      msRemaining: null,
      msUntilOpen: null,
      windowMinutes: null,
    }
  }

  const windowMinutes =
    opensAt !== null && closesAt !== null ? Math.round((closesAt - opensAt) / MS_PER_MINUTE) : null

  const notYetOpen = opensAt !== null && now < opensAt
  const past = closesAt !== null && now > closesAt

  return {
    // `past` is checked first so a nonsensical overlap can never read as open.
    state: past ? 'closed' : notYetOpen ? 'pending' : 'open',
    serverNow: now,
    opensAt,
    closesAt,
    deadlineAt: closesAt,
    msRemaining: closesAt === null ? null : Math.max(0, closesAt - now),
    msUntilOpen: opensAt === null || now >= opensAt ? null : opensAt - now,
    windowMinutes,
  }
}

/**
 * The one question the submit route asks. Kept as its own named function so the
 * security-critical rule reads as a single line at the call site rather than as
 * an inline comparison someone could later "simplify" the wrong way.
 *
 * A submission is accepted only INSIDE the window: `opensAt <= now <= closesAt`.
 */
export function isSubmitAllowed(status: WindowStatus): boolean {
  return status.state === 'untimed' || status.state === 'open'
}

/** How long a closed window has been closed — for the rejection message. */
export function minutesLate(status: WindowStatus, now: number): number {
  if (status.closesAt === null || now <= status.closesAt) return 0
  return Math.floor((now - status.closesAt) / MS_PER_MINUTE)
}

/** How long until a pending window opens — for the "not open yet" message. */
export function minutesUntilOpen(status: WindowStatus, now: number): number {
  if (status.opensAt === null || now >= status.opensAt) return 0
  return Math.ceil((status.opensAt - now) / MS_PER_MINUTE)
}

/**
 * The instructor-UI convenience: an open time plus a duration gives the close
 * time that is actually stored and enforced. Returns null when either input is
 * unusable, so a malformed duration produces an unscheduled close rather than a
 * deadline in 1970.
 */
export function closesAtFrom(
  opensAtIn: Date | number | string | null | undefined,
  windowMinutes: number | null | undefined,
): Date | null {
  const opensAt = toMs(opensAtIn)
  if (opensAt === null) return null
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null
  }
  return new Date(opensAt + Math.round(windowMinutes) * MS_PER_MINUTE)
}

/** The stored duration for display, derived from the schedule. Null unless both bounds exist. */
export function windowMinutesBetween(
  opensAtIn: Date | number | string | null | undefined,
  closesAtIn: Date | number | string | null | undefined,
): number | null {
  const opensAt = toMs(opensAtIn)
  const closesAt = toMs(closesAtIn)
  if (opensAt === null || closesAt === null || closesAt <= opensAt) return null
  return Math.round((closesAt - opensAt) / MS_PER_MINUTE)
}
