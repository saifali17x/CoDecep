import { describe, it, expect } from 'vitest'
import { selectTaskWorkspace, workspaceFromSnapshot } from './instructorRun'

describe('workspaceFromSnapshot', () => {
  it('turns a stored snapshot into a Judge0 workspace with main.cpp first', () => {
    const files = workspaceFromSnapshot({
      'Student.cpp': 'b',
      'main.cpp': 'a',
      'data.txt': 'c',
    })
    // main.cpp first (the glob's entry point), the rest in locale order.
    expect(files[0].name).toBe('main.cpp')
    expect(files.map((f) => f.name).slice(1).sort()).toEqual(['Student.cpp', 'data.txt'])
    expect(files.find((f) => f.name === 'main.cpp')?.content).toBe('a')
  })

  it('drops non-string contents rather than coercing them', () => {
    // The snapshot is data read back OUT of the database. Coercing would send
    // "[object Object]" to a compiler and report it as the student's error.
    const files = workspaceFromSnapshot({ 'main.cpp': 'ok', 'bad.cpp': { nope: 1 }, 'n.cpp': 5 })
    expect(files.map((f) => f.name)).toEqual(['main.cpp'])
  })

  it('is empty for null/undefined/non-object input', () => {
    expect(workspaceFromSnapshot(null)).toEqual([])
    expect(workspaceFromSnapshot(undefined)).toEqual([])
    expect(workspaceFromSnapshot('main.cpp')).toEqual([])
  })

  it('keeps an empty file as an empty file', () => {
    // The record says the student cleared it; inventing content is exactly what
    // must not happen (same rule the restore builders follow).
    const files = workspaceFromSnapshot({ 'main.cpp': '' })
    expect(files).toEqual([{ name: 'main.cpp', content: '' }])
  })
})

describe('selectTaskWorkspace — which task to run', () => {
  const single = { task1: { 'main.cpp': 'int main(){}' } }
  const multi = {
    task1: { 'main.cpp': 'one' },
    task2: { 'main.cpp': 'two', 'Helper.cpp': 'h' },
  }

  it('needs no task id on a single-task session', () => {
    const sel = selectTaskWorkspace(single, undefined)
    expect(sel.ok).toBe(true)
    if (sel.ok) {
      expect(sel.taskId).toBe('task1')
      expect(sel.files).toEqual([{ name: 'main.cpp', content: 'int main(){}' }])
    }
  })

  it('treats null and empty string as "not specified"', () => {
    for (const requested of [null, '']) {
      const sel = selectTaskWorkspace(single, requested)
      expect(sel.ok).toBe(true)
    }
  })

  it('runs the SELECTED task on a multi-task session', () => {
    const sel = selectTaskWorkspace(multi, 'task2')
    expect(sel.ok).toBe(true)
    if (sel.ok) {
      expect(sel.taskId).toBe('task2')
      expect(sel.files.map((f) => f.name)).toEqual(['main.cpp', 'Helper.cpp'])
      expect(sel.files[0].content).toBe('two')
    }
  })

  it('REFUSES to guess a task on a multi-task session', () => {
    // Silently running Task 1 while the instructor reads Task 3 would show them
    // the wrong program and let them believe it was the right one.
    const sel = selectTaskWorkspace(multi, undefined)
    expect(sel.ok).toBe(false)
    if (!sel.ok) expect(sel.error).toMatch(/2 tasks/)
  })

  it('rejects a task id outside task1–task6', () => {
    for (const bad of ['task0', 'task7', 'task', 'TASK1', 'task1 ', 42, {}]) {
      const sel = selectTaskWorkspace(multi, bad)
      expect(sel.ok).toBe(false)
      if (!sel.ok) expect(sel.error).toMatch(/task1–task6/)
    }
  })

  it('says so when the session recorded nothing for that task', () => {
    // An empty run reading "(no output)" is indistinguishable from a program
    // that printed nothing.
    const sel = selectTaskWorkspace(multi, 'task5')
    expect(sel.ok).toBe(false)
    if (!sel.ok) expect(sel.error).toMatch(/no files for task5/)
  })

  it('says so when the session recorded no code at all', () => {
    for (const empty of [{}, null, undefined]) {
      const sel = selectTaskWorkspace(empty, undefined)
      expect(sel.ok).toBe(false)
      if (!sel.ok) expect(sel.error).toMatch(/no code to run/)
    }
  })

  it('handles a pre-multi-task session, which presents as task1', () => {
    // finalTaskSnapshots() gives every legacy session a single `task1` bucket,
    // so this path needs no branch of its own.
    const legacy = { task1: { 'main.cpp': '#include <iostream>' } }
    const sel = selectTaskWorkspace(legacy, 'task1')
    expect(sel.ok).toBe(true)
    if (sel.ok) expect(sel.taskId).toBe('task1')
  })
})
