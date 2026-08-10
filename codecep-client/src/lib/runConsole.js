// ── Execution response → console lines ──────────────────────────────────────
//
// PURE module — no React, no DOM, no fetch. Turns an execution response (the
// student's /api/execute, or the instructor's /api/sessions/:id/run, which
// returns the SAME shape because it is the same Judge0 path) into the ordered
// `{ kind, text }` events the Terminal renders.
//
// Why it is shared rather than copied: the instructor now reads a run's output
// on a different screen than the student does, and two copies of "was that a
// compile error, and does stderr come before or after stdout?" would drift into
// two different accounts of the same run. Same discipline as lib/runStatus.js,
// which derives the one-line verdict from this same response — and as
// lib/metricLabels.js for wording.
//
// Nothing here executes anything or changes execution: /api/execute, the Judge0
// batch model, `runCount` and the forensics are untouched (CLAUDE.md §7.4).

/**
 * Where a caller's UI puts the files a program wrote. The student has a file
 * panel to open them in; the instructor's review console does not, and telling
 * them to look in a panel that isn't there would be worse than saying nothing.
 */
export const STUDENT_FILES_HINT = ' — open under "Program output" in the file panel';

/**
 * The lines a console shows for a finished run, in order.
 *
 * @param {object} data  the execution JSON body
 * @param {boolean} ok   the HTTP response's `res.ok`
 * @param {{filesHint?: string}} [opts]  trailing note on the written-files line
 * @returns {{entries: {kind: string, text: string}[], outputFiles: object[]}}
 */
export function runResultEvents(data, ok = true, opts = {}) {
  const { filesHint = STUDENT_FILES_HINT } = opts;
  // A rejected workspace (bad name, too many files) never reached Judge0 — it
  // comes back as a plain error, and must be surfaced as one instead of
  // falling through to "(no output)", which would read like a program that ran
  // and printed nothing.
  if (!ok && data?.error) {
    return {
      entries: [
        { kind: "stderr", text: String(data.error) },
        { kind: "prompt", text: "$" },
      ],
      outputFiles: [],
    };
  }

  const entries = [];
  if (data?.compileOutput) {
    entries.push({ kind: "compile", text: data.compileOutput.trimEnd() });
  }
  if (data?.stdout) {
    entries.push({ kind: "stdout", text: data.stdout.replace(/\n$/, "") });
  }
  if (data?.stderr) {
    entries.push({ kind: "stderr", text: data.stderr.trimEnd() });
  }
  if (data?.message) {
    entries.push({ kind: "stderr", text: data.message.trimEnd() });
  }
  // Older/error shapes only carry `output`.
  if (entries.length === 0 && data?.output) {
    entries.push({ kind: "stdout", text: String(data.output).trimEnd() });
  }
  if (entries.length === 0) {
    entries.push({ kind: "meta", text: "(no output)" });
  }

  const statusText = data?.status ?? "Finished";
  const meta = [
    data?.exitCode !== null && data?.exitCode !== undefined ? `exit ${data.exitCode}` : null,
    data?.time ? `${data.time}s` : null,
    data?.memory ? `${data.memory} KB` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  entries.push({
    kind: statusText === "Accepted" ? "ok" : "stderr",
    text: `— ${statusText}${meta ? ` (${meta})` : ""}`,
  });

  // Files the program wrote. Their CONTENT goes to the file panel, not the
  // console — dumping a data file into the terminal buries the program's own
  // output. The console just says what was captured and where it went.
  const outputFiles = Array.isArray(data?.outputFiles) ? data.outputFiles : [];
  if (outputFiles.length > 0) {
    entries.push({
      kind: "meta",
      text:
        `[files] wrote ${outputFiles.map((f) => `${f.name} (${f.bytes}B)`).join(", ")}` +
        filesHint,
    });
    for (const file of outputFiles.filter((f) => f.truncated)) {
      entries.push({
        kind: "meta",
        text: `[files] ${file.name} is larger than the 64 KB preview limit — showing the first 64 KB`,
      });
    }
  }

  // A resting prompt after the run, so the console reads as a real console
  // session rather than a log that just stops.
  entries.push({ kind: "prompt", text: "$" });
  return { entries, outputFiles };
}

/** The console lines for a run that never reached the server at all. */
export function runNetworkErrorEvents(message) {
  return [
    { kind: "stderr", text: `Network error — ${message}` },
    { kind: "prompt", text: "$" },
  ];
}
