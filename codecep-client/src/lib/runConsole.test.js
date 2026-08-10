import { describe, it, expect } from "vitest";
import { runResultEvents, runNetworkErrorEvents, STUDENT_FILES_HINT } from "./runConsole";

const kinds = (entries) => entries.map((e) => e.kind);

describe("runResultEvents — a finished run", () => {
  it("renders stdout then the status line, ending at a prompt", () => {
    const { entries } = runResultEvents(
      { stdout: "12\n", status: "Accepted", exitCode: 0, time: "0.01", memory: 1024 },
      true,
    );
    expect(kinds(entries)).toEqual(["stdout", "ok", "prompt"]);
    expect(entries[0].text).toBe("12");
    expect(entries[1].text).toBe("— Accepted (exit 0 · 0.01s · 1024 KB)");
  });

  it("puts compiler output first, and does not call it a program result", () => {
    const { entries } = runResultEvents(
      { compileOutput: "main.cpp:3:1: error: expected ';'\n", status: "Compilation Error" },
      true,
    );
    expect(kinds(entries)).toEqual(["compile", "stderr", "prompt"]);
  });

  it("orders compile, stdout, stderr, message", () => {
    const { entries } = runResultEvents(
      { compileOutput: "c", stdout: "o", stderr: "e", message: "m", status: "Accepted" },
      true,
    );
    expect(kinds(entries)).toEqual(["compile", "stdout", "stderr", "stderr", "ok", "prompt"]);
  });

  it("falls back to the legacy single `output` field", () => {
    const { entries } = runResultEvents({ output: "hello", status: "Accepted" }, true);
    expect(entries[0]).toEqual({ kind: "stdout", text: "hello" });
  });

  it('says "(no output)" rather than showing an empty console', () => {
    const { entries } = runResultEvents({ status: "Accepted", exitCode: 0 }, true);
    expect(entries[0]).toEqual({ kind: "meta", text: "(no output)" });
  });

  it("surfaces a REJECTED workspace as an error, not as a program that printed nothing", () => {
    const { entries, outputFiles } = runResultEvents({ error: "Invalid file name \"a b.cpp\"." }, false);
    expect(kinds(entries)).toEqual(["stderr", "prompt"]);
    expect(entries[0].text).toMatch(/Invalid file name/);
    expect(outputFiles).toEqual([]);
  });

  it("announces written files without dumping their contents into the console", () => {
    const { entries, outputFiles } = runResultEvents(
      {
        stdout: "done",
        status: "Accepted",
        outputFiles: [{ name: "out.txt", bytes: 47, content: "x".repeat(47) }],
      },
      true,
    );
    const files = entries.find((e) => e.text.startsWith("[files]"));
    expect(files.text).toContain("out.txt (47B)");
    expect(files.text).not.toContain("xxx");
    expect(files.text).toContain(STUDENT_FILES_HINT);
    expect(outputFiles).toHaveLength(1);
  });

  it("reports a truncated capture instead of showing a partial file as whole", () => {
    const { entries } = runResultEvents(
      {
        stdout: "done",
        status: "Accepted",
        outputFiles: [{ name: "big.txt", bytes: 99999, truncated: true }],
      },
      true,
    );
    expect(entries.some((e) => /64 KB preview limit/.test(e.text))).toBe(true);
  });

  it("takes a caller-supplied files hint — the instructor console has no file panel", () => {
    const { entries } = runResultEvents(
      { stdout: "x", status: "Accepted", outputFiles: [{ name: "o.txt", bytes: 2 }] },
      true,
      { filesHint: " — from this run only" },
    );
    const files = entries.find((e) => e.text.startsWith("[files]"));
    expect(files.text).toContain(" — from this run only");
    expect(files.text).not.toContain("file panel");
  });
});

describe("runNetworkErrorEvents", () => {
  it("names the failure and returns to a prompt", () => {
    expect(runNetworkErrorEvents("Failed to fetch")).toEqual([
      { kind: "stderr", text: "Network error — Failed to fetch" },
      { kind: "prompt", text: "$" },
    ]);
  });
});
