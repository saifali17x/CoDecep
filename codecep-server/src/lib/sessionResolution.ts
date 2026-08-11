// ── Session resolution: which row is the REAL session (gap #71) ─────────────
//
// A session is identified by (student, ASSIGNMENT) and that invariant lives in
// application logic, never in a unique constraint — live rows already violate it
// and they are forensic records (gap #39). Two things follow, and this module is
// both of them:
//
// 1. Concurrent creates can leave a DUPLICATE pair. React StrictMode's dev
//    double-mount fires `POST /api/session/create` twice ~1-3ms apart: both
//    requests SELECT "no row exists", both INSERT. The result is one EMPTY
//    phantom (0 flush windows, nothing recorded on it ever) beside the row the
//    student actually worked in. `POST /api/session/create` now serializes the
//    check-and-create per identity so this cannot happen again, but the rows
//    already written are still there, and so is every other way two creates can
//    overlap (a double-clicked link, a retried request).
//
// 2. So EVERY reader has to resolve a list, not assume a row. The rule is the
//    same everywhere: a row that carries evidence beats a row that carries none.
//
// Two deliberately different tools, because they answer different questions with
// different amounts of information:
//
// - `pickRealSession` ORDERS rows. Safe with partial information (an unknown
//    field simply does not rank), so the exam-open path can use it on whatever
//    it happened to select.
// - `isPhantomRow` / `isDeletablePhantom` are a PREDICATE, and they are
//    deliberately hard to satisfy: every clause must be provably true, and an
//    unknown field means "cannot prove it is empty" — i.e. NOT a phantom. This
//    is the predicate that hides a row from an instructor and (in the one-time
//    cleanup) deletes it, so it errs entirely in one direction.
//
// Nothing here deletes anything in a request path. Display resolution SELECTS;
// deletion is a separate, reviewable, one-time cleanup.

export interface ResolvableSessionRow {
  id: string
  status: string
  /** `jsonb_array_length(playback_log)` — how many flush windows exist. */
  windowCount?: number
  /** `jsonb_array_length(tier1_log)` — NULL/absent means "not recorded". */
  tier1Count?: number | null
  /** Whether the forensics worker ever wrote a result for this row. */
  hasForensics?: boolean
  runCount?: number | null
  updatedAt?: Date | string | number | null
}

function timeOf(value: ResolvableSessionRow['updatedAt']): number {
  if (value == null) return 0
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * Does this row carry the student's work? The one fact every other rule is
 * built on: a session with flush windows holds telemetry, and telemetry is the
 * only thing a session exists to hold.
 */
export function hasTelemetry(row: ResolvableSessionRow): boolean {
  return (row.windowCount ?? 0) > 0
}

/**
 * A row that is a genuine record of an attempt, whatever else is true of it.
 *
 * SUBMITTED counts even with no windows: the student pressed submit, forensics
 * was enqueued for it, and it is the row the locked view and the replay point
 * at. An empty submitted session is a finding, not a phantom.
 */
export function isRealSession(row: ResolvableSessionRow): boolean {
  return row.status === 'SUBMITTED' || hasTelemetry(row)
}

/**
 * Rank by how much of a real session a row is. More negative sorts first.
 *
 * Telemetry dominates, then how much of it, then whether anything else was ever
 * recorded against the row, and only then recency — a phantom created one
 * millisecond later must never win on being "newer".
 */
export function compareRealness(a: ResolvableSessionRow, b: ResolvableSessionRow): number {
  const telemetry = Number(hasTelemetry(b)) - Number(hasTelemetry(a))
  if (telemetry !== 0) return telemetry
  const windows = (b.windowCount ?? 0) - (a.windowCount ?? 0)
  if (windows !== 0) return windows
  const forensics = Number(b.hasForensics ?? false) - Number(a.hasForensics ?? false)
  if (forensics !== 0) return forensics
  const tier1 = (b.tier1Count ?? 0) - (a.tier1Count ?? 0)
  if (tier1 !== 0) return tier1
  const runs = (b.runCount ?? 0) - (a.runCount ?? 0)
  if (runs !== 0) return runs
  return timeOf(b.updatedAt) - timeOf(a.updatedAt)
}

/**
 * The one row that best represents a (student, assignment) among rows that are
 * already known to share a status. Ties keep the caller's order (the callers
 * order by `updatedAt desc`), so this can only ever move a MORE real row ahead
 * of a less real one — it never reshuffles equals.
 */
export function pickRealSession<T extends ResolvableSessionRow>(rows: T[]): T | null {
  if (rows.length === 0) return null
  let best = rows[0]
  for (let i = 1; i < rows.length; i++) {
    if (compareRealness(rows[i], best) < 0) best = rows[i]
  }
  return best
}

/**
 * A row that has never held anything: no flush window, no Tier-1 alert, no
 * forensics result, no run — and not submitted.
 *
 * Every clause must be PROVABLY true. An absent field means the caller did not
 * select it, which is not evidence of emptiness, so it reads as "not a phantom".
 * A row this returns true for is a row an instructor is never shown and the
 * cleanup may delete, so the only acceptable error is a phantom surviving.
 *
 * Note this alone is NOT enough to delete or hide anything: a genuinely
 * just-created session is empty too. It must also have a real sibling —
 * see `isDeletablePhantom`.
 */
export function isPhantomRow(row: ResolvableSessionRow): boolean {
  if (row.status === 'SUBMITTED') return false
  if (row.windowCount !== 0) return false
  if ((row.tier1Count ?? 1) !== 0) return false
  if (row.hasForensics !== false) return false
  if ((row.runCount ?? 1) !== 0) return false
  return true
}

/**
 * A phantom that is PROVEN to be a duplicate, because the same (student,
 * assignment) also has a row that is a real session.
 *
 * `siblings` is every other row for that pair. A lone empty session — the
 * student who opened the exam thirty seconds ago and has not typed yet — has no
 * real sibling and is therefore never deletable and never hidden.
 */
export function isDeletablePhantom<T extends ResolvableSessionRow>(row: T, siblings: T[]): boolean {
  if (!isPhantomRow(row)) return false
  return siblings.some((s) => s.id !== row.id && isRealSession(s))
}

/**
 * Drop proven phantom duplicates from a list an instructor is about to read,
 * grouping by whatever identifies a student's attempt at one assignment.
 *
 * This HIDES, it never deletes, and it hides exactly what the cleanup would
 * delete — one predicate, so an instructor is never shown a row that a later
 * cleanup silently removes, nor denied one it would have kept. Anything
 * carrying evidence survives, including the historical gap #12 duplicates where
 * BOTH rows hold real work: those are two real records and the instructor needs
 * to see both.
 */
export function dropPhantomDuplicates<T extends ResolvableSessionRow>(
  rows: T[],
  keyOf: (row: T) => string
): T[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return rows.filter((row) => !isDeletablePhantom(row, groups.get(keyOf(row)) ?? []))
}
