import { useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import './EditorPane.css'

function classifyAction(delta) {
  if (delta < 0) return 'delete'
  if (delta > 4) return 'paste'
  return 'type'
}

export default function EditorPane({ code, language, onChange, onCursorChange, onFlush }) {
  const lastKeystrokeTime = useRef(Date.now())
  const prevCode = useRef(code)
  const telemetryBuffer = useRef([])

  useEffect(() => {
    const id = setInterval(() => {
      if (telemetryBuffer.current.length === 0) return
      const payloadToFlush = [...telemetryBuffer.current]
      telemetryBuffer.current = []
      onFlush(payloadToFlush)
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  function handleChange(val) {
    const next = val ?? ''
    const now = Date.now()
    const timeSinceLastKeystrokeMs = now - lastKeystrokeTime.current
    lastKeystrokeTime.current = now

    const charDelta = next.length - prevCode.current.length
    const actionType = classifyAction(charDelta)
    prevCode.current = next

    telemetryBuffer.current.push({ timestamp: now, timeSinceLastKeystrokeMs, actionType, charDelta, textLength: next.length })

    onChange(next)
  }

  function handleMount(editor) {
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange(e.position.lineNumber, e.position.column)
    })
  }

  return (
    <div className="editor-pane">
      <div className="editor-tabs">
        <div className="editor-tab active">
          <span className="tab-badge cpp">C</span>
          main.cpp
          <span className="tab-close">&#215;</span>
        </div>
      </div>
      <div className="editor-body">
        <Editor
          height="100%"
          language={language}
          value={code}
          onChange={handleChange}
          theme="vs-dark"
          onMount={handleMount}
          options={{
            fontSize: 14,
            fontFamily: '"Cascadia Code", ui-monospace, Consolas, monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbersMinChars: 3,
            padding: { top: 10 },
            renderLineHighlight: 'line',
            cursorBlinking: 'smooth',
            smoothScrolling: true,
          }}
        />
      </div>
    </div>
  )
}
