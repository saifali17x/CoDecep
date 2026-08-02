// ── Multi-file exam workspaces on Judge0 ────────────────────────────────────
// Judge0 CE 1.14 (ce.judge0.com) exposes language id 89, "Multi-file program".
// A submission for it carries the whole project as a base64 zip in
// `additional_files`; Judge0 unpacks it into the sandbox working directory,
// runs the archive's `compile` script, then its `run` script. `source_code` is
// unused. That is the mechanism this module packages for.
//
// Two consequences shape everything below:
//   1. Because the WHOLE workspace lands in the working directory, a student's
//      data files (.txt/.csv/.dat) are simply THERE at runtime — `ifstream
//      fin("data.txt")` resolves with no extra machinery. Same for `#include
//      "Student.h"`.
//   2. Judge0 does NOT hand back files the program wrote. It returns
//      stdout/stderr/compile_output and nothing else. So the `run` script
//      emits the working directory's data files to stdout inside sentinels
//      after the program exits, and the server (see splitCapturedFiles) peels
//      that block back off stdout before the student ever sees it.

export const CODE_EXTENSIONS = ['cpp', 'h'] as const
export const DATA_EXTENSIONS = ['txt', 'csv', 'dat'] as const
export const ALLOWED_EXTENSIONS = [...CODE_EXTENSIONS, ...DATA_EXTENSIONS]

export const ENTRY_FILE = 'main.cpp'

export const MAX_FILES = 30
export const MAX_TOTAL_BYTES = 512_000
// Mirrors the `head -c` cap in the run script. A program that writes more than
// this still runs fine; we just report the file as truncated for display.
export const MAX_CAPTURED_FILE_BYTES = 65_536

// Distinctive enough that a student's own output colliding with it is not a
// realistic concern. Worst case a collision garbles the display of captured
// files; it cannot affect grading, telemetry or forensics.
const SENTINEL_OPEN = '<<<CODECEP_FILE:'
const SENTINEL_CLOSE = '>>>'
const SENTINEL_END = '<<<CODECEP_ENDFILE>>>'

// Filenames are restricted at BOTH ends (client and here). The character class
// admits no '/' or '\', and requires a single dot before a known extension, so
// '..', 'a/../b.cpp' and 'x..cpp' are all rejected — nothing can escape the
// sandbox working directory or collide with the compile/run scripts (which
// have no extension and therefore cannot be named by a student).
const FILENAME_RE = new RegExp(`^[A-Za-z0-9_-]+\\.(${ALLOWED_EXTENSIONS.join('|')})$`)

export interface WorkspaceFile {
  name: string
  content: string
}

export interface CapturedFile {
  name: string
  content: string
  bytes: number
  truncated: boolean
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isCodeFile(name: string): boolean {
  return (CODE_EXTENSIONS as readonly string[]).includes(extensionOf(name))
}

/**
 * Validate an incoming workspace. Returns an error message, or null when the
 * workspace is safe to package.
 */
export function validateWorkspace(files: unknown): string | null {
  if (!Array.isArray(files)) return '"files" must be an array of { name, content }.'
  if (files.length === 0) return '"files" must contain at least main.cpp.'
  if (files.length > MAX_FILES) return `A workspace may contain at most ${MAX_FILES} files.`

  const seen = new Set<string>()
  let totalBytes = 0

  for (const file of files) {
    if (typeof file !== 'object' || file === null) return 'Each file must be an object.'
    const { name, content } = file as Record<string, unknown>
    if (typeof name !== 'string' || !FILENAME_RE.test(name)) {
      return `Invalid file name "${String(name)}". Use letters, digits, dash or underscore and one of: ${ALLOWED_EXTENSIONS.map((e) => '.' + e).join(', ')}.`
    }
    if (typeof content !== 'string') return `File "${name}" must have a string "content".`
    if (seen.has(name)) return `Duplicate file name "${name}".`
    seen.add(name)
    totalBytes += Buffer.byteLength(content, 'utf8')
  }

  if (!seen.has(ENTRY_FILE)) return `The workspace must contain ${ENTRY_FILE}.`
  if (totalBytes > MAX_TOTAL_BYTES) {
    return `Workspace exceeds ${MAX_TOTAL_BYTES} bytes of source and data.`
  }
  return null
}

/**
 * Globbed build: every .cpp in the working directory is compiled and linked
 * together, so Student.cpp + main.cpp become one program and the .h headers
 * sitting alongside them resolve for `#include "Student.h"`.
 */
export function buildCompileScript(): string {
  return ['#!/bin/bash', 'g++ -std=c++17 -o main *.cpp', ''].join('\n')
}

/**
 * Runs the program, then emits every data file left in the working directory
 * inside sentinels so written files can be recovered (see the module header).
 *
 * The leading "\n" before each open sentinel is deliberate and is consumed by
 * splitCapturedFiles: it makes the block separable whether or not the program's
 * own output ended with a newline, so the student's stdout is reproduced byte
 * for byte either way.
 *
 * The program's exit code is preserved so Judge0 still reports a crash or a
 * non-zero return.
 */
export function buildRunScript(): string {
  return [
    '#!/bin/bash',
    './main',
    '__codecep_rc=$?',
    'shopt -s nullglob',
    `for __codecep_f in ${DATA_EXTENSIONS.map((e) => '*.' + e).join(' ')}; do`,
    '  [ -f "$__codecep_f" ] || continue',
    `  printf '\\n${SENTINEL_OPEN}%s:%s${SENTINEL_CLOSE}\\n' "$__codecep_f" "$(stat -c %s "$__codecep_f")"`,
    `  head -c ${MAX_CAPTURED_FILE_BYTES} "$__codecep_f"`,
    `  printf '\\n${SENTINEL_END}\\n'`,
    'done',
    'exit $__codecep_rc',
    '',
  ].join('\n')
}

/**
 * Peel the captured-files block off the end of stdout.
 *
 * Returns the program's own stdout (exactly as it wrote it) plus every data
 * file present in the working directory when the run finished. Callers then
 * diff those against what was sent in to find the ones the program WROTE.
 */
export function splitCapturedFiles(stdout: string): {
  programStdout: string
  captured: CapturedFile[]
} {
  const marker = '\n' + SENTINEL_OPEN
  const first = stdout.indexOf(marker)
  if (first === -1) return { programStdout: stdout, captured: [] }

  const programStdout = stdout.slice(0, first)
  const captured: CapturedFile[] = []

  let cursor = first
  while (cursor !== -1) {
    const headerStart = cursor + marker.length
    const headerEnd = stdout.indexOf(SENTINEL_CLOSE + '\n', headerStart)
    if (headerEnd === -1) break

    const header = stdout.slice(headerStart, headerEnd) // "name:declaredBytes"
    const split = header.lastIndexOf(':')
    const name = split === -1 ? header : header.slice(0, split)
    const declaredBytes = split === -1 ? NaN : Number(header.slice(split + 1))

    const bodyStart = headerEnd + SENTINEL_CLOSE.length + 1
    const bodyEnd = stdout.indexOf('\n' + SENTINEL_END, bodyStart)
    if (bodyEnd === -1) break

    const content = stdout.slice(bodyStart, bodyEnd)
    const bytes = Number.isFinite(declaredBytes)
      ? declaredBytes
      : Buffer.byteLength(content, 'utf8')
    captured.push({
      name,
      content,
      bytes,
      truncated: bytes > Buffer.byteLength(content, 'utf8'),
    })

    cursor = stdout.indexOf(marker, bodyEnd + 1)
  }

  return { programStdout, captured }
}

/**
 * Which captured files did the program actually write? A file counts as output
 * when it was not sent in at all (created by the program) or its contents
 * changed (rewritten or appended to). Untouched input data files are dropped —
 * echoing them back would just be noise.
 */
export function selectWrittenFiles(
  inputs: WorkspaceFile[],
  captured: CapturedFile[],
): CapturedFile[] {
  const sent = new Map(inputs.map((f) => [f.name, f.content]))
  return captured.filter((file) => {
    if (!sent.has(file.name)) return true
    // A truncated capture can't be compared byte for byte; treat a big file as
    // written rather than silently hiding it.
    if (file.truncated) return true
    return sent.get(file.name) !== file.content
  })
}
