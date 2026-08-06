import { describe, it, expect, beforeEach } from 'vitest'
import { WatchRegistry } from './watchRegistry'
import {
  registerLiveHandlers,
  announceSessionEnd,
  announceFlush,
  sessionRoom,
  watchRoom,
  type LiveIo,
  type LiveSocket,
} from './liveRelay'

// Live DVR relay (Session 28). Integration-style, driven by MOCK sockets: the
// protocol is what matters — who is told to start streaming, who receives a
// relayed keystroke, and who is refused — and none of that needs a real
// engine.io transport to be exercised honestly.

/** Everything emitted anywhere, so a test can assert what a room did NOT get. */
interface Emission {
  room: string
  event: string
  payload: unknown
}

function makeIo() {
  const emissions: Emission[] = []
  const io: LiveIo = {
    to: (room: string) => ({
      emit: (event: string, payload?: unknown) => emissions.push({ room, event, payload }),
    }),
  }
  return {
    io,
    emissions,
    /** Payloads sent to one room, optionally filtered by event name. */
    sentTo(room: string, event?: string) {
      return emissions.filter((e) => e.room === room && (!event || e.event === event))
    },
  }
}

let socketSeq = 0

function makeSocket() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const direct: { event: string; payload: unknown }[] = []
  const rooms = new Set<string>()
  const socket: LiveSocket = {
    id: `sock-${++socketSeq}`,
    rooms,
    join: (room) => void rooms.add(room),
    leave: (room) => void rooms.delete(room),
    emit: (event, payload) => void direct.push({ event, payload }),
    on: (event, handler) => void handlers.set(event, handler),
  }
  return {
    socket,
    rooms,
    direct,
    /** Drive an incoming client event, awaiting async handlers. */
    fire: (event: string, ...args: any[]) => handlers.get(event)?.(...args),
  }
}

const INSTRUCTOR = { userId: 'inst-1', role: 'INSTRUCTOR' }
const OTHER_INSTRUCTOR = { userId: 'inst-2', role: 'INSTRUCTOR' }
const STUDENT = { userId: 'stu-1', role: 'STUDENT' }

/** Tokens are just their subject here; the real verifier is tested elsewhere. */
const TOKENS: Record<string, { userId: string; role: string }> = {
  'tok-inst-1': INSTRUCTOR,
  'tok-inst-2': OTHER_INSTRUCTOR,
  'tok-student': STUDENT,
}

function verifyToken(token: string) {
  const user = TOKENS[token]
  if (!user) throw new Error('invalid token')
  return user
}

const SESSION = 'sess-abc'

/** Only inst-1 owns SESSION's class. */
const canWatch = async (sessionId: string, userId: string) =>
  sessionId === SESSION && userId === INSTRUCTOR.userId

let registry: WatchRegistry

beforeEach(() => {
  registry = new WatchRegistry()
})

function wire(io: LiveIo, socket: LiveSocket, overrides: Partial<Parameters<typeof registerLiveHandlers>[2]> = {}) {
  registerLiveHandlers(io, socket, { registry, verifyToken, canWatch, ...overrides })
}

// ── The watch handshake ────────────────────────────────────────────────────

describe('watch:start / watch:stop', () => {
  it('tells the student to begin streaming, and to stop when the last watcher leaves', async () => {
    const { io, sentTo } = makeIo()
    const student = makeSocket()
    const instructor = makeSocket()
    wire(io, student.socket)
    wire(io, instructor.socket)

    student.fire('session:join', { sessionId: SESSION })
    expect(student.rooms.has(sessionRoom(SESSION))).toBe(true)
    // Joining is not streaming — nothing has been asked of the student yet.
    expect(sentTo(sessionRoom(SESSION), 'live:start')).toHaveLength(0)

    const ack = vi_fn()
    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' }, ack.fn)
    expect(ack.calls[0]).toEqual({ ok: true, watchers: 1 })
    expect(instructor.rooms.has(watchRoom(SESSION))).toBe(true)
    expect(sentTo(sessionRoom(SESSION), 'live:start')).toHaveLength(1)

    instructor.fire('watch:stop', { sessionId: SESSION })
    expect(sentTo(sessionRoom(SESSION), 'live:stop')).toHaveLength(1)
    expect(registry.isWatched(SESSION)).toBe(false)
  })

  it('a second instructor does not restart the stream, and the first leaving does not end it', async () => {
    // The student is told once to start and once to stop, however many
    // watchers come and go — otherwise a second viewer would trigger a
    // redundant re-sync, and the first one leaving would cut the other off.
    const { io, sentTo } = makeIo()
    const a = makeSocket()
    const b = makeSocket()
    wire(io, a.socket)
    wire(io, b.socket)

    await a.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })
    await b.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })
    expect(sentTo(sessionRoom(SESSION), 'live:start')).toHaveLength(1)

    a.fire('watch:stop', { sessionId: SESSION })
    expect(sentTo(sessionRoom(SESSION), 'live:stop')).toHaveLength(0) // b is still watching
    b.fire('watch:stop', { sessionId: SESSION })
    expect(sentTo(sessionRoom(SESSION), 'live:stop')).toHaveLength(1)
  })

  it('a disconnected watcher stops the stream exactly like an explicit stop', async () => {
    // A closed browser tab must not leave a student streaming to nobody for the
    // rest of the exam.
    const { io, sentTo } = makeIo()
    const instructor = makeSocket()
    wire(io, instructor.socket)
    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })

    instructor.fire('disconnect')
    expect(sentTo(sessionRoom(SESSION), 'live:stop')).toHaveLength(1)
    expect(registry.isWatched(SESSION)).toBe(false)
  })

  it('a student refreshing mid-watch resumes streaming on re-join', async () => {
    const { io } = makeIo()
    const instructor = makeSocket()
    wire(io, instructor.socket)
    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })

    const student = makeSocket()
    wire(io, student.socket)
    student.fire('session:join', { sessionId: SESSION })
    // Told directly, not via the room, because the room membership is what was
    // just re-established.
    expect(student.direct).toContainEqual({ event: 'live:start', payload: { sessionId: SESSION } })
  })
})

// ── Ownership ──────────────────────────────────────────────────────────────

describe('watch:start — access control', () => {
  it('refuses an instructor who does not own the class, and never signals the student', async () => {
    const { io, sentTo } = makeIo()
    const s = makeSocket()
    wire(io, s.socket)
    const ack = vi_fn()

    await s.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-2' }, ack.fn)
    expect(ack.calls[0]).toEqual({ ok: false, error: 'You do not own this class.' })
    expect(s.rooms.has(watchRoom(SESSION))).toBe(false)
    expect(sentTo(sessionRoom(SESSION), 'live:start')).toHaveLength(0)
    expect(registry.isWatched(SESSION)).toBe(false)
  })

  it('refuses a student outright — nobody watches anybody without the instructor role', async () => {
    const { io } = makeIo()
    const s = makeSocket()
    wire(io, s.socket)
    const ack = vi_fn()
    await s.fire('watch:start', { sessionId: SESSION, token: 'tok-student' }, ack.fn)
    expect(ack.calls[0]).toEqual({ ok: false, error: 'Instructor access required' })
    expect(registry.isWatched(SESSION)).toBe(false)
  })

  it('refuses an unauthenticated or forged token', async () => {
    const { io } = makeIo()
    const s = makeSocket()
    wire(io, s.socket)
    const noToken = vi_fn()
    const badToken = vi_fn()
    await s.fire('watch:start', { sessionId: SESSION }, noToken.fn)
    await s.fire('watch:start', { sessionId: SESSION, token: 'nonsense' }, badToken.fn)
    expect(noToken.calls[0]).toEqual({ ok: false, error: 'Authentication required' })
    expect(badToken.calls[0]).toEqual({ ok: false, error: 'Invalid or expired token' })
    expect(registry.isWatched(SESSION)).toBe(false)
  })

  it('a database outage reads as "retry", not as "denied"', async () => {
    // Handing out a permission error for what is actually an outage would send
    // an instructor chasing an access problem that does not exist.
    const { io } = makeIo()
    const s = makeSocket()
    wire(io, s.socket, {
      canWatch: async () => {
        throw new Error('ETIMEDOUT')
      },
    })
    const ack = vi_fn()
    await s.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' }, ack.fn)
    expect(ack.calls[0]).toEqual({ ok: false, error: 'Could not verify access, please retry' })
    expect(registry.isWatched(SESSION)).toBe(false)
  })
})

// ── Keystroke relay ────────────────────────────────────────────────────────

describe('live:keystroke relay', () => {
  const EVENT = { timestamp: 1, fileName: 'main.cpp', rangeOffset: 0, rangeLength: 0, insertedText: 'x' }

  it('reaches the watch room and nothing else', async () => {
    const { io, sentTo, emissions } = makeIo()
    const student = makeSocket()
    const instructor = makeSocket()
    wire(io, student.socket)
    wire(io, instructor.socket)
    student.fire('session:join', { sessionId: SESSION })
    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })

    student.fire('live:keystroke', { sessionId: SESSION, event: EVENT })

    expect(sentTo(watchRoom(SESSION), 'live:keystroke')).toEqual([
      { room: watchRoom(SESSION), event: 'live:keystroke', payload: { sessionId: SESSION, event: EVENT } },
    ])
    // Never to the broadcast instructor room, which carries Tier-1 alerts only.
    expect(emissions.filter((e) => e.room === 'instructors')).toHaveLength(0)
  })

  it('is dropped when nobody is watching', () => {
    // Stream only while watched. A stop signal can lose a race with events
    // already in flight, so the relay is the backstop, not just the client.
    const { io, sentTo } = makeIo()
    const student = makeSocket()
    wire(io, student.socket)
    student.fire('session:join', { sessionId: SESSION })
    student.fire('live:keystroke', { sessionId: SESSION, event: EVENT })
    expect(sentTo(watchRoom(SESSION))).toHaveLength(0)
  })

  it('is dropped from a socket that never joined the session room', async () => {
    const { io, sentTo } = makeIo()
    const instructor = makeSocket()
    const stranger = makeSocket()
    wire(io, instructor.socket)
    wire(io, stranger.socket)
    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })

    stranger.fire('live:keystroke', { sessionId: SESSION, event: EVENT })
    expect(sentTo(watchRoom(SESSION), 'live:keystroke')).toHaveLength(0)
  })

  it('drops an absurdly large payload rather than relaying it', async () => {
    // The flush still carries it; the live copy is what gets skipped.
    const { io, sentTo } = makeIo()
    const student = makeSocket()
    const instructor = makeSocket()
    wire(io, student.socket)
    wire(io, instructor.socket)
    student.fire('session:join', { sessionId: SESSION })
    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })

    student.fire('live:keystroke', {
      sessionId: SESSION,
      event: { ...EVENT, insertedText: 'x'.repeat(600_000) },
    })
    expect(sentTo(watchRoom(SESSION), 'live:keystroke')).toHaveLength(0)
  })

  it('relays the sync and flush signals only while watched', async () => {
    const { io, sentTo } = makeIo()
    const student = makeSocket()
    const instructor = makeSocket()
    wire(io, student.socket)
    wire(io, instructor.socket)
    student.fire('session:join', { sessionId: SESSION })

    student.fire('live:synced', { sessionId: SESSION, at: 999 })
    expect(sentTo(watchRoom(SESSION))).toHaveLength(0) // nobody watching yet

    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })
    student.fire('live:synced', { sessionId: SESSION, at: 999 })
    student.fire('live:flushed', { sessionId: SESSION })

    expect(sentTo(watchRoom(SESSION), 'live:synced')[0].payload).toEqual({
      sessionId: SESSION,
      at: 999,
    })
    expect(sentTo(watchRoom(SESSION), 'live:flushed')).toHaveLength(1)
  })
})

// ── Session end ────────────────────────────────────────────────────────────

describe('announceSessionEnd / announceFlush', () => {
  it('submit ends the live stream cleanly for watchers and student alike', async () => {
    const { io, sentTo } = makeIo()
    const instructor = makeSocket()
    wire(io, instructor.socket)
    await instructor.fire('watch:start', { sessionId: SESSION, token: 'tok-inst-1' })

    announceSessionEnd(io, registry, SESSION)

    // The watcher is told explicitly, so their DVR settles onto the final
    // recorded session instead of an edge that silently stops moving.
    expect(sentTo(watchRoom(SESSION), 'live:end')).toHaveLength(1)
    expect(sentTo(sessionRoom(SESSION), 'live:stop')).toHaveLength(1)
  })

  it('a flush on an unwatched session emits nothing at all', () => {
    // Constraint 2: ingest stays an O(1) append. On the overwhelmingly common
    // unwatched session this must cost one map lookup and no emit.
    const { io, emissions } = makeIo()
    announceFlush(io, registry, SESSION)
    expect(emissions).toHaveLength(0)
  })
})

/** Minimal call recorder — the ack is a plain callback, not a module to mock. */
function vi_fn() {
  const calls: unknown[] = []
  return { calls, fn: (result: unknown) => void calls.push(result) }
}
