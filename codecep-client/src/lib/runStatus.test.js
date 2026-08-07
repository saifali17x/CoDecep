import { describe, it, expect } from "vitest";
import { runStatusOf, IDLE_STATUS, RUNNING_STATUS } from "./runStatus";

// The console header's one-line verdict. Judge0's own `status` strings are the
// input, so the cases below are the shapes /api/execute actually returns.

describe("runStatusOf", () => {
  it("reports a clean run with its exit code", () => {
    expect(runStatusOf({ status: "Accepted", exitCode: 0 })).toEqual({
      state: "ok",
      label: "Exited (0)",
    });
  });

  it("defaults an accepted run with no exit code to 0", () => {
    expect(runStatusOf({ status: "Accepted" })).toEqual({ state: "ok", label: "Exited (0)" });
  });

  it("names a compilation error rather than folding it into a generic failure", () => {
    // The single outcome a student most needs to recognise instantly.
    expect(runStatusOf({ status: "Compilation Error" })).toEqual({
      state: "compile",
      label: "Compilation error",
    });
  });

  it("reports a runtime failure with its status and exit code", () => {
    expect(runStatusOf({ status: "Runtime Error (SIGSEGV)", exitCode: 139 })).toEqual({
      state: "error",
      label: "Runtime Error (SIGSEGV) — exited (139)",
    });
  });

  it("reports a non-accepted status with no exit code as itself", () => {
    expect(runStatusOf({ status: "Time Limit Exceeded" })).toEqual({
      state: "error",
      label: "Time Limit Exceeded",
    });
  });

  it("distinguishes a REJECTED workspace from a program result", () => {
    // A bad filename never reached Judge0, so calling it "exited (1)" would be
    // a claim about a program that was never run.
    const rejected = { error: "Invalid file name: ../evil.cpp" };
    expect(runStatusOf(rejected, false)).toEqual({ state: "error", label: "Run rejected" });
    expect(runStatusOf(rejected, true)).toEqual({ state: "error", label: "Run rejected" });
  });

  it("falls back to a neutral finish for an unrecognised shape", () => {
    expect(runStatusOf({})).toEqual({ state: "error", label: "Finished" });
    expect(runStatusOf(null)).toEqual({ state: "error", label: "Finished" });
  });
});

describe("resting states", () => {
  it("reads Ready before anything has run, and Running while one is in flight", () => {
    expect(IDLE_STATUS).toEqual({ state: "idle", label: "Ready" });
    expect(RUNNING_STATUS).toEqual({ state: "running", label: "Running…" });
  });
});
