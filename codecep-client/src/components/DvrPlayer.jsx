import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { buildReplay } from "../lib/replayEngine";
import { DEFAULT_CODE } from "../App";
import {
  metricASeverity,
  metricBSeverity,
  metricCSeverity,
  LEVEL_COLORS,
} from "../lib/metricColors";
import "./DvrPlayer.css";

// Session 19 — keystroke-level DVR replay. The instructor WATCHES the code
// get written: play/pause, speed, skip-idle, scrubbing, and a visible flash
// when a pasted block appears at once. Reconstruction is snapshot-anchored
// (see lib/replayEngine.js) — timing and paste moments are exact; character
// order within a typed burst is approximated. Display-only: the editor is
// read-only and paste highlights use Monaco decorations, never content edits.

const METRIC_LABELS = {
  metricA: "Metric A (Trial-and-Error)",
  metricB: "Metric B (Linear Injection)",
  metricC: "Metric C (Robotic Variance)",
};
const SPEEDS = [1, 2, 5, 10, 25];
const PASTE_FLASH_MS = 1200;

function MetricPill({ metricKey, metric }) {
  const sev =
    metricKey === "metricA"
      ? metricASeverity(metric?.runCount)
      : metricKey === "metricC"
        ? metricCSeverity(metric?.stats?.cv ?? null)
        : metricBSeverity(metric?.flag);
  const color = LEVEL_COLORS[sev.level];
  return (
    <span className="dvr-pill" style={{ color, borderColor: color }} title={metric?.reason ?? sev.label}>
      {METRIC_LABELS[metricKey]}: {sev.label}
    </span>
  );
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function DvrPlayer({ sessionId }) {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [t, setT] = useState(0); // playback position, ms relative to start
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [skipIdle, setSkipIdle] = useState(true);

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

  const replay = useMemo(
    () => (data ? buildReplay(data, { initialText: DEFAULT_CODE }) : null),
    [data],
  );
  const duration = replay?.totalDurationMs ?? 0;

  // ── Playback loop (rAF; text only re-renders when the frame text changes) ─
  useEffect(() => {
    if (!playing || !replay) return;
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
  }, [playing, speed, skipIdle, replay]);

  const text = replay ? replay.textAt(t) : "";

  // ── Paste highlight: flash the pasted range for ~1.2s after its moment ────
  const activePaste = useMemo(
    () => replay?.pasteMarks.find((m) => t >= m.t && t <= m.t + PASTE_FLASH_MS) ?? null,
    [replay, t],
  );
  const lastPaste = useMemo(() => {
    if (!replay) return null;
    let latest = null;
    for (const m of replay.pasteMarks) if (m.t <= t) latest = m;
    return latest;
  }, [replay, t]);

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

  const seek = useCallback(
    (ms) => setT(Math.max(0, Math.min(duration, ms))),
    [duration],
  );

  function handleKeyDown(e) {
    if (e.key === " ") {
      e.preventDefault();
      setPlaying((p) => !p && duration > 0);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      seek(t - 5000);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seek(t + 5000);
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

  return (
    <div className="dvr-panel" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="dvr-header">
        <span className="dvr-student" title={studentId}>{studentId}</span>
        <span className={`dvr-badge ${status === "IN_PROGRESS" ? "in-progress" : "submitted"}`}>
          {status}
        </span>
        <span className="dvr-count">
          {replay.eventCount} keystroke events · {data.snapshots.length} snapshots
        </span>
      </div>

      <div className="dvr-forensics">
        {forensicsResults ? (
          <>
            {Object.keys(METRIC_LABELS).map((key) => (
              <MetricPill key={key} metricKey={key} metric={forensicsResults[key]} />
            ))}
            <span className="dvr-severity-note">
              Colors are severity guidance — "flagged" means flagged for instructor
              review. The run-count threshold is a configurable default; judge it
              against task complexity.
            </span>
          </>
        ) : (
          <span className="dvr-pill pending">Forensics pending (session not yet submitted)</span>
        )}
      </div>

      {duration === 0 ? (
        <div className="dvr-empty">
          No keystroke activity recorded for this session yet.
        </div>
      ) : (
        <>
          <div className="dvr-controls">
            <button
              className="btn btn-secondary dvr-play"
              onClick={() => setPlaying((p) => !p)}
              title="Space = play/pause · ←/→ = seek 5s"
            >
              {playing ? "❚❚ Pause" : "▶ Play"}
            </button>
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
              {fmtClock(t)} / {fmtClock(duration)}
            </span>
          </div>

          <div className="dvr-scrubber">
            <div className="dvr-track">
              <input
                type="range"
                min={0}
                max={duration}
                value={Math.round(t)}
                onChange={(e) => seek(Number(e.target.value))}
              />
              {/* Paste tick marks — click to jump straight to the moment */}
              {replay.pasteMarks.map((m, i) => (
                <button
                  key={i}
                  className={`dvr-paste-mark ${m.provenance === "internal" ? "internal" : "external"}`}
                  style={{ left: `${(m.t / duration) * 100}%` }}
                  title={`Paste +${m.charCount} chars at ${fmtClock(m.t)}${m.provenance ? ` (${m.provenance})` : ""} — click to jump`}
                  onClick={() => {
                    seek(m.t);
                    setPlaying(false);
                  }}
                />
              ))}
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

          <Editor
            height="400px"
            language="cpp"
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
