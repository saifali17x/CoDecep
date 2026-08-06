import { describe, it, expect, beforeEach } from 'vitest'
import { WatchRegistry } from './watchRegistry'

// The registry decides WHEN a student streams. Its whole contract is the
// first/last framing: exactly one start and one stop reach the student however
// many instructors come and go in between.

let r: WatchRegistry
beforeEach(() => {
  r = new WatchRegistry()
})

describe('WatchRegistry', () => {
  it('reports the first watcher and the last, and nothing in between', () => {
    expect(r.add('s1', 'a')).toEqual({ firstWatcher: true, watcherCount: 1 })
    expect(r.add('s1', 'b')).toEqual({ firstWatcher: false, watcherCount: 2 })
    expect(r.add('s1', 'c')).toEqual({ firstWatcher: false, watcherCount: 3 })

    expect(r.remove('s1', 'b')).toEqual({ lastWatcher: false, watcherCount: 2 })
    expect(r.remove('s1', 'a')).toEqual({ lastWatcher: false, watcherCount: 1 })
    expect(r.remove('s1', 'c')).toEqual({ lastWatcher: true, watcherCount: 0 })
    expect(r.isWatched('s1')).toBe(false)
  })

  it('a duplicate watch:start does not double-count the same socket', () => {
    r.add('s1', 'a')
    expect(r.add('s1', 'a')).toEqual({ firstWatcher: false, watcherCount: 1 })
    expect(r.remove('s1', 'a')).toEqual({ lastWatcher: true, watcherCount: 0 })
  })

  it('a stray stop cannot cut a stream someone else is watching', () => {
    // Without this guard a duplicate or mistargeted watch:stop would report
    // "last watcher" and silently kill the feed the real watcher is using.
    r.add('s1', 'a')
    expect(r.remove('s1', 'ghost')).toEqual({ lastWatcher: false, watcherCount: 1 })
    expect(r.remove('s2', 'a')).toEqual({ lastWatcher: false, watcherCount: 0 })
    expect(r.isWatched('s1')).toBe(true)
  })

  it('tracks several sessions independently', () => {
    r.add('s1', 'a')
    r.add('s2', 'a')
    r.add('s2', 'b')
    expect(r.watcherCount('s1')).toBe(1)
    expect(r.watcherCount('s2')).toBe(2)
    expect(r.sessionsOf('a').sort()).toEqual(['s1', 's2'])
    expect(r.remove('s1', 'a')).toEqual({ lastWatcher: true, watcherCount: 0 })
    expect(r.isWatched('s2')).toBe(true)
  })

  it('removeSocket returns only the sessions that lost their LAST watcher', () => {
    // One instructor watching two students, one of whom is also watched by a
    // colleague: closing the tab must stop the first student and not the second.
    r.add('s1', 'a')
    r.add('s2', 'a')
    r.add('s2', 'b')
    expect(r.removeSocket('a')).toEqual(['s1'])
    expect(r.isWatched('s1')).toBe(false)
    expect(r.watcherCount('s2')).toBe(1)
    expect(r.sessionsOf('a')).toEqual([])
  })

  it('removeSocket on an unknown socket is a no-op', () => {
    expect(r.removeSocket('never-seen')).toEqual([])
  })

  it('re-watching after everyone left reports a first watcher again', () => {
    r.add('s1', 'a')
    r.remove('s1', 'a')
    expect(r.add('s1', 'a')).toEqual({ firstWatcher: true, watcherCount: 1 })
  })
})
