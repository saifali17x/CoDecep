import { useState } from 'react'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import EditorPane from './components/EditorPane'
import Terminal from './components/Terminal'
import StatusBar from './components/StatusBar'
import './App.css'

const DEFAULT_CODE = `#include <iostream>
using namespace std;

int main() {
    cout << "Hello, World!" << endl;
    return 0;
}
`

const LANGUAGE = 'cpp'

function App() {
  const [code, setCode] = useState(DEFAULT_CODE)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [terminalLines, setTerminalLines] = useState([])

  async function handleFlush(chunk) {
    setTerminalLines((prev) => {
      const chunkNum = prev.filter((l) => l.kind === 'chunk').length + 1
      return [...prev, { kind: 'chunk', chunkNum, flushedAt: Date.now(), events: chunk }]
    })

    try {
      const res = await fetch('http://localhost:3001/api/telemetry/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      })
      const data = await res.json()
      if (res.status === 202) {
        setTerminalLines((prev) => [
          ...prev,
          { kind: 'status', message: `Sent ${data.accepted} event(s) to server — 202 Accepted`, ok: true },
        ])
      } else {
        setTerminalLines((prev) => [
          ...prev,
          { kind: 'status', message: `Server rejected payload — HTTP ${res.status}`, ok: false },
        ])
      }
    } catch (err) {
      setTerminalLines((prev) => [
        ...prev,
        { kind: 'status', message: `Network error — ${err.message}`, ok: false },
      ])
    }
  }

  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <Sidebar />
        <div className="main-content">
          <EditorPane
            code={code}
            language={LANGUAGE}
            onChange={setCode}
            onCursorChange={(line, col) => setCursor({ line, col })}
            onFlush={handleFlush}
          />
          <Terminal lines={terminalLines} />
        </div>
      </div>
      <StatusBar language={LANGUAGE} line={cursor.line} col={cursor.col} />
    </div>
  )
}

export default App
