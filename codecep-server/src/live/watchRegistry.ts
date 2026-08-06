// Live DVR — who is watching whom (Session 28). PURE bookkeeping: no socket.io,
// no database, no I/O. Everything that decides WHEN a student starts and stops
// streaming lives here so it can be unit-tested directly.
//
// The registry answers exactly two questions the relay needs:
//
//   • did this watcher arrive FIRST? → tell the student to begin streaming
//   • did this watcher leave LAST?   → tell the student to stop
//
// That first/last framing is what keeps the "stream only while watched" rule
// true with several instructors on one student: the student is told once to
// start and once to stop, however many watchers come and go in between.

export interface WatchDelta {
  /** This watcher was the first — the student must BEGIN live-emitting. */
  firstWatcher: boolean
  /** Watchers on this session after the change. */
  watcherCount: number
}

export class WatchRegistry {
  /** sessionId → socket ids watching it */
  private readonly bySession = new Map<string, Set<string>>()
  /** socket id → sessions it watches (so a disconnect can clean up in O(1)) */
  private readonly bySocket = new Map<string, Set<string>>()

  add(sessionId: string, socketId: string): WatchDelta {
    let watchers = this.bySession.get(sessionId)
    if (!watchers) {
      watchers = new Set()
      this.bySession.set(sessionId, watchers)
    }
    const firstWatcher = watchers.size === 0
    watchers.add(socketId)

    let sessions = this.bySocket.get(socketId)
    if (!sessions) {
      sessions = new Set()
      this.bySocket.set(socketId, sessions)
    }
    sessions.add(sessionId)

    return { firstWatcher, watcherCount: watchers.size }
  }

  /**
   * Returns `lastWatcher: true` only when this call actually removed the final
   * watcher — a duplicate `watch:stop`, or a stop for a session this socket was
   * never watching, reports false and changes nothing. Without that, a stray
   * stop from one instructor could silently cut the stream another is watching.
   */
  remove(sessionId: string, socketId: string): { lastWatcher: boolean; watcherCount: number } {
    const watchers = this.bySession.get(sessionId)
    const sessions = this.bySocket.get(socketId)
    sessions?.delete(sessionId)
    if (sessions && sessions.size === 0) this.bySocket.delete(socketId)

    if (!watchers || !watchers.delete(socketId)) {
      return { lastWatcher: false, watcherCount: watchers?.size ?? 0 }
    }
    if (watchers.size === 0) {
      this.bySession.delete(sessionId)
      return { lastWatcher: true, watcherCount: 0 }
    }
    return { lastWatcher: false, watcherCount: watchers.size }
  }

  /**
   * Drop a socket entirely (disconnect / browser closed). Returns the sessions
   * that just lost their LAST watcher, i.e. the students who should stop
   * streaming. A closed instructor tab must stop the stream exactly as an
   * explicit `watch:stop` does — otherwise a student streams to nobody for the
   * rest of the exam.
   */
  removeSocket(socketId: string): string[] {
    const sessions = this.bySocket.get(socketId)
    if (!sessions) return []
    const orphaned: string[] = []
    for (const sessionId of sessions) {
      const watchers = this.bySession.get(sessionId)
      if (!watchers) continue
      watchers.delete(socketId)
      if (watchers.size === 0) {
        this.bySession.delete(sessionId)
        orphaned.push(sessionId)
      }
    }
    this.bySocket.delete(socketId)
    return orphaned
  }

  watcherCount(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0
  }

  isWatched(sessionId: string): boolean {
    return this.watcherCount(sessionId) > 0
  }

  sessionsOf(socketId: string): string[] {
    return [...(this.bySocket.get(socketId) ?? [])]
  }
}
