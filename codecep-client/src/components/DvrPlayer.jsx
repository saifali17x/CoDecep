import { useState, useEffect } from "react";
import Editor from "@monaco-editor/react";
import {
  metricASeverity,
  metricBSeverity,
  metricCSeverity,
  LEVEL_COLORS,
} from "../lib/metricColors";
import "./DvrPlayer.css";

const METRIC_LABELS = {
  metricA: "Metric A (Trial-and-Error)",
  metricB: "Metric B (Linear Injection)",
  metricC: "Metric C (Robotic Variance)",
};

// Severity-colored pill (Session 17). Color is ALWAYS paired with the text
// label; red means "flagged for review", never an accusation.
function MetricPill({ metricKey, metric }) {
  const sev =
    metricKey === "metricA"
      ? metricASeverity(metric?.runCount)
      : metricKey === "metricC"
        ? metricCSeverity(metric?.stats?.cv ?? null)
        : metricBSeverity(metric?.flag);
  const color = LEVEL_COLORS[sev.level];
  return (
    <span
      className="dvr-pill"
      style={{ color, borderColor: color }}
      title={metric?.reason ?? sev.label}
    >
      {METRIC_LABELS[metricKey]}: {sev.label}
    </span>
  );
}

export default function DvrPlayer({ sessionId }) {
  const [playback, setPlayback] = useState(null); // { studentId, status, snapshotCount, forensicsResults, snapshots }
  const [sliderIndex, setSliderIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setPlayback(null);
    setSliderIndex(0);

    fetch(`http://localhost:3001/api/session/${sessionId}/playback`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setPlayback(data);
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
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty">
          Select a session — click a session ID in the alert feed or paste one above.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="dvr-panel">
        <div className="dvr-empty"><span className="spinner" aria-hidden="true" />Loading session…</div>
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

  if (!playback) return null;

  const { studentId, status, snapshotCount, forensicsResults, snapshots } = playback;
  const current = snapshots[sliderIndex];

  return (
    <div className="dvr-panel">
      <div className="dvr-header">
        <span className="dvr-student">{studentId}</span>
        <span className={`dvr-badge ${status === "IN_PROGRESS" ? "in-progress" : "submitted"}`}>
          {status}
        </span>
        <span className="dvr-count">{snapshotCount} snapshots</span>
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

      {snapshotCount === 0 ? (
        <div className="dvr-empty">No snapshots recorded for this session</div>
      ) : (
        <>
          <div className="dvr-scrubber">
            <input
              type="range"
              min={0}
              max={Math.max(0, snapshots.length - 1)}
              value={sliderIndex}
              onChange={(e) => setSliderIndex(Number(e.target.value))}
            />
            <div className="dvr-scrub-label">
              Snapshot {sliderIndex + 1} of {snapshots.length} —{" "}
              {new Date(current.flushedAt).toLocaleTimeString()} — {current.eventCount} keystrokes
            </div>
          </div>

          {/* Read-only display editor. The "never setValue()" rule protects the LIVE
              student editor's telemetry capture; a controlled value prop is correct here. */}
          <Editor
            height="400px"
            language="cpp"
            value={current?.codeSnapshot ?? ""}
            theme="vs-dark"
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 14 }}
          />
        </>
      )}
    </div>
  );
}
