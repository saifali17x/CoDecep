import { describe, it, expect } from "vitest";
import {
  ENTRY_FILE,
  createWorkspace,
  filesFromSnapshot,
  restoreWorkspaces,
} from "./workspace";

// ── Restoring a workspace after a refresh (gap-fixes part 2, Fix 2) ─────────
// These builders decide what the editor OPENS with. They are pure and are
// applied in App's state initializer, before Monaco mounts — which is what
// makes the restore telemetry-free. The no-phantom-paste claim itself is a
// browser-level fact and is verified in the live E2E, not asserted here.

describe("filesFromSnapshot", () => {
  it("returns null when there is nothing to restore", () => {
    expect(filesFromSnapshot(null)).toBeNull();
    expect(filesFromSnapshot(undefined)).toBeNull();
    expect(filesFromSnapshot({})).toBeNull();
    expect(filesFromSnapshot("not a snapshot")).toBeNull();
  });

  it("restores a single-file workspace", () => {
    expect(filesFromSnapshot({ "main.cpp": "int main(){}" })).toEqual([
      { name: "main.cpp", content: "int main(){}" },
    ]);
  });

  it("restores every file, code and data alike, main.cpp first", () => {
    const files = filesFromSnapshot({
      "Student.cpp": "impl",
      "data.txt": "1 2 3",
      "main.cpp": "entry",
      "Student.h": "decl",
    });
    // main.cpp pinned first, the rest by the existing sortFiles ordering
    // (localeCompare, so "data.txt" precedes "Student.cpp").
    expect(files.map((f) => f.name)).toEqual([
      "main.cpp",
      "data.txt",
      "Student.cpp",
      "Student.h",
    ]);
    expect(files.find((f) => f.name === "data.txt").content).toBe("1 2 3");
  });

  it("restores an empty file as empty rather than dropping it", () => {
    // A student who cleared a file had that emptiness flushed; putting the old
    // content back would show them code the record says they deleted.
    const files = filesFromSnapshot({ "main.cpp": "", "notes.txt": "kept" });
    expect(files.find((f) => f.name === "main.cpp").content).toBe("");
  });

  it("guarantees main.cpp exists — it is the entry point the build links", () => {
    const files = filesFromSnapshot({ "helper.cpp": "x" });
    expect(files.some((f) => f.name === ENTRY_FILE)).toBe(true);
    expect(files.find((f) => f.name === ENTRY_FILE).content).toBe("");
  });

  it("drops names that no longer pass the file rules", () => {
    // The snapshot is data read back out of the database, so a name that could
    // not be created today is not reintroduced into the workspace.
    const files = filesFromSnapshot({
      "main.cpp": "ok",
      "../escape.cpp": "no",
      "evil.py": "no",
      "task1/main.cpp": "no",
    });
    expect(files.map((f) => f.name)).toEqual(["main.cpp"]);
  });

  it("ignores non-string content", () => {
    const files = filesFromSnapshot({ "main.cpp": "ok", "bad.txt": { nope: true } });
    expect(files.map((f) => f.name)).toEqual(["main.cpp"]);
  });
});

describe("restoreWorkspaces", () => {
  it("opens every task blank when there is nothing flushed", () => {
    const ws = restoreWorkspaces(["task1", "task2"], null);
    expect(ws.task1).toEqual(createWorkspace(""));
    expect(ws.task2).toEqual(createWorkspace(""));
  });

  it("restores each task's own workspace", () => {
    const ws = restoreWorkspaces(["task1", "task2"], {
      task1: { "main.cpp": "one" },
      task2: { "main.cpp": "two", "notes.txt": "n" },
    });
    expect(ws.task1).toEqual([{ name: "main.cpp", content: "one" }]);
    expect(ws.task2.map((f) => f.name)).toEqual(["main.cpp", "notes.txt"]);
  });

  it("opens a task the student never reached blank, beside restored ones", () => {
    const ws = restoreWorkspaces(["task1", "task2", "task3"], { task1: { "main.cpp": "done" } });
    expect(ws.task1[0].content).toBe("done");
    expect(ws.task2).toEqual(createWorkspace(""));
    expect(ws.task3).toEqual(createWorkspace(""));
  });

  it("ignores a snapshot for a task this exam does not have", () => {
    // taskCount decides the shape, never the stored data — a snapshot left over
    // from a larger exam must not grow a tab that does not exist.
    const ws = restoreWorkspaces(["task1"], { task1: { "main.cpp": "a" }, task5: { "main.cpp": "b" } });
    expect(Object.keys(ws)).toEqual(["task1"]);
  });

  it("falls back to blank for a task whose snapshot is unusable", () => {
    const ws = restoreWorkspaces(["task1"], { task1: { "evil.py": "x" } });
    expect(ws.task1).toEqual(createWorkspace(""));
  });
});
