import './Sidebar.css'

const files = [
  { name: 'main.cpp', type: 'cpp', active: true },
  { name: 'assignment.md', type: 'md', active: false },
]

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">Explorer</div>
      <div className="sidebar-folder">
        <span className="folder-caret">&#9660;</span>
        <span className="folder-name">CODECEP</span>
      </div>
      <ul className="file-list">
        {files.map((file) => (
          <li key={file.name} className={`file-item${file.active ? ' active' : ''}`}>
            <span className={`file-badge file-badge--${file.type}`}>{file.type}</span>
            <span className="file-name">{file.name}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
