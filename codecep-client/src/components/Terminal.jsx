import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { IDLE_STATUS, RUNNING_STATUS } from "../lib/runStatus";
import { useTheme } from "../context/ThemeContext";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

// ── Execution console (Session 21, upgraded in UI polish part 1) ─────────────
// Replaces the old fake tabbed VS-Code terminal, which showed telemetry flush
// traces to the student. This console shows EXECUTION OUTPUT ONLY — program
// stdout/stderr, compiler messages, and the run status. No telemetry, no
// socket traces, no debug lines are ever piped here.
//
// UI polish part 1 makes it a first-class console rather than a cramped strip:
// a real header with a run-status line, a generous default height that the
// student can DRAG (the divider lives in App.jsx, which owns the split) or
// MAXIMIZE to fill the workspace, and console-grade type and padding. All of
// that is PRESENTATION. The input model is unchanged and still BATCH stdin,
// matching Judge0's submission model: the student types every input the program
// will read, in order, and they are sent with the run. See CLAUDE.md §7.4 for
// why a reactive live TTY is out of scope — the hint below says so plainly
// rather than implying an interactivity that does not exist.

// ANSI colors — the console speaks the same severity language as the rest of
// the app (red = error, yellow = compiler, dim grey = meta).
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const KIND_COLOR = {
  cmd: ANSI.cyan,
  stdout: "",
  stderr: ANSI.red,
  compile: ANSI.yellow,
  ok: ANSI.green,
  meta: ANSI.dim,
  prompt: ANSI.dim,
};

export default function Terminal({
  events = [],
  stdin = "",
  onStdinChange,
  onClear,
  running = false,
  disabled = false,
  // How the last run ended, from lib/runStatus.js. Null before anything has
  // been run in this task's console.
  runStatus = null,
  // Fill the workspace. Owned by App (it also hides the editor row), so the
  // console and the layout can never disagree about which state they are in.
  maximized = false,
  onToggleMaximize,
}) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const writtenRef = useRef(0);

  // xterm paints to a canvas and cannot read a CSS variable, so its palette is
  // handed over as literals from lib/themes.js (UI polish part 2).
  //
  // The create-once effect below needs the palette current AT MOUNT, and must
  // NOT take the theme as a dependency — that would tear the terminal down and
  // rebuild it on a colour change, losing the scrollback of the run the student
  // is reading. A ref seeded from the first render gives it that value; every
  // LATER change is applied in place by the repaint effect further down.
  const { theme } = useTheme();
  const mountThemeRef = useRef(theme.xterm);

  // Create the xterm instance once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      convertEol: true,           // program output uses "\n"
      disableStdin: true,         // batch input model — not a live TTY
      cursorBlink: false,
      fontFamily: '"Cascadia Code", ui-monospace, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.35,
      // A long-running loop can print a lot; 5000 lines of scrollback is what
      // makes "scroll back through the run" a real answer rather than advice.
      scrollback: 5000,
      theme: mountThemeRef.current,
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
    // The pane is inside a flex/split layout and can be dragged or maximized at
    // any time, so the ResizeObserver is what keeps the columns/rows correct at
    // every size — not just at mount.
    const raf = requestAnimationFrame(doFit);
    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    // Kept to one line. The banner a student sees at the start of an exam
    // should tell them what this pane is, not explain the execution
    // architecture to them — the stdin box already says what to put where, and
    // the honest note about the batch model belongs in the docs (CLAUDE.md
    // §7.4), not in front of someone with a timer running.
    term.writeln(`${ANSI.cyan}${ANSI.bold}CoDecep terminal${ANSI.reset}${ANSI.dim} — program output only.${ANSI.reset}`);
    term.writeln(`${ANSI.dim}$${ANSI.reset}`);

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

  // Repaint on a theme change. xterm re-renders in place when its theme option
  // is reassigned, so the terminal keeps its instance, its scrollback and every
  // line already written — a colour change must not cost a student the output
  // of the run they are reading.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = theme.xterm;
  }, [theme]);

  // Re-fit whenever the pane's mode changes: maximizing swaps the pane's height
  // in one frame, and xterm sizes its grid in columns/rows, not pixels.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* laid out on the next resize */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [maximized]);

  const status = running ? RUNNING_STATUS : runStatus ?? IDLE_STATUS;

  return (
    <div className={`console-pane ${maximized ? "maximized" : ""}`}>
      <div className="console-bar">
        <span className="console-title">Terminal</span>
        <span className="console-tag" title="Program output and compiler messages for this task.">
          output
        </span>

        {/* The run-status line: how the LAST run ended, in words. Colour is
            emphasis only — the label is the meaning. */}
        <span className={`console-run-status ${status.state}`}>
          {running && <span className="spinner" aria-hidden="true" />}
          {status.label}
        </span>

        <button
          className="console-btn"
          onClick={onClear}
          disabled={running}
          title="Clear the console. Each run also clears it, so repeated runs stay readable."
        >
          Clear
        </button>
        <button
          className="console-btn"
          onClick={onToggleMaximize}
          title={maximized ? "Restore the editor" : "Expand the terminal to fill the workspace"}
          aria-pressed={maximized}
        >
          {maximized ? "⤡ Restore" : "⤢ Maximize"}
        </button>
      </div>

      <div className="console-body">
        <div className="console-output">
          <div className="console-xterm" ref={hostRef} />
        </div>

        <div className="console-stdin">
          <label className="console-stdin-label" htmlFor="stdin-box">
            Program input (stdin)
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
          {/* The SHORT form of the honest framing (CLAUDE.md §7.4). "Sent with
              the run" still tells a student the input goes in before they press
              Run — which is the only part of the batch model that changes what
              they do — without explaining the execution architecture to someone
              sitting a timed exam. The full note stays in the docs. */}
          <p className="console-stdin-note">
            One input per line, in the order your program reads them — sent with the run.
          </p>
        </div>
      </div>
    </div>
  );
}
