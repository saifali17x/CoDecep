import './TopBar.css'

export default function TopBar() {
  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <span className="top-bar-logo">CoDecep</span>
      </div>
      <div className="top-bar-actions">
        <button className="btn btn-run">Run Code</button>
        <button className="btn btn-submit">Submit</button>
      </div>
    </header>
  )
}
