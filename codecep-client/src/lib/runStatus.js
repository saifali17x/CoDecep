// ── Run status line for the execution console (UI polish part 1) ─────────────
//
// PURE module — no React, no DOM. Turns an /api/execute response into the one
// line the console header shows: "Exited (0)", "Compilation error", "Runtime
// error — exited (139)".
//
// Why it is separate: the console header and the console body must never
// disagree about how a run ended, and the header line is the thing a student
// reads first when their program did not do what they expected. Deriving it in
// one tested place beats re-deciding "was that a compile error?" inline.
//
// This reads the SAME response the console already renders. It changes nothing
// about execution: /api/execute, the Judge0 batch model and `runCount` are
// untouched (see CLAUDE.md §7.4).

/** Nothing has been run yet in this task's console. */
export const IDLE_STATUS = { state: "idle", label: "Ready" };

/** A run is in flight (the header also shows a spinner). */
export const RUNNING_STATUS = { state: "running", label: "Running…" };

/**
 * @param {object} data  the /api/execute JSON body
 * @param {boolean} ok   the HTTP response's `res.ok`
 * @returns {{state: 'ok'|'error'|'compile', label: string}}
 */
export function runStatusOf(data, ok = true) {
  // A rejected workspace (bad filename, too many files) never reached Judge0 at
  // all, so it is not a program result and must not read as one.
  if (!ok || (data && data.error && !data.status)) {
    return { state: "error", label: "Run rejected" };
  }

  const statusText = typeof data?.status === "string" ? data.status : "Finished";
  const exitCode = data?.exitCode;

  // Judge0 reports this as its own status ("Compilation Error"); it is the most
  // common outcome a student needs to recognise instantly, so it is named
  // rather than folded into a generic failure.
  if (/compil/i.test(statusText)) {
    return { state: "compile", label: "Compilation error" };
  }

  if (statusText === "Accepted") {
    return {
      state: "ok",
      label: `Exited (${typeof exitCode === "number" ? exitCode : 0})`,
    };
  }

  return {
    state: "error",
    label:
      typeof exitCode === "number" ? `${statusText} — exited (${exitCode})` : statusText,
  };
}
