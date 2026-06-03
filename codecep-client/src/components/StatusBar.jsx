import './StatusBar.css'

const LANGUAGE_LABELS = { cpp: 'C++', javascript: 'JavaScript', python: 'Python', java: 'Java', rust: 'Rust' }

export default function StatusBar({ language, line, col }) {
  return (
    <div className="status-bar">
      <div className="status-left">
        <span className="status-item">main</span>
        <span className="status-item">CoDecep</span>
      </div>
      <div className="status-right">
        <span className="status-item">Ln {line}, Col {col}</span>
        <span className="status-item">UTF-8</span>
        <span className="status-item">{LANGUAGE_LABELS[language] ?? language}</span>
        <span className="status-item status-connected">Connected</span>
      </div>
    </div>
  )
}
