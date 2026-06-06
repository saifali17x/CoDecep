import './TopBar.css'

export default function TopBar({ onRun, isRunning, language, onLanguageChange }) {
  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <span className="top-bar-logo">CoDecep</span>
      </div>
      <div className="top-bar-actions">
        <select
          className="lang-select"
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
        >
          <option value="cpp">C++</option>
          <option value="c">C</option>
        </select>
        <button className="btn btn-run" onClick={onRun} disabled={isRunning}>
          {isRunning ? 'Running...' : '▶ Run Code'}
        </button>
        <button className="btn btn-submit">Submit</button>
      </div>
    </header>
  )
}
