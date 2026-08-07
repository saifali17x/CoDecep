// ── Exam workspace file model (Session 23) ──────────────────────────────────
// The exam is no longer a single buffer: a student can hold several files at
// once, which is what a real OOP question needs (Student.h / Student.cpp /
// main.cpp) and what file-I/O questions need (data.txt to read, out.txt to
// write).
//
// Pure module — no React, no DOM. The server enforces the same rules in
// codecep-server/src/lib/multiFile.ts; keep the two in step.

export const CODE_EXTENSIONS = ["cpp", "h"];
export const DATA_EXTENSIONS = ["txt", "csv", "dat"];
export const ALLOWED_EXTENSIONS = [...CODE_EXTENSIONS, ...DATA_EXTENSIONS];

// main.cpp is the entry point: it always exists and cannot be deleted, because
// the build is `g++ *.cpp -o main` and there has to be a main().
export const ENTRY_FILE = "main.cpp";

export const MAX_FILES = 30;

// Letters/digits/dash/underscore, one dot, a known extension. No path
// separators and no "..", so a name can never point outside the sandbox
// working directory.
const FILENAME_RE = new RegExp(`^[A-Za-z0-9_-]+\\.(${ALLOWED_EXTENSIONS.join("|")})$`);

export function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 'code' for .cpp/.h, 'data' for .txt/.csv/.dat. */
export function kindOf(name) {
  return CODE_EXTENSIONS.includes(extensionOf(name)) ? "code" : "data";
}

/** Monaco language mode for a file — data files must NOT be parsed as C++. */
export function languageOf(name) {
  return kindOf(name) === "code" ? "cpp" : "plaintext";
}

/** Short uppercase badge shown on tabs and in the file panel. */
export function badgeOf(name) {
  const ext = extensionOf(name);
  if (ext === "cpp") return "C++";
  if (ext === "h") return "H";
  return ext.toUpperCase();
}

/**
 * Validate a new or renamed file name.
 * Returns an error string to show the student, or null when the name is fine.
 */
export function validateFileName(rawName, existingNames = [], { ignore } = {}) {
  const name = (rawName ?? "").trim();
  if (!name) return "Enter a file name.";
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return "File names cannot contain path separators.";
  }
  if (!name.includes(".")) {
    return `Add an extension: ${ALLOWED_EXTENSIONS.map((e) => "." + e).join(", ")}`;
  }
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(name))) {
    return `.${extensionOf(name)} files are not allowed. Use ${ALLOWED_EXTENSIONS.map((e) => "." + e).join(", ")}`;
  }
  if (!FILENAME_RE.test(name)) {
    return "Use only letters, digits, dashes and underscores in the name.";
  }
  if (existingNames.some((n) => n !== ignore && n.toLowerCase() === name.toLowerCase())) {
    return `"${name}" already exists.`;
  }
  return null;
}

/**
 * The workspace an exam opens with: main.cpp and nothing else, EMPTY.
 * Pre-written boilerplate is code the student neither typed nor pasted, which
 * is why exams start blank (see CLAUDE.md §7) — that holds for every file here.
 */
export function createWorkspace(initialCode = "") {
  return [{ name: ENTRY_FILE, content: initialCode }];
}

// ── Restoring a workspace after a refresh (gap-fixes part 2, Fix 2) ─────────
// The student's code comes back from the last DATABASE FLUSH, so what is put on
// screen is by construction what the forensic record holds — there is no
// browser-storage copy that could drift from it. These builders are pure and
// are applied BEFORE the editor mounts, which is what keeps the restore free of
// telemetry: Monaco opens already holding the restored text, so no content
// change is ever reported for it (see App.jsx and EditorPane's prevCode anchor).

/**
 * One task's workspace from a flushed snapshot: { fileName: text } → the
 * `[{ name, content }]` shape the editor holds.
 *
 * Defensive about what it accepts because the snapshot is data read back out of
 * the database rather than something just constructed: a name that no longer
 * passes the file rules is dropped rather than reintroduced into the workspace,
 * and main.cpp is guaranteed to exist because the build (`g++ *.cpp`) has to
 * have an entry point. Returns null when there is nothing worth restoring, so
 * the caller can fall back to a blank workspace instead of an empty file list.
 */
export function filesFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const files = [];
  for (const [name, content] of Object.entries(snapshot)) {
    if (typeof content !== "string") continue;
    if (validateFileName(name, files.map((f) => f.name)) !== null) continue;
    files.push({ name, content });
    if (files.length >= MAX_FILES) break;
  }
  if (files.length === 0) return null;
  if (!files.some((f) => f.name === ENTRY_FILE)) files.push({ name: ENTRY_FILE, content: "" });
  return sortFiles(files);
}

/**
 * Every task's workspace for an exam, restoring what was flushed and opening
 * blank where nothing was.
 *
 * `taskIds` (from the assignment's taskCount) decides the shape, never the
 * snapshot: a task the student never opened still gets its blank workspace, and
 * a snapshot for a task outside this exam is ignored rather than growing a tab
 * that does not exist.
 */
export function restoreWorkspaces(taskIds, taskSnapshots, initialCode = "") {
  const byTask = taskSnapshots && typeof taskSnapshots === "object" ? taskSnapshots : {};
  return Object.fromEntries(
    taskIds.map((id) => [id, filesFromSnapshot(byTask[id]) ?? createWorkspace(initialCode)]),
  );
}

// ── Tasks (multi-task exams, Prompt 1) ──────────────────────────────────────
// An exam can be a midterm with N questions. A TASK is deliberately
// lightweight: an id, a label, and its OWN file workspace — same file rules,
// same blank start, same entry point. One PDF, one allowlist and one submit
// still cover the whole exam; only the workspace multiplies.
//
// Mirrors the server's forensics/metrics.ts (DEFAULT_TASK / taskLabel) — keep
// the two in step, as with the file model above.

export const MAX_TASKS = 6;
export const DEFAULT_TASK = "task1";

/** Stable id for the Nth task (0-based index): 0 → 'task1'. */
export function taskIdAt(index) {
  return `task${index + 1}`;
}

/** Human label shown on the tab and in reports: 'task3' → 'Task 3'. */
export function taskLabel(taskId) {
  const match = /^task(\d+)$/.exec(taskId ?? "");
  return match ? `Task ${match[1]}` : (taskId ?? "Task 1");
}

/**
 * The task ids for an assignment. A missing/invalid count means ONE task, i.e.
 * exactly the single-workspace exam that existed before this feature.
 */
export function makeTaskIds(taskCount) {
  const n = Number.isFinite(taskCount) ? Math.floor(taskCount) : 1;
  const clamped = Math.min(Math.max(n, 1), MAX_TASKS);
  return Array.from({ length: clamped }, (_, i) => taskIdAt(i));
}

// Captured program-output files live alongside the workspace but are NOT part
// of it — they are read-only results, and a program that rewrites its own input
// (ofstream on an existing data.txt) would otherwise collide with the editable
// file of the same name. Prefixing keeps the two selectable independently and
// gives each its own Monaco model.
export const OUTPUT_PREFIX = "output:";

export function outputKey(name) {
  return OUTPUT_PREFIX + name;
}

export function isOutputKey(key) {
  return typeof key === "string" && key.startsWith(OUTPUT_PREFIX);
}

export function outputNameOf(key) {
  return isOutputKey(key) ? key.slice(OUTPUT_PREFIX.length) : null;
}

/** Sort for display: main.cpp first, then the rest alphabetically. */
export function sortFiles(files) {
  return [...files].sort((a, b) => {
    if (a.name === ENTRY_FILE) return -1;
    if (b.name === ENTRY_FILE) return 1;
    return a.name.localeCompare(b.name);
  });
}
