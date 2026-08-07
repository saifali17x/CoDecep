import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Editor from "@monaco-editor/react";
import socket from "../socket";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { debugLog } from "../debug";
import { buildReplay, replayDataForTask, taskIdsInReplay } from "../lib/replayEngine";
import { stitchLive, recordedThrough } from "../lib/liveStitch";
import { describeViolationList } from "../lib/astReport";
import { buildTickMarks, tickKindsPresent } from "../lib/scrubberMarks";
import { languageOf, taskLabel } from "../lib/workspace";
import TaskReport, { MergedFlagPill } from "./TaskReport";
import MetricReviewControl from "./MetricReviewControl";
import MetricGlossary from "./MetricGlossary";
import { BEHAVIORAL_METRICS, judgmentIndex, judgmentKey } from "../lib/metricReviewMeta";
import {
  METRIC_INFO,
  TIER1_INFO,
  describeMetric,
  describeTier1,
  metricInfo,
} from "../lib/metricLabels";
import {
  metricASeverity,
  metricBSeverity,
  metricCSeverity,
  authorshipSeverity,
  inconclusiveSeverity,
  LEVEL_COLORS,
} from "../lib/metricColors";
import "./DvrPlayer.css";

// Session 19 — keystroke-level DVR replay. The instructor WATCHES the code
// get written: play/pause, speed, skip-idle, scrubbing, and a visible flash
// when a pasted block appears at once. Reconstruction is snapshot-anchored
// (see lib/replayEngine.js) — timing and paste moments are exact; character
// order within a typed burst is approximated. Display-only: the editor is
// read-only and paste highlights use Monaco decorations, never content edits.

// The four behavioral metrics, in the order the report shows them. Their
// NAMES and descriptions come from lib/metricLabels.js — the one place the
// wording lives, so this view and the session table cannot describe the same
// number two different ways.
const METRIC_ORDER = ["metricA", "metricB", "metricC", "authorship"];
const SPEEDS = [1, 2, 5, 10, 25];
const PASTE_FLASH_MS = 1200;

// Session 24 — the replay says which kind it is, because the two are not
// equally strong evidence and the instructor should know which they're seeing.
const FIDELITY_HINT = {
  exact: "Reconstructed character-for-character from the recorded edits, and verified against every 30s snapshot.",
  approx:
    "This session predates exact keystroke capture (or its snapshots disagreed with the recorded edits). Timing and paste moments are exact; character order within a typed burst is approximated.",
};

function MetricPill({ metricKey, metric, review = null }) {
  const sev = metric?.inconclusive
    ? // B/C whose guard tripped on a substantial program: grey, never green.
      inconclusiveSeverity()
    : metricKey === "metricA"
      ? // Prompt 2: a per-task Metric A carries `scope`. 'session' means the
        // count is the whole session's (this session predates per-task run
        // tracking), so it is shown grey rather than coloured as though it had
        // been measured for this task.
        metric?.scope === "session"
        ? {
            level: "grey",
            label: `${metric?.runCount ?? "—"} run(s) recorded for the whole session, not per task`,
          }
        : metricASeverity(metric?.runCount)
      : metricKey === "metricC"
        ? metricCSeverity(metric?.stats?.cv ?? null)
        : metricKey === "authorship"
          ? authorshipSeverity(metric?.flag, metric?.stats?.typedRatio ?? null)
          : metricBSeverity(metric?.flag);
  const color = LEVEL_COLORS[sev.level];
  const info = metricInfo(metricKey);
  // The DVR has vertical room, so the description is INLINE here rather than
  // hidden behind a tooltip: this is the screen where an instructor decides
  // what a flag means, and "Metric B: flagged" told them nothing about what B
  // examined. The technical name stays underneath for the report and defense.
  return (
    <span
      className="dvr-metric"
      style={{ borderColor: color }}
      title={describeMetric(metricKey, metric?.reason ?? sev.label)}
    >
      <span className="dvr-metric-head">
        <span className="dvr-metric-name">{info?.plain ?? metricKey}</span>
        <span className="dvr-metric-verdict" style={{ color }}>
          {sev.label}
        </span>
        {review}
      </span>
      <span className="dvr-metric-desc">{info?.desc}</span>
      <span className="dvr-metric-tech mono">{info?.tech}</span>
    </span>
  );
}

// Counts, colored by whether anything fired — never a verdict on its own.
// `recorded: false` = the session predates the Tier-1 record, so tab-outs and
// AST violations are UNKNOWN and must read "not recorded", never "0".
function Tier1Row({ summary }) {
  if (!summary) return null;
  return (
    <div className="dvr-tier1">
      <span className="dvr-tier1-title">What happened live during the exam:</span>
      {Object.entries(TIER1_INFO).map(([key, info]) => {
        const n = summary[key];
        const unknown = n === null || n === undefined;
        const color = unknown
          ? LEVEL_COLORS.grey
          : n > 0
            ? LEVEL_COLORS.red
            : LEVEL_COLORS.green;
        return (
          <span
            key={key}
            className="dvr-pill"
            style={{ color, borderColor: color }}
            title={describeTier1(
              key,
              unknown
                ? "not recorded — this session predates per-session Tier-1 logging"
                : n > 0
                  ? `${n} recorded — flagged for review`
                  : "none recorded",
            )}
          >
            {info.plain}: {unknown ? "not recorded" : n}
          </span>
        );
      })}
      {!summary.recorded && (
        <span className="dvr-severity-note">
          Tier-1 alerts were not recorded for this session — external pastes are
          reconstructed from the keystroke log; tab-outs and AST violations are
          unknown, not zero.
        </span>
      )}
    </div>
  );
}

// Session 24 (Change B2) — the submit-time sweep over EVERY code file. Live
// validation only ever saw the active buffer, so this is what closes the
// "hide it in an unfocused file" gap. Absent on sessions submitted before v2,
// which must read as "not checked", never as "clean".
function AstAuditRow({ audit }) {
  if (!audit) return null;
  const { violations = [], checkedFiles = [], flag } = audit;
  const color = flag ? LEVEL_COLORS.red : LEVEL_COLORS.green;
  const byFile = violations.reduce((acc, v) => {
    (acc[v.fileName] ??= []).push(v);
    return acc;
  }, {});
  return (
    <div className="dvr-tier1">
      <span className="dvr-tier1-title" title={METRIC_INFO.astAudit.desc}>
        {METRIC_INFO.astAudit.plain} — every file checked at submit:
      </span>
      <span
        className="dvr-pill"
        style={{ color, borderColor: color }}
        title={
          (checkedFiles.length === 0
            ? "No code files were present to check."
            : `Checked ${checkedFiles.join(", ")} against the ${audit.allowlistSource} allowlist.`) +
          `\n\n${METRIC_INFO.astAudit.desc}\n${METRIC_INFO.astAudit.tech}`
        }
      >
        {checkedFiles.length === 0
          ? "no code files"
          : flag
            ? `${violations.length} disallowed construct(s) — flagged for review`
            : `${checkedFiles.length} file(s) clean`}
      </span>
      {/* Fix 2 — WHICH construct and WHERE, per file. A count is not something
          an instructor can check; "for_statement (line 12)" is. Findings are
          de-duplicated by construct+line (one loop reported repeatedly is one
          finding) and capped, with the remainder counted rather than dropped
          silently. */}
      {Object.entries(byFile).map(([file, vs]) => (
        <span
          key={file}
          className="dvr-pill"
          style={{ color: LEVEL_COLORS.red, borderColor: LEVEL_COLORS.red }}
          title={`${file} — constructs not permitted for this week:\n${describeViolationList(
            vs,
            vs.length,
          )}\nThis is a signal for instructor review, not a verdict.`}
        >
          {file}: {describeViolationList(vs)}
        </span>
      ))}
      {flag && (
        <span className="dvr-severity-note">
          These constructs are not permitted for this assignment&apos;s week. That is a
          statement about what was written — judge it against the syllabus, not as
          proof of misconduct.
        </span>
      )}
    </div>
  );
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtWallClock(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

// ── Live mode status (Session 28) ────────────────────────────────────────────
// Every state says what the instructor is actually looking at. "Lost" and
// "syncing" in particular must never look like a working live view: showing a
// stale edge as if it were the present is the failure this whole feature exists
// to remove, and reintroducing it in the error path would be worse than not
// having it at all.
const LIVE_STATUS = {
  connecting: { dot: "◐", text: "connecting to live stream…", tone: "pending" },
  syncing: {
    dot: "◐",
    text: "syncing — waiting for the student's buffered keystrokes",
    tone: "pending",
  },
  following: { dot: "●", text: "LIVE", tone: "live" },
  ended: { dot: "■", text: "session submitted — showing the final recorded session", tone: "done" },
  lost: {
    dot: "○",
    text: "live connection lost — showing recorded data up to the last flush",
    tone: "error",
  },
  denied: { dot: "○", text: "live stream unavailable", tone: "error" },
};

export default function DvrPlayer({ sessionId, initialTaskId = null, live = false }) {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [t, setT] = useState(0); // playback position, ms relative to start
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [skipIdle, setSkipIdle] = useState(true);
  // Fix 3 — tab-out ticks are ON by default and stay fully prominent wherever
  // the playhead is. The toggle exists because a permanently loud marker can
  // also crowd the timeline, so hiding them is the INSTRUCTOR's decision rather
  // than something the player does on its own after a few seconds.
  const [showTabOuts, setShowTabOuts] = useState(true);

  // ── Live mode state ───────────────────────────────────────────────────────
  // `following` is what makes this a ghost-typer rather than a player: while it
  // is on, the view IS the present edge and moves as the student types. Any
  // scrub turns it off (the instructor has deliberately gone into the past) and
  // "Jump to live" turns it back on. Live events keep arriving and keep
  // extending the timeline either way — rewinding pauses the VIEW, never the
  // stream.
  const [following, setFollowing] = useState(live);
  const [liveEvents, setLiveEvents] = useState([]);
  // The instant the student confirmed their pre-watch buffer was drained.
  // Nothing live is applied before it — see lib/liveStitch.js for why a naive
  // stream would garble the document rather than merely leave a gap.
  const [syncedAt, setSyncedAt] = useState(null);
  const [liveStatus, setLiveStatus] = useState(live ? "connecting" : null);
  const [liveError, setLiveError] = useState(null);
  // Prompt 2 — WHICH task is being replayed. null = the whole session as one
  // timeline (the Prompt 1 behavior, and the only view a single-task session
  // ever shows).
  const [selectedTask, setSelectedTask] = useState(initialTaskId);
  // Feature 3 — THIS instructor's own accuracy judgments for this session, so
  // each optional control renders in the state it was left in. Keyed
  // "taskId::metric" ("" for a session-level judgment). Never blocks the
  // player: a failure here leaves the controls blank, which is a valid state.
  const [judgments, setJudgments] = useState({});

  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationsRef = useRef([]);

  // ── Load full replay data ─────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setT(0);
    setPlaying(false);
    apiFetch(`/api/session/${sessionId}/replay`, { token })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, token]);

  // Load this instructor's saved judgments alongside the replay. Separate
  // request on purpose: the replay payload is forensic evidence and one
  // instructor's calibration opinions are not part of it.
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    setJudgments({});
    apiFetch(`/api/sessions/${sessionId}/metric-reviews`, { token })
      .then((rows) => {
        if (!cancelled) setJudgments(judgmentIndex(rows));
      })
      .catch(() => {
        /* optional feature — never surface an error over the evidence */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, token]);

  const recordJudgment = useCallback((row) => {
    if (!row?.metric) return;
    setJudgments((prev) => ({ ...prev, [judgmentKey(row.taskId, row.metric)]: row.judgment }));
  }, []);

  // A SILENT refetch of the durable record, used whenever a flush lands during
  // a live watch. Deliberately does not touch `t`, `playing` or `following`:
  // the record growing underneath the instructor is bookkeeping, not a reason
  // to yank their playhead. Events retired into the record are then dropped
  // from the live tail by de-dup, so the seam closes without a visible seam.
  const reload = useCallback(() => {
    if (!sessionId) return;
    apiFetch(`/api/session/${sessionId}/replay`, { token })
      .then(setData)
      .catch((err) => debugLog("[LIVE] reconcile refetch failed:", err.message));
  }, [sessionId, token]);

  // ── Live subscription ─────────────────────────────────────────────────────
  // Only for a session that is actually still running: a SUBMITTED session has
  // nothing left to stream, and asking to watch one would leave a student's
  // room armed for no reason.
  const liveMode = live && data?.status === "IN_PROGRESS";

  useEffect(() => {
    if (!liveMode || !sessionId || !token) return undefined;

    const startWatching = () => {
      setLiveStatus("connecting");
      setLiveError(null);
      socket.emit("watch:start", { sessionId, token }, (res) => {
        if (res?.ok) {
          // Watching is granted, but the edge is NOT live yet — the student
          // still has to drain whatever they typed since the last flush.
          setLiveStatus((s) => (s === "ended" ? s : "syncing"));
        } else {
          setLiveStatus("denied");
          setLiveError(res?.error ?? "Could not start the live stream.");
        }
      });
    };

    const onSynced = (p) => {
      if (p?.sessionId !== sessionId) return;
      // The student's buffer is now in the database, so refetch to pick it up.
      // Only after this does anything live get applied.
      setSyncedAt(p.at);
      setLiveStatus((s) => (s === "ended" ? s : "following"));
      reload();
    };
    const onKeystroke = (p) => {
      if (p?.sessionId !== sessionId || !p?.event) return;
      setLiveEvents((prev) => [...prev, p.event]);
    };
    const onFlushed = (p) => {
      if (p?.sessionId !== sessionId) return;
      reload();
    };
    const onEnd = (p) => {
      if (p?.sessionId !== sessionId) return;
      // The student submitted. The Immune Phase already stopped their stream;
      // this is what turns that silence into an explicit, clean transition to
      // the final recorded session instead of an edge that just stops moving.
      setLiveStatus("ended");
      reload();
    };
    const onDisconnect = () => setLiveStatus("lost");
    const onReconnect = () => {
      // The room membership died with the socket, and the student re-syncs from
      // scratch. Drop the stale tail rather than risk applying it across
      // whatever was missed while disconnected.
      setSyncedAt(null);
      setLiveEvents([]);
      startWatching();
    };

    socket.on("live:synced", onSynced);
    socket.on("live:keystroke", onKeystroke);
    socket.on("live:flushed", onFlushed);
    socket.on("live:end", onEnd);
    socket.on("disconnect", onDisconnect);
    socket.on("connect", onReconnect);
    startWatching();

    return () => {
      socket.emit("watch:stop", { sessionId });
      socket.off("live:synced", onSynced);
      socket.off("live:keystroke", onKeystroke);
      socket.off("live:flushed", onFlushed);
      socket.off("live:end", onEnd);
      socket.off("disconnect", onDisconnect);
      socket.off("connect", onReconnect);
    };
  }, [liveMode, sessionId, token, reload]);

  // A caller can open the player straight on one task ("Replay this task" in a
  // per-task report). Adjusting state during render (React's documented
  // reset-on-prop-change pattern) rather than in an effect: the selection is
  // derived from what the caller asked for, so it must not lag a frame behind
  // it. Keyed on the session too, so switching student drops a Task 3 selection
  // instead of carrying it into a session that only has two tasks.
  const selectionKey = `${sessionId}:${initialTaskId ?? ""}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    setSelectedTask(initialTaskId ?? null);
    setT(0);
    setPlaying(false);
    // A different student is a different live stream: the tail and its sync
    // point belong to the session that produced them and must not survive the
    // switch, or the first frames of the new session would be reconstructed
    // over the previous one's events.
    setLiveEvents([]);
    setSyncedAt(null);
    setFollowing(live);
    setLiveStatus(live ? "connecting" : null);
    setLiveError(null);
  }

  // Session 22 (part 2): replay is anchored at an EMPTY document, matching the
  // real exam start. It used to anchor at the old starter template, which is
  // now wrong for every flow (Session 25 removed the template entirely) — and
  // anchoring at the first snapshot is what made a first-event paste invisible
  // (see lib/replayEngine.js).
  // Which tasks this session actually produced data for. A single-task session
  // (and every session recorded before multi-task exams) yields one id, and
  // everything task-shaped below then stays out of the way entirely.
  const taskIds = useMemo(() => (data ? taskIdsInReplay(data) : []), [data]);
  const isMultiTask = taskIds.length > 1 || (data?.taskCount ?? 1) > 1;

  // ── The stitch (Session 28) ───────────────────────────────────────────────
  // Recorded past + live present, as ONE payload in the shape buildReplay
  // already consumes. Everything difficult — de-duplicating an event that
  // arrives both live and in a later flush, and refusing to apply anything
  // before the sync point — happens inside `stitchLive`, which is pure and
  // unit-tested. Returns `data` untouched when there is no live tail, so a
  // recorded session takes byte-for-byte the path it always did.
  const stitched = useMemo(
    () => stitchLive(data, liveEvents, { syncedAt }),
    [data, liveEvents, syncedAt],
  );

  // Prompt 2 — per-task replay is the SAME engine run over a payload narrowed
  // to one task, so its reconstruction is still verified against that task's
  // own recorded snapshots rather than being a second, weaker code path. The
  // narrowing runs AFTER the stitch, so watching one task of a multi-task exam
  // live comes out of the same two pieces rather than a third code path.
  const replay = useMemo(
    () =>
      stitched
        ? buildReplay(selectedTask ? replayDataForTask(stitched, selectedTask) : stitched, {
            initialText: "",
          })
        : null,
    [stitched, selectedTask],
  );
  const duration = replay?.totalDurationMs ?? 0;

  // ── Where the playhead is ─────────────────────────────────────────────────
  // While following, the position IS the end of the timeline — derived, not
  // stored, so it can never lag behind an arriving keystroke by a render.
  // Scrubbing detaches it (see `seek`), and "Jump to live" re-attaches it.
  //
  // Deliberately keyed on `following` ALONE and not on `liveMode`. When the
  // student submits, `liveMode` goes false; if the position depended on it, the
  // playhead would fall back to a stored `t` that was never advanced while
  // following and the view would silently rewind to an empty document at the
  // exact moment it is supposed to settle onto the final recorded session.
  // Following means "pinned to the end of the timeline", which stays the right
  // answer after the stream has stopped.
  const position = following ? duration : t;

  // Switching task rewinds: the timelines are different lengths and a position
  // carried across would land somewhere arbitrary.
  const selectTask = useCallback((taskId) => {
    setSelectedTask(taskId);
    setT(0);
    setPlaying(false);
    setFollowing(false); // an explicit choice to inspect, not to follow
  }, []);

  // ── Playback loop (rAF; text only re-renders when the frame text changes) ─
  useEffect(() => {
    if (!playing || following || !replay) return;
    let last = performance.now();
    let raf;
    const tick = (now) => {
      const dt = (now - last) * speed;
      last = now;
      setT((prev) => {
        let next = prev + dt;
        if (skipIdle) {
          // Fast-forward long pauses: jump to just before the gap's end.
          const gap = replay.gaps.find((g) => next > g.start + 1500 && next < g.end - 200);
          if (gap) next = gap.end - 100;
        }
        if (next >= replay.totalDurationMs) {
          setPlaying(false);
          return replay.totalDurationMs;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, following, speed, skipIdle, replay]);

  // Session 24: the replay is file-aware. `stateAt` answers BOTH which file was
  // being edited at T and that file's exact text, so a file switch reads as a
  // labeled change rather than the content mysteriously jumping.
  const state = useMemo(
    () => (replay ? replay.stateAt(position) : { fileName: null, text: "" }),
    [replay, position],
  );
  const text = state.text;
  const activeFileName = state.fileName;

  // ── Paste highlight: flash the pasted range for ~1.2s after its moment ────
  // Scoped to the file the paste happened in — a range from another file would
  // decorate arbitrary characters in the one on screen.
  const activePaste = useMemo(
    () =>
      replay?.pasteMarks.find(
        (m) =>
          position >= m.t &&
          position <= m.t + PASTE_FLASH_MS &&
          (m.fileName == null || m.fileName === activeFileName),
      ) ?? null,
    [replay, position, activeFileName],
  );
  const lastPaste = useMemo(() => {
    if (!replay) return null;
    let latest = null;
    for (const m of replay.pasteMarks) if (m.t <= position) latest = m;
    return latest;
  }, [replay, position]);

  // ── Scrubber checkpoints (Fix 3) ──────────────────────────────────────────
  // Paste ticks come from the replay itself; tab-out and AST ticks come from
  // the session's recorded Tier-1 log. Nothing new is captured.
  //
  // Tier-1 entries carry no taskId (gap #32), so they cannot honestly be placed
  // on a single task's narrowed timeline — a tab-out at 04:12 of the session is
  // not at 04:12 of Task 2. Rather than guess, per-task replay shows paste ticks
  // only and the legend says why.
  const tier1Events = selectedTask ? null : (data?.tier1Events ?? null);
  const ticks = useMemo(
    () =>
      replay
        ? buildTickMarks({
            pasteMarks: replay.pasteMarks,
            tier1Events,
            startTime: replay.startTime,
            totalDurationMs: replay.totalDurationMs,
          })
        : [],
    [replay, tier1Events],
  );
  const legendKinds = useMemo(() => tickKindsPresent(ticks), [ticks]);
  const visibleTicks = useMemo(
    () => ticks.filter((tk) => (tk.kind === "tabout" ? showTabOuts : true)),
    [ticks, showTabOuts],
  );

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    if (activePaste) {
      const start = model.getPositionAt(Math.min(activePaste.rangeStart, model.getValueLength()));
      const end = model.getPositionAt(Math.min(activePaste.rangeEnd, model.getValueLength()));
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
        {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { className: "dvr-paste-flash", isWholeLine: false },
        },
      ]);
      editor.revealPositionInCenterIfOutsideViewport(start);
    } else {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
  }, [activePaste, text]);

  // Any seek is a deliberate move into the past, so it detaches from the live
  // edge. The stream keeps arriving and the timeline keeps growing — only the
  // VIEW stays where the instructor put it, which is what "rewind while it's
  // still happening" has to mean.
  const seek = useCallback(
    (ms) => {
      setFollowing(false);
      setT(Math.max(0, Math.min(duration, ms)));
    },
    [duration],
  );

  const jumpToLive = useCallback(() => {
    setPlaying(false);
    setFollowing(true);
  }, []);

  // Play means something different at the live edge: there is nothing ahead to
  // play towards, so pressing it there detaches and replays the session from the
  // start. The button is LABELLED for that, so it is a stated action rather than
  // a surprising jump.
  const togglePlay = useCallback(() => {
    if (following) {
      setFollowing(false);
      setT(0);
      setPlaying(duration > 0);
      return;
    }
    setPlaying((p) => !p && duration > 0);
  }, [following, duration]);

  function handleKeyDown(e) {
    if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      seek(position - 5000);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seek(position + 5000);
    }
  }

  // ── States ────────────────────────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty">Select a session — click a student tile or a Replay button.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty"><span className="spinner" aria-hidden="true" />Loading replay…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty dvr-error">{error}</div>
      </div>
    );
  }
  if (!replay) return null;

  const { studentId, status, forensicsResults } = data;
  // The task whose forensics are shown beside the player. With a task selected
  // these are that task's OWN numbers; with "All tasks" they are the
  // session-wide computation (which on a multi-task exam is an average — the
  // merged pill beside it is the review signal).
  const taskBundle = selectedTask ? forensicsResults?.tasks?.[selectedTask] ?? null : null;
  const shown = taskBundle ?? forensicsResults;

  // Part 4 — an IN_PROGRESS session must say WHAT it is showing. The durable
  // record ends at the last flush; everything since then exists only in the
  // student's browser. Stating that is the difference between "here is the
  // session up to 14:32:07" and silently implying the instructor is looking at
  // the present moment.
  const flushedThrough = recordedThrough(data);
  const inProgress = status === "IN_PROGRESS";
  const liveInfo = liveStatus ? LIVE_STATUS[liveStatus] : null;
  const liveTailCount = replay.liveEventCount ?? 0;

  return (
    <div className="dvr-panel" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="dvr-header">
        <span className="dvr-student" title={studentId}>{studentId}</span>
        {data.assignmentTitle && (
          <span className="dvr-assignment" title={data.assignmentTitle}>
            {data.assignmentTitle}
          </span>
        )}
        <span className={`dvr-badge ${status === "IN_PROGRESS" ? "in-progress" : "submitted"}`}>
          {status}
        </span>
        {isMultiTask && (
          <span className="dvr-count">{data.taskCount ?? taskIds.length} tasks</span>
        )}
        <span className="dvr-count">
          {replay.eventCount} keystroke events · {data.snapshots.length} snapshots
        </span>
        {/* The session's REVIEW signal: any task flagged. Shown next to the
            student so a flagged task inside an otherwise clean-looking session
            is the first thing read, not something buried in a table. */}
        {isMultiTask && forensicsResults && (
          <MergedFlagPill
            merged={forensicsResults.merged}
            taskCount={data.taskCount ?? taskIds.length}
          />
        )}
      </div>

      {/* ── Live status + the in-progress record boundary (Session 28) ──────
          One strip, because they answer the same question: how current is what
          I am looking at? The live line is only rendered in live mode; the
          "recorded up to" line is shown for ANY in-progress session, so the
          non-live fallback (Part 4) is equally explicit rather than leaving the
          instructor to assume the view is the present. */}
      {(liveInfo || inProgress) && (
        <div className="dvr-live-strip">
          {liveInfo && (
            <span className={`dvr-live-badge ${liveInfo.tone}`} title={liveError ?? undefined}>
              <span className="dvr-live-dot">{liveInfo.dot}</span>
              {liveStatus === "following" && !following
                ? "LIVE — rewound (stream still recording)"
                : liveInfo.text}
            </span>
          )}
          {liveStatus === "following" && liveTailCount > 0 && (
            <span className="dvr-live-note">
              {liveTailCount} keystroke{liveTailCount === 1 ? "" : "s"} streamed since the last
              flush — not yet in the durable record
            </span>
          )}
          {liveError && <span className="dvr-live-note error">{liveError}</span>}
          {inProgress && (
            <span className="dvr-live-note">
              {flushedThrough
                ? `Recorded up to ${fmtWallClock(flushedThrough)} (last flush).`
                : "Nothing flushed to the database yet."}
              {liveStatus === "following"
                ? " The current moment comes from the live stream."
                : " The current moment is only visible on the live stream."}
            </span>
          )}
        </div>
      )}

      <div className="dvr-forensics">
        {forensicsResults ? (
          <>
            {selectedTask && (
              <span className="dvr-scope-note">
                Showing {taskLabel(selectedTask)}
                {taskBundle ? "'s own forensics" : " — no per-task forensics recorded"}:
              </span>
            )}
            {METRIC_ORDER.map((key) => (
              <MetricPill
                key={key}
                metricKey={key}
                metric={shown?.[key]}
                // Feature 3 — optional accuracy judgment, behavioral metrics
                // only. Scoped to the task currently selected, so judging
                // "Task 2's authorship" is stored against Task 2 rather than
                // against the session average shown under "All tasks".
                review={
                  BEHAVIORAL_METRICS.includes(key) ? (
                    <MetricReviewControl
                      sessionId={sessionId}
                      taskId={selectedTask}
                      metric={key}
                      predictedFlag={Boolean(shown?.[key]?.flag)}
                      initialJudgment={judgments[judgmentKey(selectedTask, key)] ?? null}
                      onSaved={recordJudgment}
                    />
                  ) : null
                }
              />
            ))}
            {/* Feature 3 — the controls above need explaining exactly once,
                wherever they appear. TaskReport carries its own copy for the
                per-task table; this covers the session-level pills, including
                on a single-task session where no task table renders at all. */}
            <span className="metric-review-note">
              👍/👎 beside a behavioral metric is optional and records whether YOU think that
              assessment was accurate. It is collected only to tune these thresholds manually
              later — nothing is retuned automatically, and no judgment changes this or any
              other student's result. Tab-outs, pastes and construct checks are factual
              records, so they carry no judgment.
            </span>
            <span className="dvr-severity-note">
              Colors are severity guidance — "flagged" means flagged for instructor
              review. The run-count and typed-share thresholds are configurable
              defaults; judge them against task complexity.
              {isMultiTask && !selectedTask
                ? " These session-level figures span every task; the per-task breakdown below is the sharper reading."
                : ""}
            </span>
          </>
        ) : (
          <span className="dvr-pill pending">Forensics pending (session not yet submitted)</span>
        )}
      </div>

      <Tier1Row summary={data.tier1Summary} />
      <AstAuditRow audit={shown?.astAudit} />

      {/* The four metric cards above carry their own descriptions inline; this
          adds the construct check and the three live-event kinds, so every
          signal on this screen is explained in one place. */}
      <MetricGlossary keys={["astAudit", "merged"]} includeTier1 />

      {/* Per-task breakdown + merged report (Prompt 2). Rendered only for a
          genuinely multi-task session: a single-task exam shows exactly the
          report it always did, with no empty "Task 1" chrome. */}
      {isMultiTask && forensicsResults?.tasks && (
        <TaskReport
          tasks={forensicsResults.tasks}
          merged={forensicsResults.merged}
          taskCount={data.taskCount ?? taskIds.length}
          selectedTaskId={selectedTask}
          onReplayTask={selectTask}
          sessionId={sessionId}
          judgments={judgments}
          onJudged={recordJudgment}
        />
      )}

      {/* Which task is on the player. "All tasks" is the whole session as one
          timeline; picking a task replays that task's own reconstruction. */}
      {isMultiTask && (
        <div className="dvr-tasks">
          <span className="dvr-tasks-label">Replay:</span>
          <button
            className={`dvr-task-tab ${selectedTask === null ? "active" : ""}`}
            onClick={() => selectTask(null)}
            title="Replay the whole session as one timeline, across every task"
          >
            All tasks
          </button>
          {taskIds.map((id) => (
            <button
              key={id}
              className={`dvr-task-tab ${selectedTask === id ? "active" : ""}`}
              onClick={() => selectTask(id)}
              title={`Replay ${taskLabel(id)} on its own`}
            >
              {taskLabel(id)}
            </button>
          ))}
        </div>
      )}

      {duration === 0 ? (
        <div className="dvr-empty">
          {selectedTask
            ? `No keystroke activity recorded for ${taskLabel(selectedTask)}.`
            : liveMode
              ? "Waiting for the student's first keystrokes…"
              : "No keystroke activity recorded for this session yet."}
        </div>
      ) : (
        <>
          <div className="dvr-controls">
            <button
              className="btn btn-secondary dvr-play"
              onClick={togglePlay}
              title={
                following
                  ? "Leave the live edge and replay this session from the beginning"
                  : "Space = play/pause · ←/→ = seek 5s"
              }
            >
              {following ? "▶ Replay from start" : playing ? "❚❚ Pause" : "▶ Play"}
            </button>
            {/* The way back from a rewind. Only offered while a live stream is
                actually running, and only when detached — an always-visible
                control that does nothing is worse than no control. */}
            {liveMode && liveStatus === "following" && !following && (
              <button
                className="btn btn-primary dvr-jump-live"
                onClick={jumpToLive}
                title="Resume following the student's present moment"
              >
                ⟲ Jump to live
              </button>
            )}
            <label className="dvr-speed">
              Speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>{s}×</option>
                ))}
              </select>
            </label>
            <label className="dvr-skip">
              <input
                type="checkbox"
                checked={skipIdle}
                onChange={(e) => setSkipIdle(e.target.checked)}
              />
              Skip idle gaps ({replay.gaps.length})
            </label>
            <span className="dvr-clock mono">
              {fmtClock(position)} / {fmtClock(duration)}
              {liveMode && following ? " · live edge" : ""}
            </span>
          </div>

          <div className="dvr-scrubber">
            <div className={`dvr-track ${liveMode && following ? "following" : ""}`}>
              <input
                type="range"
                min={0}
                max={duration}
                value={Math.round(position)}
                onChange={(e) => seek(Number(e.target.value))}
              />
              {/* Checkpoint ticks — paste, construct-not-permitted and tab-out.
                  Click any of them to jump straight to that moment. Tab-outs
                  render with `persistent`, which keeps them fully saturated
                  wherever the playhead is. */}
              {visibleTicks.map((tk, i) => (
                <button
                  key={`${tk.kind}-${tk.t}-${i}`}
                  className={`dvr-tick ${tk.kind} ${tk.variant} ${tk.persistent ? "persistent" : ""}`}
                  style={{ left: `${tk.pct}%` }}
                  title={tk.title}
                  aria-label={tk.title}
                  onClick={() => {
                    seek(tk.t);
                    setPlaying(false);
                  }}
                />
              ))}
            </div>

            {/* Legend — every marker names itself in words as well as color, so
                the timeline is readable without relying on color alone. */}
            <div className="dvr-legend">
              {legendKinds.map((k) => (
                <span key={k.key} className="dvr-legend-item">
                  <span className={`dvr-legend-swatch ${k.key}`} aria-hidden="true" />
                  {k.legend}
                  {k.key === "tabout" && (
                    <label className="dvr-legend-toggle" title="Tab-out markers stay prominent across the whole timeline. Hide them if they crowd the view.">
                      <input
                        type="checkbox"
                        checked={showTabOuts}
                        onChange={(e) => setShowTabOuts(e.target.checked)}
                      />
                      show
                    </label>
                  )}
                </span>
              ))}
              {/* Say what is NOT on the timeline, rather than letting an empty
                  one read as "nothing happened" — the same discipline the
                  Tier-1 counts follow. */}
              {!selectedTask && data.tier1Events === null && (
                <span className="dvr-legend-note">
                  Tab-outs and construct checks were not recorded for this session —
                  their absence here is unknown, not zero.
                </span>
              )}
              {selectedTask && (
                <span className="dvr-legend-note">
                  Tab-out and construct markers are shown on the whole-session
                  timeline only — Tier-1 alerts are recorded per session, not per
                  task, so they cannot be placed on one task&apos;s timeline.
                </span>
              )}
            </div>

            <div className="dvr-scrub-label">
              {lastPaste ? (
                <span className={`dvr-paste-label ${activePaste ? "active" : ""}`}>
                  ⚠ Paste: +{lastPaste.charCount} chars at {fmtClock(lastPaste.t)}
                  {lastPaste.provenance ? ` (${lastPaste.provenance})` : ""}
                </span>
              ) : (
                <span>No paste moments before this point</span>
              )}
            </div>
          </div>

          {/* Which file the student was editing at this moment. The strip
              exists even for single-file sessions so the reading is never
              ambiguous, and it is what turns a mid-replay content jump into an
              explained file switch. */}
          <div className="dvr-files">
            {(replay.files ?? []).map((name) => (
              <span
                key={name}
                className={`dvr-file-tab ${name === activeFileName ? "active" : ""}`}
                title={name === activeFileName ? `Editing ${name} at this moment` : name}
              >
                {name}
              </span>
            ))}
            <span className="dvr-fidelity" title={FIDELITY_HINT[replay.exact ? "exact" : "approx"]}>
              {replay.exact ? "exact replay" : "approximate replay"}
            </span>
            {/* The live tail is reconstructed from the same exact edits, on top
                of a checkpoint that WAS verified against a flush — but it has
                no snapshot of its own to be checked against yet, and saying so
                is the same discipline the exact/approximate label follows. */}
            {liveTailCount > 0 && (
              <span
                className="dvr-fidelity live"
                title={`The last ${liveTailCount} keystroke(s) came from the live stream and have not been flushed, so they are reconstructed from the same exact edits but not yet verified against a stored snapshot.`}
              >
                + live edge (unflushed)
              </span>
            )}
          </div>

          <Editor
            height="400px"
            path={activeFileName ?? undefined}
            language={languageOf(activeFileName ?? "main.cpp")}
            value={text}
            theme="vs-dark"
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
            }}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 14 }}
          />
        </>
      )}
    </div>
  );
}
