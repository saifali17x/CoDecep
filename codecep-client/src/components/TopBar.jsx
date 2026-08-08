import { BrandMark } from "./BrandMark";
import "./TopBar.css";

// Single exam strip (Session 21): back-to-class + assignment title + lab mode on
// the left, language + Run + Submit on the right. The language is a STATIC C++
// label — the tool is scoped to C++ only (sandboxed Judge0 execution reliably
// supports self-contained C++ programs; systems/networked C is out of scope).
export default function TopBar({
  onRun,
  isRunning,
  onSubmit,
  isSubmitted,
  // Session 25: submit awaits one final telemetry flush before it disarms, so
  // there is a brief in-flight window the button has to reflect.
  isSubmitting = false,
  onBack,
  title,
  labMode,
  // Timed submission window (Feature 1) — the countdown, passed in as a node so
  // this strip stays a layout component and knows nothing about deadlines.
  // Absent on untimed assignments, which render exactly as they always did.
  timer = null,
}) {
  return (
    <header className="top-bar">
      <div className="top-bar-left">
        {onBack && (
          <button className="btn btn-back" onClick={onBack}>
            ← Back to Class
          </button>
        )}
        {/* Same mark + wordmark pairing as the app nav, at the exam strip's
            smaller scale. Note the strip carries no theme switcher: it is kept
            minimal on purpose so nothing tempts a student mid-exam, and the
            theme they picked before opening the paper is what applies. */}
        <BrandMark size={22} />
        <span className="top-bar-logo">CoDecep</span>
        {title && <span className="top-bar-title">{title}</span>}
        {labMode && <span className={`top-bar-mode ${labMode}`}>{labMode}</span>}
      </div>
      <div className="top-bar-actions">
        {timer}
        <span className="lang-label" title="This exam runs C++ only">C++</span>
        <button className="btn btn-run" onClick={onRun} disabled={isRunning || isSubmitted}>
          {isRunning ? "Running..." : "▶ Run Code"}
        </button>
        <button
          className="btn btn-submit"
          onClick={onSubmit}
          disabled={isSubmitted || isSubmitting}
        >
          {isSubmitted ? "✓ Submitted" : isSubmitting ? "Submitting..." : "Submit"}
        </button>
      </div>
    </header>
  );
}
