// Shared severity color scale for forensic metrics (Session 17).
//
// Framing rules (Constraint 7): RED always means "flagged for review" — a
// strong probabilistic signal a human instructor judges. Never "cheating".
// Color is ALWAYS paired with a text label — never color-only meaning.

// Configurable DEFAULT, not an empirical law: how many compile-runs reads as
// normal iteration. The instructor judges against task complexity — a trivial
// task may legitimately compile once. Documented as guidance in the UI.
export const RUNCOUNT_OK_DEFAULT = 2;

export const LEVEL_COLORS = {
  red: "#f85149",
  yellow: "#d29922",
  green: "#3fb950",
  darkgreen: "#2ea043",
  grey: "#6e7681",
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

// Authorship (Session 22) — how much of the submitted program can be accounted
// for by typing. LOWER typed share = more suspicious. `typedRatio` is optional
// context; the flag is what the worker decided (MIN_CODE_LEN / TYPED_MIN are
// tunable defaults, not empirical law — same status as RUNCOUNT_OK_DEFAULT).
export function authorshipSeverity(flag, typedRatio) {
  const pct =
    typeof typedRatio === "number" && Number.isFinite(typedRatio)
      ? `${Math.round(typedRatio * 100)}% typed`
      : null;
  if (flag === null || flag === undefined) {
    return { level: "grey", label: pct ?? "authorship — insufficient data" };
  }
  return flag
    ? {
        level: "red",
        label: pct
          ? `${pct} — mostly pasted (flagged for review)`
          : "mostly pasted — flagged for review",
      }
    : { level: "green", label: pct ? `${pct} — no flag` : "no flag" };
}
