import { useState, useEffect, useRef } from "react";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import EditorPane from "./components/EditorPane";
import Terminal from "./components/Terminal";
import StatusBar from "./components/StatusBar";
import socket from "./socket";
import "./App.css";

// LIVE_LAB = tab-out alerts are active. ASSESSMENT = tab-outs are ignored.
// Will come from assignment config in a future phase.
const LAB_MODE = "LIVE_LAB"; // 'LIVE_LAB' | 'ASSESSMENT'

const DEFAULT_CODE = `#include <iostream>
using namespace std;

int main() {
    cout << "Hello, World!" << endl;
    return 0;
}
`;

const STUDENT_ID = "student-001";

function App() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [language, setLanguage] = useState("cpp");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [terminalLines, setTerminalLines] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionStatus, setSessionStatus] = useState("IN_PROGRESS");
  const [sessionId, setSessionId] = useState(null);

  // Refs mirror state so the stale closure inside EditorPane's setInterval
  // always reads the CURRENT value, not the value frozen at mount.
  const sessionIdRef = useRef(null);
  const sessionStatusRef = useRef("IN_PROGRESS");
  const codeRef = useRef(DEFAULT_CODE);

  // Focus-gated timer — counts milliseconds while the tab is visible
  const engagedTimeRef = useRef(0);   // banked ms from past focus windows
  const focusStartRef = useRef(null); // Date.now() when current focus window opened

  // Keep codeRef in sync on every code change
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  // Keep sessionStatusRef in sync
  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  // Page Visibility API — disarms when submitted, uses sessionStatusRef to avoid stale closure
  useEffect(() => {
    focusStartRef.current = document.hidden ? null : Date.now();

    const handleVisibilityChange = () => {
      if (sessionStatusRef.current === "SUBMITTED") return;
      if (document.hidden) {
        // Bank engaged time
        if (focusStartRef.current !== null) {
          engagedTimeRef.current += Date.now() - focusStartRef.current;
          focusStartRef.current = null;
        }
        // Tier 1 alert — TAB_OUT (only in LIVE_LAB, never after Submit)
        if (LAB_MODE === "LIVE_LAB") {
          const payload = {
            type: "TAB_OUT",
            studentId: STUDENT_ID,
            sessionId: sessionIdRef.current,
            timestamp: Date.now(),
            detail: "tab lost focus",
          };
          console.log("[EMIT] TAB_OUT", payload);
          socket.emit("alert", payload);
        }
      } else {
        focusStartRef.current = Date.now();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Create (or resume) the session on mount
  useEffect(() => {
    fetch("http://localhost:3001/api/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: STUDENT_ID }),
    })
      .then((r) => r.json())
      .then((data) => {
        setSessionId(data.sessionId);
        sessionIdRef.current = data.sessionId; // ← keep ref in sync for the flush
      })
      .catch((err) =>
        console.error("[SESSION] Failed to create session:", err),
      );
  }, []);

  function handleSubmit() {
    setSessionStatus("SUBMITTED");
    sessionStatusRef.current = "SUBMITTED"; // ← disarm the flush immediately
    const id = sessionIdRef.current;
    if (id) {
      fetch(`http://localhost:3001/api/session/${id}/submit`, {
        method: "POST",
      }).catch((err) =>
        console.error("[SUBMIT] Failed to notify server:", err),
      );
    }
  }

  async function handleFlush(chunk) {
    // Read live values from refs, NOT the captured state, to avoid the
    // stale-closure bug (the interval was created at mount when these were null).
    const currentStatus = sessionStatusRef.current;
    const currentSessionId = sessionIdRef.current;
    const currentCode = codeRef.current;

    if (currentStatus === "SUBMITTED") return;
    if (!currentSessionId) return;

    // Banked time + time accrued in the current (still-open) focus window
    const engagedTimeMs =
      engagedTimeRef.current +
      (focusStartRef.current !== null ? Date.now() - focusStartRef.current : 0);

    setTerminalLines((prev) => {
      const chunkNum = prev.filter((l) => l.kind === "chunk").length + 1;
      return [
        ...prev,
        { kind: "chunk", chunkNum, flushedAt: Date.now(), events: chunk },
      ];
    });

    try {
      const res = await fetch("http://localhost:3001/api/telemetry/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: currentSessionId,
          studentId: STUDENT_ID,
          chunk,
          codeSnapshot: currentCode,
          engagedTimeMs,
        }),
      });
      const data = await res.json();
      if (res.status === 202) {
        setTerminalLines((prev) => [
          ...prev,
          {
            kind: "status",
            message: `Sent ${data.accepted} event(s) to server — 202 Accepted`,
            ok: true,
          },
        ]);
      } else {
        setTerminalLines((prev) => [
          ...prev,
          {
            kind: "status",
            message: `Server rejected payload — HTTP ${res.status}`,
            ok: false,
          },
        ]);
      }
    } catch (err) {
      setTerminalLines((prev) => [
        ...prev,
        {
          kind: "status",
          message: `Network error — ${err.message}`,
          ok: false,
        },
      ]);
    }
  }

  async function handleRun() {
    setIsRunning(true);
    try {
      const res = await fetch("http://localhost:3001/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, lang: language, sessionId: sessionIdRef.current }),
      });
      const data = await res.json();
      setTerminalLines((prev) => [
        ...prev,
        {
          kind: "output",
          output: data.output ?? data.error ?? "No output returned.",
        },
      ]);
    } catch (err) {
      setTerminalLines((prev) => [
        ...prev,
        { kind: "output", output: `Network error — ${err.message}` },
      ]);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="app">
      <TopBar
        onRun={handleRun}
        isRunning={isRunning}
        language={language}
        onLanguageChange={setLanguage}
        onSubmit={handleSubmit}
        isSubmitted={sessionStatus === "SUBMITTED"}
      />
      <div className="workspace">
        <Sidebar />
        <div className="main-content">
          <EditorPane
            code={code}
            language={language}
            onChange={setCode}
            onCursorChange={(line, col) => setCursor({ line, col })}
            onFlush={handleFlush}
            isSubmitted={sessionStatus === "SUBMITTED"}
            studentId={STUDENT_ID}
            sessionIdRef={sessionIdRef}
            labMode={LAB_MODE}
          />
          <Terminal lines={terminalLines} />
        </div>
      </div>
      <StatusBar language={language} line={cursor.line} col={cursor.col} />
    </div>
  );
}

export default App;
