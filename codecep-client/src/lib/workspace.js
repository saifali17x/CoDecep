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
