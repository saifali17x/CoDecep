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

function App() {
  const [code, setCode] = useState(DEFAULT_CODE)
  const [language, setLanguage] = useState('cpp')
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [terminalLines, setTerminalLines] = useState([])
  const [isRunning, setIsRunning] = useState(false)

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

  async function handleRun() {
    setIsRunning(true)
    try {
      const res = await fetch('http://localhost:3001/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, lang: language }),
      })
      const data = await res.json()
      setTerminalLines((prev) => [
        ...prev,
        { kind: 'output', output: data.output ?? data.error ?? 'No output returned.' },
      ])
    } catch (err) {
      setTerminalLines((prev) => [
        ...prev,
        { kind: 'output', output: `Network error — ${err.message}` },
      ])
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="app">
      <TopBar onRun={handleRun} isRunning={isRunning} language={language} onLanguageChange={setLanguage} />
      <div className="workspace">
        <Sidebar />
        <div className="main-content">
          <EditorPane
            code={code}
            language={language}
            onChange={setCode}
            onCursorChange={(line, col) => setCursor({ line, col })}
            onFlush={handleFlush}
          />
          <Terminal lines={terminalLines} />
        </div>
      </div>
      <StatusBar language={language} line={cursor.line} col={cursor.col} />
    </div>
  )
}

export default App
