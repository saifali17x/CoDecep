// Live DVR relay (Session 28) — the socket half of the "ghost typer".
//
// WHY THIS EXISTS. The DVR reconstructs a session from the 30s flush, so the
// most recent window is up to 30 seconds stale and the first minute of an exam
// shows nothing at all. That is not a bug to patch at the edges: any view built
// on flushed data alone has a stale tail by construction. So the live edge is
// fed by a SEPARATE channel that never waits for a flush, and the DVR stitches
// the two together (see codecep-client/src/lib/liveStitch.js).
//
// WHAT IT IS NOT. This does not replace, alter or duplicate the flush pipeline.
// The database is still the durable record and the only thing forensics ever
// reads; the live stream is additive and best-effort. Nothing received here is
// persisted — the same events arrive through the normal flush minutes later,
// and storing them twice would put a socket in the ingest path, which
// Constraint 2 exists to prevent.
//
// AMENDMENT TO CONSTRAINT 3. The socket previously carried three alert types
// and nothing else. It now also carries keystroke events, under three limits
// that keep the spirit of that rule: they flow ONLY while an authenticated
// owning instructor is actively watching that one session, they are relayed to
// that session's watch room and nowhere else, and they are never written to the
// database.
//
// Handlers are registered through this module (rather than inline in server.ts)
// so the whole protocol can be driven by mock sockets in tests.

import type { WatchRegistry } from './watchRegistry'

export const sessionRoom = (sessionId: string) => `session:${sessionId}`
export const watchRoom = (sessionId: string) => `watch:${sessionId}`

/** The slice of socket.io's Server this relay uses. */
export interface LiveIo {
  to(room: string): { emit(event: string, payload?: unknown): void }
}

/** The slice of socket.io's Socket this relay uses. */
export interface LiveSocket {
  id: string
  rooms: Set<string>
  join(room: string): void
  leave(room: string): void
  emit(event: string, payload?: unknown): void
  on(event: string, handler: (...args: any[]) => void): void
}

export interface LiveDeps {
  registry: WatchRegistry
  /** Throws on an invalid/expired token — same verifier the HTTP guards use. */
  verifyToken(token: string): { userId: string; role: string }
  /**
   * The SAME ownership rule as GET /api/session/:id/replay: an instructor may
   * watch a session whose assignment→class they own, and a legacy session with
   * no assignment is dev data where the instructor role suffices.
   */
  canWatch(sessionId: string, userId: string): Promise<boolean>
  log?: (...args: unknown[]) => void
}

type Ack = ((result: { ok: boolean; error?: string; watchers?: number }) => void) | undefined

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * A live keystroke is bigger than an alert but still bounded — a student can
 * paste a lot at once, and that paste is precisely the moment an instructor
 * needs to see arrive. Past this size the live copy is dropped and the flush
 * carries it instead, so an absurd payload can never wedge the relay.
 */
const MAX_LIVE_EVENT_BYTES = 512_000

export function registerLiveHandlers(io: LiveIo, socket: LiveSocket, deps: LiveDeps): void {
  const { registry, verifyToken, canWatch } = deps
  const log = deps.log ?? (() => {})

  // ── Student: join my own session's room ─────────────────────────────────
  // Joining is not the same as streaming. A student sits in this room for the
  // whole exam and emits nothing until told to; the room is only how the server
  // reaches them when an instructor starts watching.
  socket.on('session:join', (payload: { sessionId?: unknown }) => {
    const sessionId = payload?.sessionId
    if (!isNonEmptyString(sessionId)) return
    socket.join(sessionRoom(sessionId))
    log(`[LIVE] student joined ${sessionRoom(sessionId)}`)
    // Already being watched — a page refresh mid-watch must resume streaming
    // rather than leave the instructor staring at a frozen edge until the
    // watcher happens to toggle off and on again.
    if (registry.isWatched(sessionId)) {
      socket.emit('live:start', { sessionId })
    }
  })

  // ── Student: a flush just landed ────────────────────────────────────────
  // Purely a nudge for the watching instructors to re-read the durable record
  // and reconcile it against their live tail. Carries no telemetry itself.
  socket.on('live:flushed', (payload: { sessionId?: unknown }) => {
    const sessionId = payload?.sessionId
    if (!isNonEmptyString(sessionId)) return
    if (!registry.isWatched(sessionId)) return
    io.to(watchRoom(sessionId)).emit('live:flushed', { sessionId })
  })

  // ── Student: the watch-start sync flush completed ───────────────────────
  // THE SEAM. When watching begins, whatever the student has typed since the
  // last flush is still sitting in their browser buffer — a hole between the
  // end of the recorded data and the start of the live stream. The student
  // drains that buffer immediately on `live:start` and reports the moment it
  // was taken; the DVR refetches the record and then applies live events from
  // that moment on. Without this the live tail's edits would be applied to text
  // that is missing the intervening keystrokes, which is exactly how a live
  // view degenerates into garbled code.
  socket.on('live:synced', (payload: { sessionId?: unknown; at?: unknown }) => {
    const sessionId = payload?.sessionId
    if (!isNonEmptyString(sessionId)) return
    if (!registry.isWatched(sessionId)) return
    const at = typeof payload?.at === 'number' ? payload.at : Date.now()
    io.to(watchRoom(sessionId)).emit('live:synced', { sessionId, at })
  })

  // ── Student: one keystroke, live ────────────────────────────────────────
  socket.on('live:keystroke', (payload: { sessionId?: unknown; event?: unknown }) => {
    const sessionId = payload?.sessionId
    if (!isNonEmptyString(sessionId)) return
    // Nobody is watching — the student should already have stopped, but a
    // stop signal can lose a race with events already in flight.
    if (!registry.isWatched(sessionId)) return
    // Only a socket that joined this session's room may stream for it. This is
    // the same trust level as the existing alert relay (detection has always
    // been client-side, gap #3): it stops a stray client, not a determined
    // forger. It is acceptable here for a reason that does NOT apply to the
    // flush — nothing on this path is persisted or scored, so a forged live
    // event can mislead a live view but can never touch the durable record,
    // the metrics, or a grade.
    if (!socket.rooms.has(sessionRoom(sessionId))) return
    const event = payload?.event
    if (!event || typeof event !== 'object') return
    if (JSON.stringify(event).length > MAX_LIVE_EVENT_BYTES) return
    io.to(watchRoom(sessionId)).emit('live:keystroke', { sessionId, event })
  })

  // ── Instructor: start watching ──────────────────────────────────────────
  socket.on('watch:start', async (payload: { sessionId?: unknown; token?: unknown }, ack: Ack) => {
    const sessionId = payload?.sessionId
    const token = payload?.token
    if (!isNonEmptyString(sessionId)) {
      ack?.({ ok: false, error: 'sessionId is required' })
      return
    }
    if (!isNonEmptyString(token)) {
      ack?.({ ok: false, error: 'Authentication required' })
      return
    }

    let user: { userId: string; role: string }
    try {
      user = verifyToken(token)
    } catch {
      ack?.({ ok: false, error: 'Invalid or expired token' })
      return
    }
    // A student can never watch anyone, including themselves.
    if (user.role !== 'INSTRUCTOR') {
      ack?.({ ok: false, error: 'Instructor access required' })
      return
    }

    let allowed = false
    try {
      allowed = await canWatch(sessionId, user.userId)
    } catch (err) {
      // A database blip must not read as "not allowed" — that would hand out a
      // permission error for what is actually an outage.
      ack?.({ ok: false, error: 'Could not verify access, please retry' })
      log('[LIVE] ownership check failed:', (err as Error).message)
      return
    }
    if (!allowed) {
      ack?.({ ok: false, error: 'You do not own this class.' })
      return
    }

    socket.join(watchRoom(sessionId))
    const { firstWatcher, watcherCount } = registry.add(sessionId, socket.id)
    if (firstWatcher) {
      io.to(sessionRoom(sessionId)).emit('live:start', { sessionId })
      log(`[LIVE] watch started on ${sessionId} — student asked to stream`)
    }
    ack?.({ ok: true, watchers: watcherCount })
  })

  // ── Instructor: stop watching ───────────────────────────────────────────
  socket.on('watch:stop', (payload: { sessionId?: unknown }, ack: Ack) => {
    const sessionId = payload?.sessionId
    if (!isNonEmptyString(sessionId)) {
      ack?.({ ok: false, error: 'sessionId is required' })
      return
    }
    socket.leave(watchRoom(sessionId))
    const { lastWatcher, watcherCount } = registry.remove(sessionId, socket.id)
    if (lastWatcher) {
      io.to(sessionRoom(sessionId)).emit('live:stop', { sessionId })
      log(`[LIVE] watch stopped on ${sessionId} — student asked to stop streaming`)
    }
    ack?.({ ok: true, watchers: watcherCount })
  })

  socket.on('disconnect', () => {
    for (const sessionId of registry.removeSocket(socket.id)) {
      io.to(sessionRoom(sessionId)).emit('live:stop', { sessionId })
      log(`[LIVE] watcher disconnected — ${sessionId} stops streaming`)
    }
  })
}

/**
 * Tell everyone watching this session that it has ended, so a DVR in live mode
 * settles onto the final recorded session instead of waiting for keystrokes
 * that will never come. Called from the submit route; also tells the student to
 * stop, which is belt-and-braces — the client's own Immune Phase has already
 * disarmed streaming by the time this fires.
 */
export function announceSessionEnd(io: LiveIo, registry: WatchRegistry, sessionId: string): void {
  io.to(sessionRoom(sessionId)).emit('live:stop', { sessionId })
  if (registry.isWatched(sessionId)) {
    io.to(watchRoom(sessionId)).emit('live:end', { sessionId })
  }
}

/**
 * Tell watchers a flush landed so they can reconcile their live tail against
 * the durable record. Fire-and-forget and only when someone is watching, so the
 * ingest path stays the O(1) append Constraint 2 requires.
 */
export function announceFlush(io: LiveIo, registry: WatchRegistry, sessionId: string): void {
  if (!registry.isWatched(sessionId)) return
  io.to(watchRoom(sessionId)).emit('live:flushed', { sessionId })
}
