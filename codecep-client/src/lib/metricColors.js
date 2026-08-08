// Shared severity color scale for forensic metrics (Session 17).
//
// Framing rules (Constraint 7): RED always means "flagged for review" — a
// strong probabilistic signal a human instructor judges. Never "cheating".
// Color is ALWAYS paired with a text label — never color-only meaning.

// Configurable DEFAULT, not an empirical law: how many compile-runs reads as
// normal iteration. The instructor judges against task complexity — a trivial
// task may legitimately compile once. Documented as guidance in the UI.
export const RUNCOUNT_OK_DEFAULT = 2;

// The five severity levels, as CSS custom properties rather than literals (UI
// polish part 2). Every consumer spends these in an inline `style`, where a
// var() resolves exactly as it would in a stylesheet — so the severity scale
// follows the active theme without a single component learning that themes
// exist, and there is still ONE scale. The values live in theme.css; the
// quarantine theme maps red → Rusted Shiv and green → Clicker Sense, keeping
// each level's MEANING (red is "flagged for review", never "cheating") while
// changing its hue. Contrast on both themes' surfaces is held at or above the
// default theme's, and every pill still carries its text label.
export const LEVEL_COLORS = {
  red: "var(--sev-red)",
  yellow: "var(--sev-yellow)",
  green: "var(--sev-green)",
  darkgreen: "var(--sev-darkgreen)",
  grey: "var(--sev-grey)",
};

// Metric C — Robotic Variance. LOWER CV = more suspicious (too regular).
export function metricCSeverity(cv) {
  if (cv === null || cv === undefined) {
    return { level: "grey", label: "CV — insufficient data" };
  }
  if (cv < 0.15) {
    return { level: "red", label: `CV ${cv.toFixed(2)} — robotic rhythm (flagged for review)` };
  }
  if (cv < 0.4) {
    return { level: "yellow", label: `CV ${cv.toFixed(2)} — borderline` };
  }
  return { level: "green", label: `CV ${cv.toFixed(2)} — human-like variance` };
}

// Metric A — Trial-and-Error. FEWER runs = more suspicious. The threshold is
// a configurable default (RUNCOUNT_OK_DEFAULT), presented as guidance only.
export function metricASeverity(runCount) {
  if (runCount === null || runCount === undefined) {
    return { level: "grey", label: "runs — unknown" };
  }
  if (runCount <= 1) {
    return {
      level: "red",
      label: `${runCount} run${runCount === 1 ? "" : "s"} — flagged for review (default threshold)`,
    };
  }
  if (runCount === RUNCOUNT_OK_DEFAULT) {
    return { level: "green", label: `${runCount} runs — normal iteration` };
  }
  return { level: "darkgreen", label: `${runCount} runs — normal iteration` };
}

// Metric B — Linear Injection. Boolean flag from the worker.
export function metricBSeverity(flag) {
  if (flag === null || flag === undefined) {
    return { level: "grey", label: "insufficient data" };
  }
  return flag
    ? { level: "red", label: "linear injection — flagged for review" }
    : { level: "green", label: "no flag" };
}

// "Inconclusive" (Session 22) — the worker tags Metric B or C when its
// too-little-data guard tripped on a session that still submitted a full
// program. Rendering that as a green "no flag" would undo the whole point of
// the tag: not assessable is NOT the same as clean.
export function inconclusiveSeverity() {
  return { level: "grey", label: "not assessable — see authorship" };
}

// Merged review signal (Prompt 2) — the session-level metrics are computed over
// ALL events, so on a multi-task exam they are an AVERAGE: one fully-pasted
// task beside two hand-typed ones can read as a clean session. The review
// signal is therefore ANY task flagged, never the average, and a flagged
// session must never render green just because the average looks fine.
// `flag: null` = the session was processed before merged review existed → grey
// "not assessed", which is not the same as a pass.
export function mergedSeverity(flag, flaggedTaskCount, taskCount) {
  if (flag === null || flag === undefined) {
    return { level: "grey", label: "merged review — not assessed" };
  }
  if (!flag) {
    return {
      level: "green",
      label:
        taskCount > 1
          ? `no task flagged (${taskCount} tasks)`
          : "no flags for review",
    };
  }
  const n = flaggedTaskCount ?? 0;
  return {
    level: "red",
    label:
      n > 0 && taskCount > 1
        ? `${n} of ${taskCount} task(s) flagged for review`
        : "flagged for review",
  };
}

// The submit-time all-files construct sweep, as a severity. Same rule as every
// other pill: red reads "flagged for review", never an accusation.
export function astAuditSeverity(flag, violationCount) {
  if (flag === null || flag === undefined) {
    return { level: "grey", label: "constructs — not checked" };
  }
  return flag
    ? {
        level: "red",
        label: `${violationCount ?? 0} disallowed construct(s) — flagged for review`,
      }
    : { level: "green", label: "constructs allowed" };
}

// ── Authorship, and why the DISPLAYED percentage is capped at 100% ──────────
//
// `typedRatio` is typed characters over final program length, so it can exceed
// 1.0 honestly: auto-closed brackets and quotes insert characters the student
// then overtypes, and re-typing or heavily editing a section authors more
// characters than survive into the submitted file (gap #25/#26 — measured 1.02
// on a genuinely hand-typed control session). "103% typed" is arithmetically
// right and reads as a bug, so the DISPLAY is clamped to 100%.
//
// Only the display. The stored value is untouched and the flag math is
// untouched — a ratio over 1.0 still means "definitely authored" and still does
// not flag, because the metric only ever flags a ratio that is too LOW. The
// clamp can therefore never turn a flag into a pass or the reverse.
export const TYPED_RATIO_DISPLAY_MAX = 1;

/** The percentage to SHOW: clamped to 0–100. Null when there is no number. */
export function typedRatioPercent(typedRatio) {
  if (typeof typedRatio !== "number" || !Number.isFinite(typedRatio)) return null;
  return Math.round(Math.min(TYPED_RATIO_DISPLAY_MAX, Math.max(0, typedRatio)) * 100);
}

/** "87% typed" — the one formatter every surface uses, so none can drift. */
export function formatTypedRatio(typedRatio) {
  const pct = typedRatioPercent(typedRatio);
  return pct === null ? null : `${pct}% typed`;
}

/** Was the shown number actually capped? Drives the tooltip's explanation. */
export function isTypedRatioClamped(typedRatio) {
  return (
    typeof typedRatio === "number" &&
    Number.isFinite(typedRatio) &&
    typedRatio > TYPED_RATIO_DISPLAY_MAX
  );
}

// Authorship (Session 22) — how much of the submitted program can be accounted
// for by typing. LOWER typed share = more suspicious. `typedRatio` is optional
// context; the flag is what the worker decided (MIN_CODE_LEN / TYPED_MIN are
// tunable defaults, not empirical law — same status as RUNCOUNT_OK_DEFAULT).
export function authorshipSeverity(flag, typedRatio) {
  const pct = formatTypedRatio(typedRatio);
  // Shown capped, explained in the tooltip rather than silently rounded away:
  // an instructor who wonders why it says exactly 100% gets the reason.
  const clampNote = isTypedRatioClamped(typedRatio)
    ? " (capped at 100% — more characters were typed than survive in the final" +
      " program, from re-typing and edits)"
    : "";
  if (flag === null || flag === undefined) {
    return { level: "grey", label: pct ? `${pct}${clampNote}` : "authorship — insufficient data" };
  }
  return flag
    ? {
        level: "red",
        label: pct
          ? `${pct} — mostly pasted (flagged for review)`
          : "mostly pasted — flagged for review",
      }
    : { level: "green", label: pct ? `${pct} — no flag${clampNote}` : "no flag" };
}
