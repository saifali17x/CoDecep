import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { metricPlainName } from "../lib/metricLabels";
import "./MetricReviewControl.css";

// ── Behavioral-metric accuracy review (Feature 3) ───────────────────────────
//
// An OPTIONAL "was this assessment accurate?" beside a behavioral metric.
// Deliberately low-friction and easy to ignore: two small buttons, no prompt,
// no modal, no nagging, and nothing anywhere requires an answer. An instructor
// who never touches these sees a product that behaves exactly as before.
//
// It appears ONLY next to the probabilistic metrics (metricA/B/C/authorship).
// Tab-outs, pastes and AST violations are factual records — "was that
// accurate?" is not a meaningful question about them, and the server rejects
// the attempt anyway.
//
// What this collects is CALIBRATION DATA for a later MANUAL tuning pass.
// Nothing in the system reads these judgments to move a threshold, and nothing
// should: a detector that retunes itself from the opinions of the people it
// reports to would quietly learn to stop reporting.
export default function MetricReviewControl({
  sessionId,
  taskId = null,
  metric,
  // What the metric SAID — stored beside the judgment, because "inaccurate"
  // means opposite things depending on whether it flagged or stayed quiet.
  predictedFlag,
  initialJudgment = null,
  onSaved,
}) {
  const { token, user } = useAuth();
  const [judgment, setJudgment] = useState(initialJudgment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The saved judgments are fetched AFTER this control first renders (they are
  // a separate request from the replay), so `initialJudgment` arrives late.
  // Adopt it as a render-time state adjustment rather than an effect — the same
  // pattern the DVR's task selection uses — so a reloaded report shows the
  // instructor's previous answer immediately instead of one render behind, or
  // (before this) never at all. `busy` guards the case where their own click is
  // still in flight: their new answer must not be overwritten by the old one.
  const [seenInitial, setSeenInitial] = useState(initialJudgment);
  if (initialJudgment !== seenInitial && !busy) {
    setSeenInitial(initialJudgment);
    setJudgment(initialJudgment);
  }

  // Students never see this: it is an instructor calibration control.
  if (!sessionId || user?.role !== "INSTRUCTOR") return null;

  async function send(next) {
    // Clicking the active choice again is a no-op rather than a toggle-off:
    // "no opinion" and "I changed my mind to the same thing" are different, and
    // silently deleting a judgment on a stray double-click would lose data.
    if (busy || next === judgment) return;
    setBusy(true);
    setError("");
    const previous = judgment;
    setJudgment(next); // optimistic — the control must feel instant
    try {
      const row = await apiFetch(`/api/sessions/${sessionId}/metric-reviews`, {
        method: "POST",
        token,
        body: { metric, taskId, predictedFlag: Boolean(predictedFlag), judgment: next },
      });
      onSaved?.(row);
    } catch (err) {
      setJudgment(previous);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // The plain name is what makes "was this accurate?" answerable: an instructor
  // can judge "Typed vs pasted" against the program in front of them, where
  // "authorship" was a word they had to decode first. The stored `metric` key
  // is unchanged — this is the label only.
  const name = metricPlainName(metric);

  return (
    <span
      className="metric-review"
      title={`Optional: was the "${name}" assessment accurate for this session? Collected only to tune these thresholds manually later — nothing is retuned automatically.`}
    >
      <button
        type="button"
        className={`metric-review-btn ${judgment === "accurate" ? "on accurate" : ""}`}
        onClick={() => send("accurate")}
        disabled={busy}
        aria-pressed={judgment === "accurate"}
        aria-label={`Mark the "${name}" assessment accurate`}
      >
        👍
      </button>
      <button
        type="button"
        className={`metric-review-btn ${judgment === "inaccurate" ? "on inaccurate" : ""}`}
        onClick={() => send("inaccurate")}
        disabled={busy}
        aria-pressed={judgment === "inaccurate"}
        aria-label={`Mark the "${name}" assessment inaccurate`}
      >
        👎
      </button>
      {error && <span className="metric-review-error" title={error}>!</span>}
    </span>
  );
}
