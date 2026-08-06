// ── DVR scrubber checkpoints (gap-fix session, Fix 3) ───────────────────────
//
// PURE module (no React/DOM) — the tick placement is the part with real logic
// and edge cases, so it lives where it can be unit-tested.
//
// The scrubber already marked PASTE moments. Tab-outs and AST violations were
// recorded (Session 22 part 2, `sessions.tier1_log`) and reported as COUNTS,
// but there was no way to get to the moment one happened: an instructor reading
// "Tab-outs: 3" had to scrub the whole session hunting for them. These ticks
// turn each recorded Tier-1 event into a click target on the timeline.
//
// This is a RENDERING addition. No new capture, no new alerts, nothing
// persisted — every tick comes from data the replay payload already carried.

import { nodeTypeFromDetail } from "./astReport";

/**
 * The three checkpoint kinds, their visual treatment and their legend text.
 *
 * `persistent: true` is the tab-out rule: a tab-out means the student left the
 * exam screen, and unlike a paste (which is visible in the code itself) it
 * leaves no trace anywhere else in the replay. It therefore stays fully
 * saturated across the whole timeline rather than fading with distance from the
 * playhead — and because a permanently prominent marker can also get in the
 * way, it is the one kind with a show/hide toggle.
 *
 * Every kind pairs a color with a LABEL, in the legend and in each tick's
 * tooltip. Color is never the only carrier of meaning.
 */
export const TICK_KINDS = {
  paste: {
    key: "paste",
    label: "Paste",
    legend: "Paste (external / internal)",
    persistent: false,
    toggleable: false,
  },
  ast: {
    key: "ast",
    label: "Construct not permitted",
    legend: "Construct not permitted for this week",
    persistent: false,
    toggleable: false,
  },
  tabout: {
    key: "tabout",
    label: "Tab-out",
    legend: "Tab-out (left the exam screen)",
    persistent: true,
    toggleable: true,
  },
};

/** Tier-1 alert types that become ticks, mapped to their tick kind. */
const TIER1_TICK_KIND = {
  TAB_OUT: "tabout",
  AST_VIOLATION: "ast",
  // ILLEGAL_PASTE is deliberately absent: pastes are already ticked from the
  // replay's own `pasteMarks`, which carry the character count and the
  // provenance. Adding the alert too would double-mark the same moment.
};

function clockOf(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Build every scrubber tick for one replay.
 *
 * @param {object}   opts
 * @param {Array}    opts.pasteMarks      `replay.pasteMarks` — already relative ms.
 * @param {Array?}   opts.tier1Events     Raw `[{type, timestamp, detail}]` from the
 *                                        replay payload. NULL means the session
 *                                        predates the Tier-1 record — which is
 *                                        NOT the same as "nothing happened", so
 *                                        callers must say "not recorded" rather
 *                                        than draw an empty timeline.
 * @param {number}   opts.startTime       `replay.startTime` — the timeline origin as
 *                                        absolute epoch ms. Tier-1 timestamps are
 *                                        absolute; paste marks are already relative.
 * @param {number}   opts.totalDurationMs Timeline length.
 * @returns {Array} ticks sorted by time, each `{ kind, t, pct, label, title, persistent }`.
 */
export function buildTickMarks({
  pasteMarks = [],
  tier1Events = null,
  startTime = 0,
  totalDurationMs = 0,
}) {
  const ticks = [];
  const duration = Number(totalDurationMs) > 0 ? Number(totalDurationMs) : 0;
  // A zero-length timeline has nowhere to put a tick; percentages would divide
  // by zero and every marker would stack at the same point anyway.
  if (duration <= 0) return ticks;

  const clamp = (t) => Math.max(0, Math.min(duration, t));

  for (const m of Array.isArray(pasteMarks) ? pasteMarks : []) {
    if (!m || !Number.isFinite(Number(m.t))) continue;
    const t = clamp(Number(m.t));
    const provenance = m.provenance ?? null;
    ticks.push({
      kind: "paste",
      variant: provenance === "internal" ? "internal" : "external",
      t,
      pct: (t / duration) * 100,
      fileName: m.fileName ?? null,
      label: TICK_KINDS.paste.label,
      persistent: false,
      title:
        `Paste +${m.charCount ?? "?"} chars at ${clockOf(t)}` +
        (provenance ? ` (${provenance})` : "") +
        " — click to jump",
    });
  }

  for (const e of Array.isArray(tier1Events) ? tier1Events : []) {
    const kind = TIER1_TICK_KIND[e?.type];
    if (!kind) continue;
    const ts = Number(e.timestamp);
    if (!Number.isFinite(ts)) continue;
    // Tier-1 timestamps are absolute; the timeline origin is when the exam was
    // OPENED. An alert fired before the first keystroke is genuinely at the
    // start of the timeline, and one fired after the last keystroke is at its
    // end, so both clamp rather than being dropped — a tab-out that happened is
    // not something to hide because it fell outside the keystroke window.
    const t = clamp(ts - Number(startTime || 0));
    const parsed = kind === "ast" ? nodeTypeFromDetail(e.detail) : null;
    ticks.push({
      kind,
      variant: kind,
      t,
      pct: (t / duration) * 100,
      fileName: null,
      label: TICK_KINDS[kind].label,
      persistent: TICK_KINDS[kind].persistent,
      nodeType: parsed?.nodeType ?? null,
      title:
        kind === "tabout"
          ? `Tab-out at ${clockOf(t)} — the student left the exam screen — click to jump`
          : `Construct not permitted for this week at ${clockOf(t)}: ` +
            `${parsed?.nodeType ?? e.detail ?? "construct not recorded"} — click to jump`,
    });
  }

  return ticks.sort((a, b) => a.t - b.t);
}

/**
 * Which kinds actually occur in a tick list — drives the legend, so it only
 * ever offers controls for markers the instructor can actually see.
 */
export function tickKindsPresent(ticks) {
  const present = new Set((Array.isArray(ticks) ? ticks : []).map((t) => t.kind));
  return Object.values(TICK_KINDS).filter((k) => present.has(k.key));
}
