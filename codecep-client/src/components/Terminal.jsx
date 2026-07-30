import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

// ── Execution console (Session 21) ───────────────────────────────────────────
// Replaces the old fake tabbed VS-Code terminal, which showed telemetry flush
// traces to the student. This console shows EXECUTION OUTPUT ONLY — program
// stdout/stderr, compiler messages, and the run status. No telemetry, no
// socket traces, no debug lines are ever piped here.
//
// Input model is BATCH stdin, matching Judge0's submission model: the student
// types every input the program will read, in order, and they are sent with the
// run. See CLAUDE.md §7 for why a reactive live TTY is out of scope.

// ANSI colors — the console speaks the same severity language as the rest of
// the app (red = error, yellow = compiler, dim grey = meta).
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

const KIND_COLOR = {
  cmd: ANSI.cyan,
  stdout: "",
  stderr: ANSI.red,
  compile: ANSI.yellow,
  ok: ANSI.green,
  meta: ANSI.dim,
};

const XTERM_THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#0d1117", // input is disabled — no blinking cursor to mislead
  selectionBackground: "#30363d",
  black: "#0d1117",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#388bfd",
  cyan: "#58a6ff",
  white: "#e6edf3",
  brightBlack: "#6e7681",
};

export default function Terminal({
  events = [],
  stdin = "",
  onStdinChange,
  onClear,
  running = false,
  disabled = false,
}) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const writtenRef = useRef(0);

  // Create the xterm instance once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      convertEol: true,           // program output uses "\n"
      disableStdin: true,         // batch input model — not a live TTY
      cursorBlink: false,
      fontFamily: '"Cascadia Code", ui-monospace, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 2000,
      theme: XTERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* host not laid out yet — the next resize will fit */
      }
    };
    // The pane is inside a flex/split layout; wait a frame for its real size.
    const raf = requestAnimationFrame(doFit);
    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    term.writeln(`${ANSI.dim}CoDecep console — program output only.${ANSI.reset}`);
    term.writeln(
      `${ANSI.dim}Enter your program's inputs on the right, then press Run Code.${ANSI.reset}`
    );

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  // Append any events the terminal hasn't written yet. A shorter array means
  // the parent cleared (clear-on-run) → reset and replay.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (events.length < writtenRef.current) {
      term.clear();
      term.reset();
      writtenRef.current = 0;
    }

    for (let i = writtenRef.current; i < events.length; i++) {
      const { kind = "stdout", text = "" } = events[i];
      const color = KIND_COLOR[kind] ?? "";
      // Normalize CRLF so Windows-built Judge0 output doesn't double-space.
      const lines = String(text).replace(/\r\n/g, "\n").split("\n");
      for (const line of lines) {
        term.writeln(color ? `${color}${line}${ANSI.reset}` : line);
      }
    }
    writtenRef.current = events.length;
    term.scrollToBottom();
  }, [events]);

  return (
    <div className="console-pane">
      <div className="console-bar">
        <span className="console-title">Console</span>
        <span className={`console-run-status ${running ? "is-running" : ""}`}>
          {running ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Running…
            </>
          ) : (
            "Idle"
          )}
        </span>
        <button className="console-clear" onClick={onClear} disabled={running}>
          Clear
        </button>
      </div>

      <div className="console-body">
        <div className="console-xterm" ref={hostRef} />

        <div className="console-stdin">
          <label className="console-stdin-label" htmlFor="stdin-box">
            Program input (stdin)
            <span
              className="console-hint"
              title="Enter all inputs your program will read, in order — one per line. Inputs are provided before the program runs (batch execution)."
            >
              ⓘ
            </span>
          </label>
          <textarea
            id="stdin-box"
            className="console-stdin-box"
            value={stdin}
            onChange={(e) => onStdinChange?.(e.target.value)}
            disabled={disabled}
            spellCheck={false}
            placeholder={"5\n7"}
          />
          <p className="console-stdin-note">
            One input per line, in the order your program reads them.
          </p>
        </div>
      </div>
    </div>
  );
}
