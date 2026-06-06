import { useEffect, useRef } from 'react'
import './Terminal.css'

const ACTION_COLOR = { type: '#4ec9b0', paste: '#f9a86a', delete: '#f48771' }

export default function Terminal({ lines = [] }) {
  const bodyRef = useRef(null)

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [lines])

  return (
    <div className="terminal-pane">
      <div className="terminal-tab-bar">
        <div className="terminal-tab active">Terminal</div>
        <div className="terminal-tab">Problems</div>
        <div className="terminal-tab">Output</div>
      </div>
      <div className="terminal-body" ref={bodyRef}>
        {lines.length === 0 ? (
          <div className="terminal-line">
            <span className="terminal-prompt">~/codecep</span>
            <span className="terminal-separator"> $ </span>
            <span className="terminal-cursor" />
          </div>
        ) : (
          lines.map((line, i) => {
            if (line.kind === 'status') {
              return (
                <div key={i} className={`terminal-status ${line.ok ? 'terminal-status--ok' : 'terminal-status--err'}`}>
                  {line.ok ? '[OK]' : '[ERR]'} {line.message}
                </div>
              )
            }

            if (line.kind === 'output') {
              return (
                <div key={i} className="terminal-output">
                  <div className="terminal-output-header">[RUN OUTPUT]</div>
                  <pre className="terminal-output-body">{line.output}</pre>
                </div>
              )
            }

            return (
              <div key={i} className="terminal-chunk">
                <div className="terminal-chunk-header">
                  [FLUSH #{line.chunkNum}] &nbsp;
                  <span className="terminal-dim">{new Date(line.flushedAt).toLocaleTimeString()}</span>
                  &nbsp;—&nbsp;{line.events.length} event{line.events.length !== 1 ? 's' : ''}
                </div>
                {line.events.map((ev, j) => (
                  <div key={j} className="terminal-event">
                    <span className="terminal-dim">
                      {new Date(ev.timestamp).toLocaleTimeString('en', {
                        hour12: false,
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        fractionalSecondDigits: 3,
                      })}
                    </span>
                    {' '}
                    <span style={{ color: ACTION_COLOR[ev.actionType] ?? '#d4d4d4' }}>
                      {ev.actionType.padEnd(6)}
                    </span>
                    {' '}
                    <span className="terminal-dim">+{ev.timeSinceLastKeystrokeMs}ms</span>
                    {' '}
                    <span className="terminal-dim">len:{ev.textLength}</span>
                  </div>
                ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
