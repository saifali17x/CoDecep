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
  onBack,
  title,
  labMode,
}) {
  return (
    <header className="top-bar">
      <div className="top-bar-left">
        {onBack && (
          <button className="btn btn-back" onClick={onBack}>
            ← Back to Class
          </button>
        )}
        <span className="top-bar-logo">CoDecep</span>
        {title && <span className="top-bar-title">{title}</span>}
        {labMode && <span className={`top-bar-mode ${labMode}`}>{labMode}</span>}
      </div>
      <div className="top-bar-actions">
        <span className="lang-label" title="This exam runs C++ only">C++</span>
        <button className="btn btn-run" onClick={onRun} disabled={isRunning || isSubmitted}>
          {isRunning ? "Running..." : "▶ Run Code"}
        </button>
        <button
          className="btn btn-submit"
          onClick={onSubmit}
          disabled={isSubmitted}
        >
          {isSubmitted ? "✓ Submitted" : "Submit"}
        </button>
      </div>
    </header>
  );
}
